import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { applyMigrations, type SqlMigration } from "../src/database/migrations.ts";
import { TursoDatabaseAdapter } from "../src/database/turso.ts";
import {
  SePayApiV2Client,
  SePayApiV2Error,
  type SePayApiV2Transaction,
} from "../src/payments/sepay-api-v2.ts";
import { runSePayApiV2Scan } from "../src/payments/sepay-reconciliation.ts";
import {
  evaluateSePayApiV2Observation,
  type ReconciliationPaymentCandidate,
} from "../src/payments/sepay-reconciliation-policy.ts";

const API_BASE_URL = "https://userapi-sandbox.sepay.vn/v2";
const API_TOKEN = "x".repeat(64);
const BANK_ACCOUNT_ID = "f9e8d7c6-b5a4-3210-fedc-ba0987654321";
const PAYMENT_REFERENCE = "CRP1234567890ABCDEF";

function transaction(overrides: Partial<SePayApiV2Transaction> = {}): SePayApiV2Transaction {
  return {
    id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    bankAccountId: BANK_ACCOUNT_ID,
    transactionDate: "2026-01-01T10:00:00+07:00",
    transferType: "in",
    amountIn: 50_000,
    amountOut: 0,
    referenceNumber: "FT26069ABC",
    code: PAYMENT_REFERENCE,
    webhookSuccess: 1,
    ...overrides,
  };
}

function apiTransaction(value: SePayApiV2Transaction): Record<string, unknown> {
  return {
    id: value.id,
    bank_account_id: value.bankAccountId,
    transaction_date: value.transactionDate,
    transfer_type: value.transferType,
    amount_in: value.amountIn,
    amount_out: value.amountOut,
    reference_number: value.referenceNumber,
    code: value.code,
    webhook_success: value.webhookSuccess,
  };
}

function response(
  data: unknown[],
  page = 1,
  lastPage = 1,
  hasMore = false,
  status = 200,
  headers?: HeadersInit,
  perPage = 1,
  total = lastPage === 0 ? 0 : (lastPage - 1) * perPage + data.length,
): Response {
  return new Response(JSON.stringify({
    status: "success",
    data,
    meta: {
      pagination: {
        total,
        per_page: perPage,
        current_page: page,
        last_page: lastPage,
        has_more: hasMore,
      },
    },
  }), { status, headers });
}

function createApiClient(
  fetchImpl: typeof fetch,
  options: Partial<ConstructorParameters<typeof SePayApiV2Client>[0]> = {},
): SePayApiV2Client {
  return new SePayApiV2Client({
    baseUrl: API_BASE_URL,
    apiToken: API_TOKEN,
    fetch: fetchImpl,
    minimumRequestIntervalMs: 0,
    sleep: async () => {},
    ...options,
  });
}

const scanSinceStart = {
  mode: "SINCE_ID" as const,
  sinceId: "11111111-1111-4111-8111-111111111111",
  bankAccountId: BANK_ACCOUNT_ID,
  perPage: 1,
};

describe("SePay API v2 client", () => {
  it("fetches every documented page and requests only sanitized fields", async () => {
    const calls: Array<{ url: URL; authorization: string | null }> = [];
    const client = createApiClient(async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
      return url.searchParams.get("page") === "1"
        ? response([apiTransaction(transaction())], 1, 2, true)
        : response([apiTransaction(transaction({
          id: "b2c3d4e5-f678-4123-8123-456789abcdef",
          transactionDate: "2026-01-01T10:01:00+07:00",
        }))], 2, 2, false);
    });

    const result = await client.listTransactions(scanSinceStart);
    assert.equal(result.pages, 2);
    assert.equal(result.transactions.length, 2);
    assert.deepEqual(calls.map(({ url }) => url.searchParams.get("page")), ["1", "2"]);
    assert.ok(calls.every(({ url }) => url.searchParams.get("since_id") === scanSinceStart.sinceId));
    assert.ok(calls.every(({ url }) =>
      url.searchParams.get("transaction_date_sort") === "asc" &&
      url.searchParams.get("timestamp_format") === "iso8601" &&
      !url.searchParams.has("q") &&
      !url.searchParams.has("transaction_content")
    ));
    assert.ok(calls.every(({ authorization }) => authorization === `Bearer ${API_TOKEN}`));
  });

  it("accepts empty result sets and deduplicates identical transaction UUIDs", async () => {
    const empty = await createApiClient(async () => response([], 1, 0, false))
      .listTransactions(scanSinceStart);
    assert.deepEqual(empty, {
      transactions: [],
      pages: 1,
      complete: true,
      continuationPage: null,
    });

    const first = transaction();
    const second = transaction({
      id: "b2c3d4e5-f678-4123-8123-456789abcdef",
      transactionDate: "2026-01-01T10:01:00+07:00",
    });
    const third = transaction({
      id: "c3d4e5f6-7890-4234-8234-56789abcdef0",
      transactionDate: "2026-01-01T10:02:00+07:00",
    });
    const deduplicated = await createApiClient(async (input) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      return page === 1
        ? response(
          [apiTransaction(first), apiTransaction(second)],
          1,
          2,
          true,
          200,
          undefined,
          2,
          4,
        )
        : response(
          [apiTransaction(second), apiTransaction(third)],
          2,
          2,
          false,
          200,
          undefined,
          2,
          4,
        );
    }).listTransactions({ ...scanSinceStart, perPage: 2 });
    assert.equal(deduplicated.transactions.length, 3);
    assert.equal(deduplicated.complete, true);
  });

  it("rejects repeated pages and inconsistent pagination metadata", async () => {
    const repeated = transaction();
    await assert.rejects(
      createApiClient(async (input) => {
        const page = Number(new URL(String(input)).searchParams.get("page"));
        return response([apiTransaction(repeated)], page, 2, page === 1);
      }).listTransactions(scanSinceStart),
      (error: unknown) => error instanceof SePayApiV2Error &&
        error.code === "PAGINATION_INCONSISTENT",
    );
    await assert.rejects(
      createApiClient(async () =>
        response([apiTransaction(repeated)], 1, 1, false, 200, undefined, 1, 2))
        .listTransactions(scanSinceStart),
      (error: unknown) => error instanceof SePayApiV2Error &&
        error.code === "PAGINATION_INCONSISTENT",
    );
  });

  it("rejects transactions that contradict the requested ascending order", async () => {
    const first = transaction({
      transactionDate: "2026-01-01T10:01:00+07:00",
    });
    const earlier = transaction({
      id: "b2c3d4e5-f678-4123-8123-456789abcdef",
      transactionDate: "2026-01-01T10:00:00+07:00",
    });
    await assert.rejects(
      createApiClient(async (input) => {
        const page = Number(new URL(String(input)).searchParams.get("page"));
        return response([apiTransaction(page === 1 ? first : earlier)], page, 2, page === 1);
      }).listTransactions(scanSinceStart),
      (error: unknown) => error instanceof SePayApiV2Error &&
        error.code === "PAGINATION_INCONSISTENT",
    );
  });

  it("continues pagination when new transactions extend the result during a scan", async () => {
    const calls: number[] = [];
    const records = [
      transaction(),
      transaction({
        id: "b2c3d4e5-f678-4123-8123-456789abcdef",
        transactionDate: "2026-01-01T10:01:00+07:00",
      }),
      transaction({
        id: "c3d4e5f6-7890-4234-8234-56789abcdef0",
        transactionDate: "2026-01-01T10:02:00+07:00",
      }),
    ];
    const result = await createApiClient(async (input) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      calls.push(page);
      return response(
        [apiTransaction(records[page - 1]!)],
        page,
        page === 1 ? 2 : 3,
        page < 3,
      );
    }).listTransactions(scanSinceStart);
    assert.deepEqual(calls, [1, 2, 3]);
    assert.deepEqual(result.transactions.map(({ id }) => id), records.map(({ id }) => id));
  });

  it("rejects malformed JSON, invalid envelopes, missing fields, and oversized bodies", async () => {
    await assert.rejects(
      createApiClient(async () => new Response("{")).listTransactions(scanSinceStart),
      (error: unknown) => error instanceof SePayApiV2Error && error.code === "INVALID_JSON",
    );
    await assert.rejects(
      createApiClient(async () => new Response(JSON.stringify({ status: "error", data: [] })))
        .listTransactions(scanSinceStart),
      (error: unknown) => error instanceof SePayApiV2Error && error.code === "INVALID_RESPONSE",
    );
    const missingField = apiTransaction(transaction());
    delete missingField.bank_account_id;
    await assert.rejects(
      createApiClient(async () => response([missingField]))
        .listTransactions(scanSinceStart),
      (error: unknown) => error instanceof SePayApiV2Error && error.code === "INVALID_RESPONSE",
    );
    await assert.rejects(
      createApiClient(async () => new Response("x".repeat(64)), { maxResponseBytes: 16 })
        .listTransactions(scanSinceStart),
      (error: unknown) => error instanceof SePayApiV2Error && error.code === "INVALID_RESPONSE",
    );
  });

  it("rejects unauthorized responses without exposing credentials or provider bodies", async () => {
    for (const status of [401, 403]) {
      await assert.rejects(
        createApiClient(async () =>
          new Response(`sensitive response ${API_TOKEN}`, { status }))
          .listTransactions(scanSinceStart),
        (error: unknown) => {
          assert.ok(error instanceof SePayApiV2Error);
          assert.equal(error.code, "HTTP_ERROR");
          assert.equal(error.status, status);
          assert.ok(!error.message.includes(API_TOKEN));
          assert.ok(!error.message.includes("sensitive response"));
          return true;
        },
      );
    }
  });

  it("rejects redirects without following them or forwarding credentials", async () => {
    for (const status of [301, 302, 307, 308]) {
      let requests = 0;
      const authorizations: string[] = [];
      const client = createApiClient(async (input, init) => {
        requests++;
        assert.equal(new URL(String(input)).origin, "https://userapi-sandbox.sepay.vn");
        assert.equal(init?.redirect, "error");
        authorizations.push(new Headers(init?.headers).get("Authorization") ?? "");
        return new Response(null, {
          status,
          headers: { Location: "https://attacker.example/collect" },
        });
      });

      await assert.rejects(
        client.listTransactions(scanSinceStart),
        (error: unknown) => {
          assert.ok(error instanceof SePayApiV2Error);
          assert.equal(error.code, "REDIRECT_REJECTED");
          assert.equal(error.status, status);
          assert.ok(!error.message.includes(API_TOKEN));
          assert.ok(!error.message.includes("attacker.example"));
          return true;
        },
      );
      assert.equal(requests, 1, `status ${status} must not cause a second request`);
      assert.deepEqual(authorizations, [`Bearer ${API_TOKEN}`]);
    }

    let rejectedRedirectRequests = 0;
    const fetchErrorClient = createApiClient(async (_input, init) => {
      rejectedRedirectRequests++;
      assert.equal(init?.redirect, "error");
      throw new TypeError("fetch failed: redirect mode is set to error");
    });
    await assert.rejects(
      fetchErrorClient.listTransactions(scanSinceStart),
      (error: unknown) => error instanceof SePayApiV2Error &&
        error.code === "REDIRECT_REJECTED",
    );
    assert.equal(rejectedRedirectRequests, 1);
  });

  it("honors Retry-After on HTTP 429", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const client = createApiClient(async () => {
      attempts++;
      return attempts === 1
        ? new Response("", { status: 429, headers: { "Retry-After": "2" } })
        : response([apiTransaction(transaction())]);
    }, { sleep: async (milliseconds) => { delays.push(milliseconds); } });

    const result = await client.listTransactions(scanSinceStart);
    assert.equal(result.transactions.length, 1);
    assert.equal(attempts, 2);
    assert.deepEqual(delays, [2000]);
  });

  it("bounds retries for transient server errors", async () => {
    let attempts = 0;
    const client = createApiClient(async () => {
      attempts++;
      return new Response("", { status: 503 });
    }, { maxRetries: 2 });
    await assert.rejects(
      client.listTransactions(scanSinceStart),
      (error: unknown) => error instanceof SePayApiV2Error &&
        error.code === "HTTP_ERROR" && error.status === 503,
    );
    assert.equal(attempts, 3);
  });

  it("aborts timed-out requests and refuses untrusted bearer-token hosts", async () => {
    const timeoutClient = createApiClient((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }), { timeoutMs: 5, maxRetries: 0 });
    await assert.rejects(
      timeoutClient.listTransactions(scanSinceStart),
      (error: unknown) => error instanceof SePayApiV2Error && error.code === "TIMEOUT",
    );
    const bodyTimeoutClient = createApiClient(async (_input, init) => new Response(
      new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            controller.error(error);
          }, { once: true });
        },
      }),
    ), { timeoutMs: 5, maxRetries: 0 });
    await assert.rejects(
      bodyTimeoutClient.listTransactions(scanSinceStart),
      (error: unknown) => error instanceof SePayApiV2Error && error.code === "TIMEOUT",
    );
    assert.throws(() => new SePayApiV2Client({
      baseUrl: "https://attacker.example/v2",
      apiToken: API_TOKEN,
    }), (error: unknown) => error instanceof SePayApiV2Error && error.code === "CONFIGURATION");
  });

  it("keeps the timeout through a nearly complete body and cancels slow error bodies", async () => {
    let responseSignal: AbortSignal | undefined;
    const bodyCompletesBeforeTimeout = createApiClient(async (_input, init) => {
      responseSignal = init?.signal;
      const body = JSON.stringify({
        status: "success",
        data: [],
        meta: { pagination: {
          total: 0,
          per_page: 1,
          current_page: 1,
          last_page: 0,
          has_more: false,
        } },
      });
      return new Response(new ReadableStream({
        start(controller) {
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          }, 60);
        },
      }));
    }, { timeoutMs: 80, maxRetries: 0 });

    assert.deepEqual(
      await bodyCompletesBeforeTimeout.listTransactions(scanSinceStart),
      {
        transactions: [],
        pages: 1,
        complete: true,
        continuationPage: null,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(responseSignal?.aborted, false, "completion clears the request timeout");

    let errorBodyCancelled = false;
    const slowErrorBodyClient = createApiClient(async () => new Response(
      new ReadableStream({
        cancel() {
          errorBodyCancelled = true;
        },
      }),
      { status: 503 },
    ), { maxRetries: 0 });
    await assert.rejects(
      slowErrorBodyClient.listTransactions(scanSinceStart),
      (error: unknown) => error instanceof SePayApiV2Error &&
        error.code === "HTTP_ERROR" && error.status === 503,
    );
    assert.equal(errorBodyCancelled, true, "error body is cancelled without waiting to consume it");
  });
});

describe("SePay API v2 exact-match policy", () => {
  const payment: ReconciliationPaymentCandidate = {
    paymentId: "payment-1",
    paymentReference: PAYMENT_REFERENCE,
    amountMinor: 50_000,
    currency: "VND",
    orderTotalMinor: 50_000,
    orderCurrency: "VND",
    orderType: "SELF_SERVICE",
    paymentStatus: "PENDING",
    orderStatus: "AWAITING_PAYMENT",
    paymentReviewRequired: false,
    orderReviewRequired: false,
    expiresAt: "2026-01-02T00:00:00.000Z",
    orderCreatedAt: "2025-12-31T00:00:00.000Z",
  };
  const context = {
    expectedBankAccountId: BANK_ACCOUNT_ID,
    referenceContract: { verified: true, field: "code" as const },
    verifiedCurrency: "VND",
    now: new Date("2026-01-01T00:00:00.000Z"),
  };

  it("returns an exact inbound candidate only with validated reference and currency facts", () => {
    assert.deepEqual(
      evaluateSePayApiV2Observation(transaction(), [payment], context),
      { status: "CANDIDATE", reasonCode: "EXACT_MATCH", paymentId: "payment-1" },
    );
    assert.deepEqual(
      evaluateSePayApiV2Observation(transaction({ webhookSuccess: 0 }), [payment], context),
      { status: "CANDIDATE", reasonCode: "EXACT_MATCH", paymentId: "payment-1" },
      "webhook_success is not treated as reconciliation proof",
    );
  });

  it("fails closed for unverified or non-exact references, direction, account, and amount", () => {
    assert.deepEqual(
      evaluateSePayApiV2Observation(transaction(), [payment], {
        ...context,
        referenceContract: { verified: false, field: null },
      }),
      { status: "UNMATCHED", reasonCode: "REFERENCE_MAPPING_UNVERIFIED" },
    );
    assert.equal(evaluateSePayApiV2Observation(
      transaction({ transferType: "out", amountIn: 0, amountOut: 50_000 }),
      [payment],
      context,
    ).reasonCode, "WRONG_TRANSFER_DIRECTION");
    assert.equal(evaluateSePayApiV2Observation(
      transaction({ bankAccountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      [payment],
      context,
    ).reasonCode, "BANK_ACCOUNT_MISMATCH");
    assert.equal(evaluateSePayApiV2Observation(
      transaction({ code: `${PAYMENT_REFERENCE} ` }),
      [payment],
      context,
    ).reasonCode, "NO_EXACT_REFERENCE_MATCH");
    assert.equal(evaluateSePayApiV2Observation(
      transaction({ amountIn: 49_999 }),
      [payment],
      context,
    ).reasonCode, "AMOUNT_MISMATCH");
    assert.equal(evaluateSePayApiV2Observation(
      transaction(),
      [{ ...payment, orderTotalMinor: 50_001 }],
      context,
    ).reasonCode, "ORDER_PAYMENT_AMOUNT_MISMATCH");
    assert.equal(evaluateSePayApiV2Observation(
      transaction(),
      [{ ...payment, orderType: "CUSTOM_BALANCE" }],
      context,
    ).reasonCode, "ORDER_TYPE_NOT_ELIGIBLE");
    assert.equal(evaluateSePayApiV2Observation(
      transaction(),
      [{ ...payment, orderCurrency: "USD" }],
      context,
    ).reasonCode, "ORDER_PAYMENT_CURRENCY_MISMATCH");
  });

  it("rejects ambiguous, historical, expired, paid, cancelled, and review-required candidates", () => {
    assert.deepEqual(evaluateSePayApiV2Observation(
      transaction(),
      [payment, { ...payment, paymentId: "payment-2" }],
      context,
    ), { status: "AMBIGUOUS", reasonCode: "MULTIPLE_EXACT_MATCHES" });
    assert.equal(evaluateSePayApiV2Observation(
      transaction({ transactionDate: "2025-12-30T00:00:00+07:00" }),
      [payment],
      context,
    ).reasonCode, "HISTORICAL_TRANSACTION");
    assert.equal(evaluateSePayApiV2Observation(
      transaction(),
      [{ ...payment, expiresAt: "2025-12-31T00:00:00.000Z" }],
      context,
    ).reasonCode, "ORDER_EXPIRED");
    for (const candidate of [
      { ...payment, paymentStatus: "SUCCEEDED" },
      { ...payment, orderStatus: "CANCELLED" },
      { ...payment, paymentReviewRequired: true },
      { ...payment, orderReviewRequired: true },
    ]) {
      assert.equal(evaluateSePayApiV2Observation(transaction(), [candidate], context).status,
        "MANUAL_REVIEW");
    }
    assert.equal(evaluateSePayApiV2Observation(
      transaction(),
      [payment],
      { ...context, verifiedCurrency: null },
    ).reasonCode, "CURRENCY_UNVERIFIED");
    assert.equal(evaluateSePayApiV2Observation(
      transaction(),
      [payment],
      { ...context, observedPaymentId: "payment-elsewhere" },
    ).reasonCode, "TRANSACTION_OWNERSHIP_CONFLICT");
  });
});

async function loadMigrations(): Promise<SqlMigration[]> {
  const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
  const files = (await readdir(directory))
    .filter((file) => file.toLowerCase().endsWith(".sql"))
    .sort();
  return Promise.all(files.map(async (file) => {
    const match = file.match(/^(\d{4})_([a-z0-9_-]+)\.sql$/i);
    if (!match) throw new Error(`Invalid migration filename: ${file}`);
    return {
      version: Number(match[1]),
      name: match[2],
      sql: await readFile(join(directory, file), "utf8"),
    };
  }));
}

describe("SePay API v2 observation persistence", () => {
  it("persists pages idempotently and advances its cursor only after every page", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    try {
      const migrations = await loadMigrations();
      assert.deepEqual(await applyMigrations(client, migrations),
        migrations.map((migration) => migration.version));
      const database = new TursoDatabaseAdapter(client);
      const first = transaction();
      const second = transaction({
        id: "b2c3d4e5-f678-4123-8123-456789abcdef",
        transactionDate: "2026-01-01T10:01:00+07:00",
      });
      let failedPageCalls = 0;
      const failingClient = createApiClient(async (input) => {
        const page = Number(new URL(String(input)).searchParams.get("page"));
        failedPageCalls++;
        if (page === 2) return new Response("", { status: 503 });
        return response([apiTransaction(first)], 1, 2, true);
      }, { maxRetries: 0 });
      const scanOptions = {
        scanKey: `sandbox:${BANK_ACCOUNT_ID}`,
        mode: "DATE_WINDOW" as const,
        bankAccountId: BANK_ACCOUNT_ID,
        dateWindow: {
          initialFrom: new Date("2026-01-01T00:00:00.000Z"),
          scanThrough: new Date("2026-01-02T00:00:00.000Z"),
          overlapMs: 24 * 60 * 60_000,
        },
        perPage: 1,
        now: () => new Date("2026-01-03T00:00:00.000Z"),
      };

      await assert.rejects(
        runSePayApiV2Scan(database, failingClient, scanOptions),
        (error: unknown) => error instanceof SePayApiV2Error &&
          error.code === "HTTP_ERROR" && error.status === 503,
      );
      assert.equal(failedPageCalls, 2);
      const failedCursor = await database.prepare(
        `SELECT window_end, scan_completed_at, lease_token,
                pending_window_start, pending_window_end, pending_next_page,
                pending_complete
         FROM sepay_api_reconciliation_cursors WHERE scan_key = ?`,
      ).bind(scanOptions.scanKey).first<Record<string, unknown>>();
      assert.deepEqual(failedCursor, {
        window_end: null,
        scan_completed_at: null,
        lease_token: null,
        pending_window_start: "2026-01-01T00:00:00.000Z",
        pending_window_end: "2026-01-02T00:00:00.000Z",
        pending_next_page: 2,
        pending_complete: 0,
      });
      assert.equal((await database.prepare(
        "SELECT COUNT(*) AS count FROM sepay_api_observations",
      ).first<{ count: number }>())?.count, 1);

      const pageQueries: URL[] = [];
      const successfulClient = createApiClient(async (input) => {
        const url = new URL(String(input));
        pageQueries.push(url);
        const page = Number(url.searchParams.get("page"));
        assert.equal(page, 2, "a retry resumes at the first page not durably persisted");
        return response([apiTransaction(second)], 2, 2, false);
      });
      const completed = await runSePayApiV2Scan(database, successfulClient, scanOptions);
      assert.equal(completed.status, "completed");
      assert.equal(completed.pages, 1);
      assert.equal(completed.observations, 1);
      assert.equal(completed.lastTransactionId, second.id);
      const cursor = await database.prepare(
        `SELECT window_start, window_end, scan_completed_at, lease_token
         FROM sepay_api_reconciliation_cursors WHERE scan_key = ?`,
      ).bind(scanOptions.scanKey).first<Record<string, unknown>>();
      assert.deepEqual(cursor, {
        window_start: "2026-01-01T00:00:00.000Z",
        window_end: "2026-01-02T00:00:00.000Z",
        scan_completed_at: "2026-01-03T00:00:00.000Z",
        lease_token: null,
      });
      assert.ok(pageQueries.every((url) =>
        url.searchParams.get("page") === "2" &&
        url.searchParams.get("transaction_date_from") === "2026-01-01 07:00:00" &&
        url.searchParams.get("transaction_date_to") === "2026-01-02 07:00:00"
      ));

      const changed = transaction({ amountIn: 51_000 });
      const late = transaction({
        id: "c3d4e5f6-7890-4234-8234-56789abcdef0",
        transactionDate: "2026-01-01T10:02:00+07:00",
      });
      const rescanQueries: URL[] = [];
      const rescanClient = createApiClient(async (input) => {
        const url = new URL(String(input));
        rescanQueries.push(url);
        const page = Number(url.searchParams.get("page"));
        return page === 1
          ? response([apiTransaction(changed)], 1, 2, true)
          : response([apiTransaction(late)], 2, 2, false);
      });
      const rescan = await runSePayApiV2Scan(database, rescanClient, {
        ...scanOptions,
        dateWindow: {
          ...scanOptions.dateWindow,
          scanThrough: new Date("2026-01-02T00:00:00.000Z"),
        },
      });
      assert.equal(rescan.status, "completed");
      assert.ok(rescanQueries.every((url) =>
        url.searchParams.get("transaction_date_from") === "2026-01-01 07:00:00"
      ), "the completed date window is rescanned with its configured overlap");
      assert.ok(await database.prepare(
        "SELECT transaction_uuid FROM sepay_api_observations WHERE transaction_uuid = ?",
      ).bind(late.id).first());
      const originalObservation = await database.prepare(
        `SELECT amount_in, status, reason_code, payment_id
         FROM sepay_api_observations WHERE transaction_uuid = ?`,
      ).bind(first.id).first<Record<string, unknown>>();
      assert.deepEqual(originalObservation, {
        amount_in: 50_000,
        status: "MANUAL_REVIEW",
        reason_code: "TRANSACTION_DATA_CHANGED",
        payment_id: null,
      });
      assert.equal((await database.prepare(
        "SELECT COUNT(*) AS count FROM payment_settlement_evidence",
      ).first<{ count: number }>())?.count, 0);
    } finally {
      client.close();
    }
  });

  it("continues a 401-record date window across bounded runs without advancing early", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    try {
      const migrations = await loadMigrations();
      await applyMigrations(client, migrations);
      const database = new TursoDatabaseAdapter(client);
      const transactions = Array.from({ length: 401 }, (_, index) => transaction({
        id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
        transactionDate: new Date(Date.parse("2026-01-01T10:00:00.000Z") + index * 1000)
          .toISOString(),
      }));
      const requestedPages: number[] = [];
      const createClientForPages = () => createApiClient(async (input) => {
        const url = new URL(String(input));
        const page = Number(url.searchParams.get("page"));
        requestedPages.push(page);
        const lastPage = Math.ceil(transactions.length / 100);
        const records = transactions.slice((page - 1) * 100, page * 100);
        return response(
          records.map(apiTransaction),
          page,
          lastPage,
          page < lastPage,
          200,
          undefined,
          100,
          transactions.length,
        );
      });
      const scanOptions = {
        scanKey: `dense:${BANK_ACCOUNT_ID}`,
        mode: "DATE_WINDOW" as const,
        bankAccountId: BANK_ACCOUNT_ID,
        dateWindow: {
          initialFrom: new Date("2026-01-01T00:00:00.000Z"),
          scanThrough: new Date("2026-01-02T00:00:00.000Z"),
        },
        perPage: 100,
        maxPages: 4,
        now: () => new Date("2026-01-03T00:00:00.000Z"),
      };

      const partial = await runSePayApiV2Scan(
        database,
        createClientForPages(),
        scanOptions,
      );
      assert.equal(partial.status, "partial");
      assert.equal(partial.pages, 4);
      assert.equal(partial.observations, 400);
      assert.equal(partial.continuationPage, 5);
      assert.equal(partial.remainingPages, 1);
      const partialCursor = await database.prepare(
        `SELECT window_end, pending_window_start, pending_window_end,
                pending_next_page, pending_last_transaction_id,
                pending_last_page, pending_total_records, pending_complete
         FROM sepay_api_reconciliation_cursors WHERE scan_key = ?`,
      ).bind(scanOptions.scanKey).first<Record<string, unknown>>();
      assert.deepEqual(partialCursor, {
        window_end: null,
        pending_window_start: "2026-01-01T00:00:00.000Z",
        pending_window_end: "2026-01-02T00:00:00.000Z",
        pending_next_page: 5,
        pending_last_transaction_id: transactions[399]!.id,
        pending_last_page: 5,
        pending_total_records: 401,
        pending_complete: 0,
      });

      const completed = await runSePayApiV2Scan(
        database,
        createClientForPages(),
        scanOptions,
      );
      assert.equal(completed.status, "completed");
      assert.equal(completed.pages, 1);
      assert.equal(completed.observations, 1);
      assert.equal(completed.lastTransactionId, transactions[400]!.id);
      assert.deepEqual(requestedPages, [1, 2, 3, 4, 5]);
      assert.equal((await database.prepare(
        "SELECT COUNT(*) AS count FROM sepay_api_observations",
      ).first<{ count: number }>())?.count, 401);
      assert.equal((await database.prepare(
        "SELECT COUNT(*) AS count FROM payment_settlement_evidence",
      ).first<{ count: number }>())?.count, 0);
      const completedCursor = await database.prepare(
        `SELECT window_end, pending_window_start, pending_next_page, pending_complete
         FROM sepay_api_reconciliation_cursors WHERE scan_key = ?`,
      ).bind(scanOptions.scanKey).first<Record<string, unknown>>();
      assert.deepEqual(completedCursor, {
        window_end: "2026-01-02T00:00:00.000Z",
        pending_window_start: null,
        pending_next_page: 1,
        pending_complete: 0,
      });
    } finally {
      client.close();
    }
  });

  it("resumes SINCE_ID scans independently and commits their cursor only at completion", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    try {
      const migrations = await loadMigrations();
      await applyMigrations(client, migrations);
      const database = new TursoDatabaseAdapter(client);
      const anchor = "11111111-1111-4111-8111-111111111111";
      const first = transaction();
      const second = transaction({
        id: "b2c3d4e5-f678-4123-8123-456789abcdef",
        transactionDate: "2026-01-01T10:01:00+07:00",
      });
      const requestedPages: number[] = [];
      const scan = (record: SePayApiV2Transaction, page: number, hasMore: boolean) =>
        createApiClient(async (input) => {
          const url = new URL(String(input));
          requestedPages.push(Number(url.searchParams.get("page")));
          assert.equal(url.searchParams.get("since_id"), anchor);
          return response([apiTransaction(record)], page, 2, hasMore);
        });
      const options = {
        scanKey: `since:${BANK_ACCOUNT_ID}`,
        mode: "SINCE_ID" as const,
        bankAccountId: BANK_ACCOUNT_ID,
        initialSinceId: anchor,
        perPage: 1,
        maxPages: 1,
      };

      const partial = await runSePayApiV2Scan(database, scan(first, 1, true), options);
      assert.equal(partial.status, "partial");
      const partialCursor = await database.prepare(
        `SELECT cursor_transaction_id, pending_since_id, pending_next_page
         FROM sepay_api_reconciliation_cursors WHERE scan_key = ?`,
      ).bind(options.scanKey).first<Record<string, unknown>>();
      assert.deepEqual(partialCursor, {
        cursor_transaction_id: null,
        pending_since_id: anchor,
        pending_next_page: 2,
      });

      const completed = await runSePayApiV2Scan(database, scan(second, 2, false), options);
      assert.equal(completed.status, "completed");
      assert.equal(completed.lastTransactionId, second.id);
      assert.deepEqual(requestedPages, [1, 2]);
      const cursor = await database.prepare(
        `SELECT cursor_transaction_id, pending_since_id, pending_next_page
         FROM sepay_api_reconciliation_cursors WHERE scan_key = ?`,
      ).bind(options.scanKey).first<Record<string, unknown>>();
      assert.deepEqual(cursor, {
        cursor_transaction_id: second.id,
        pending_since_id: null,
        pending_next_page: 1,
      });
    } finally {
      client.close();
    }
  });

  it("prevents persisted API transaction ownership from being reassigned", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    try {
      const migrations = await loadMigrations();
      await applyMigrations(client, migrations);
      const database = new TursoDatabaseAdapter(client);
      const timestamp = "2026-01-01T00:00:00.000Z";
      await database.prepare(
        `INSERT INTO customers (
           id, email, email_normalized, status, created_at, updated_at
         ) VALUES ('recon-owner', 'owner@example.test', 'owner@example.test',
           'ACTIVE', ?, ?)`,
      ).bind(timestamp, timestamp).run();
      for (const suffix of ["one", "two"]) {
        await database.prepare(
          `INSERT INTO orders (
             id, customer_id, order_type, status, currency, subtotal_minor, discount_minor,
             total_minor, idempotency_key, created_at, updated_at, order_reference,
             payment_review_required
           ) VALUES (?, 'recon-owner', 'SELF_SERVICE', 'AWAITING_PAYMENT', 'VND',
             50000, 0, 50000, ?, ?, ?, ?, 0)`,
        ).bind(`order-${suffix}`, `idem-${suffix}`, timestamp, timestamp, `ref-${suffix}`).run();
        await database.prepare(
          `INSERT INTO payments (
             id, order_id, provider, status, amount_minor, currency, idempotency_key,
             created_at, updated_at, payment_reference, review_required
           ) VALUES (?, ?, 'SEPAY', 'PENDING', 50000, 'VND', ?, ?, ?, ?, 0)`,
        ).bind(
          `payment-${suffix}`, `order-${suffix}`, `payment-idem-${suffix}`,
          timestamp, timestamp, `payment-ref-${suffix}`,
        ).run();
      }
      const observationId = transaction().id;
      await database.prepare(
        `INSERT INTO sepay_api_observations (
           transaction_uuid, bank_account_id, transaction_date, transfer_type,
           amount_in, amount_out, payload_hash, scan_type, status, reason_code,
           payment_id, first_observed_at, last_observed_at
         ) VALUES (?, ?, ?, 'in', 50000, 0, ?, 'SINCE_ID', 'CANDIDATE',
           'EXACT_MATCH', 'payment-one', ?, ?)`,
      ).bind(
        observationId,
        BANK_ACCOUNT_ID,
        transaction().transactionDate,
        "a".repeat(64),
        timestamp,
        timestamp,
      ).run();
      await assert.rejects(database.prepare(
        `UPDATE sepay_api_observations SET payment_id = 'payment-two'
         WHERE transaction_uuid = ?`,
      ).bind(observationId).run());
      await assert.rejects(database.prepare(
        `UPDATE sepay_api_observations SET payment_id = NULL
         WHERE transaction_uuid = ?`,
      ).bind(observationId).run());
      await assert.rejects(database.prepare(
        `UPDATE sepay_api_observations SET transaction_uuid = ?
         WHERE transaction_uuid = ?`,
      ).bind("b2c3d4e5-f678-4123-8123-456789abcdef", observationId).run());
      assert.equal((await database.prepare(
        "SELECT payment_id FROM sepay_api_observations WHERE transaction_uuid = ?",
      ).bind(observationId).first<{ payment_id: string }>())?.payment_id, "payment-one");
    } finally {
      client.close();
    }
  });
});

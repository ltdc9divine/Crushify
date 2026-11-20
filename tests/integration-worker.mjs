import worker from "../src/index.ts";
import { D1DatabaseAdapter } from "../src/database/d1.ts";
import { handleFulfillmentForOrder, recoverPendingFulfillments } from "../src/publications.ts";
import { SePayApiV2Client, SePayApiV2Error } from "../src/payments/sepay-api-v2.ts";
import {
  runSePayApiV2Scan,
  SePayApiV2LeaseError,
} from "../src/payments/sepay-reconciliation.ts";
import { ImageNormalizationError } from "../src/image-normalizer.ts";
import { R2StorageAdapter } from "../src/storage/r2.ts";

const fulfillmentTestPath = "/api/__integration/fulfillment";
const databaseTestPath = "/api/__integration/database";
const sePayScanTestPath = "/api/__integration/sepay-scan";
const sePayLeaseContractPath = "/api/__integration/sepay-lease-contract";
const imageNormalizerPath = "/__crushify_test_image_normalizer";
const localImageNormalizerTimeoutMs = 10_000;
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];

export function localTestImageNormalizer(
  env,
  { fetchImpl = fetch, timeoutMs = localImageNormalizerTimeoutMs } = {},
) {
  const configuredUrl = env.LOCAL_TEST_IMAGE_NORMALIZER_URL;
  if (env.ENVIRONMENT !== "local" ||
      env.LOCAL_TEST_MODE !== "true" ||
      typeof configuredUrl !== "string") {
    return undefined;
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Local image normalizer timeout must be a positive integer");
  }

  const endpoint = new URL(configuredUrl);
  if (endpoint.protocol !== "http:" ||
      endpoint.hostname !== "127.0.0.1" ||
      !endpoint.port ||
      endpoint.pathname !== imageNormalizerPath ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash) {
    throw new Error("Local image normalizer URL must use the isolated loopback test endpoint");
  }

  return async (bytes, contentType) => {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: bytes,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      let code;
      try {
        code = (await response.json()).code;
      } catch {
        throw new Error(`Local image normalizer returned ${response.status}`);
      }
      if (code === "IMAGE_TOO_LARGE") {
        throw new ImageNormalizationError("IMAGE_TOO_LARGE");
      }
      if (code === "INVALID_IMAGE") {
        throw new ImageNormalizationError("INVALID_IMAGE");
      }
      throw new Error(`Local image normalizer returned ${response.status}`);
    }

    const width = Number(response.headers.get("x-image-width"));
    const height = Number(response.headers.get("x-image-height"));
    const normalizedContentType = response.headers.get("content-type");
    if (normalizedContentType !== contentType ||
        !Number.isSafeInteger(width) || width < 1 ||
        !Number.isSafeInteger(height) || height < 1) {
      throw new ImageNormalizationError("INVALID_IMAGE");
    }
    const normalizedBytes = new Uint8Array(await response.arrayBuffer());
    const hasExpectedSignature = contentType === "image/png"
      ? normalizedBytes.length >= 8 &&
        normalizedBytes.subarray(0, 8).every((byte, index) =>
          byte === pngSignature[index])
      : normalizedBytes.length >= 3 &&
        normalizedBytes[0] === 0xff &&
        normalizedBytes[1] === 0xd8 &&
        normalizedBytes[2] === 0xff;
    if (!hasExpectedSignature) {
      throw new ImageNormalizationError("INVALID_IMAGE");
    }
    return {
      bytes: normalizedBytes,
      contentType,
      width,
      height,
    };
  };
}

function sePayTransaction(id, amountIn = 50_000) {
  return {
    id,
    bank_account_id: "f9e8d7c6-b5a4-3210-fedc-ba0987654321",
    transaction_date: "2026-01-01T10:00:00+07:00",
    transfer_type: "in",
    amount_in: amountIn,
    amount_out: 0,
    reference_number: "synthetic-reference",
    code: null,
    webhook_success: null,
  };
}

function sePayClient(fetch) {
  return new SePayApiV2Client({
    baseUrl: "https://userapi-sandbox.sepay.vn/v2",
    apiToken: "x".repeat(64),
    maxRetries: 0,
    minimumRequestIntervalMs: 0,
    fetch,
  });
}

function scanOptions(scanKey, overrides = {}) {
  return {
    scanKey,
    mode: "DATE_WINDOW",
    bankAccountId: "f9e8d7c6-b5a4-3210-fedc-ba0987654321",
    dateWindow: {
      initialFrom: new Date("2026-01-01T00:00:00.000Z"),
      scanThrough: new Date("2026-01-02T00:00:00.000Z"),
    },
    perPage: 1,
    leaseMs: 120_000,
    ...overrides,
  };
}

function pageResponse(transactions, page = 1) {
  return Response.json({
    status: "success",
    data: transactions,
    meta: {
      pagination: {
        total: transactions.length,
        per_page: 1,
        current_page: page,
        last_page: transactions.length ? page : 0,
        has_more: false,
      },
    },
  });
}

async function runSePayLeaseContract(database) {
  const outcomes = {};
  const gatedFetch = (transaction, started, gate) => sePayClient(async () => {
    started();
    await gate;
    return pageResponse([transaction]);
  });

  const concurrentKey = "d1-contract-sepay-lease-concurrent";
  let signalFirstFetch;
  const firstFetchStarted = new Promise((resolve) => { signalFirstFetch = resolve; });
  let releaseFirstFetch;
  const firstGate = new Promise((resolve) => { releaseFirstFetch = resolve; });
  const firstScan = runSePayApiV2Scan(
    database,
    gatedFetch(sePayTransaction("a1111111-1111-4111-8111-111111111111"), signalFirstFetch, firstGate),
    scanOptions(concurrentKey),
  );
  await firstFetchStarted;
  try {
    await runSePayApiV2Scan(
      database,
      sePayClient(async () => pageResponse([
        sePayTransaction("a2222222-2222-4222-8222-222222222222"),
      ])),
      scanOptions(concurrentKey),
    );
    outcomes.concurrentLeaseExclusive = false;
  } catch (error) {
    outcomes.concurrentLeaseExclusive =
      error instanceof SePayApiV2LeaseError && error.code === "LEASE_HELD";
  } finally {
    releaseFirstFetch();
    await firstScan;
  }

  const staleKey = "d1-contract-sepay-lease-stale";
  let signalStaleFetch;
  const staleFetchStarted = new Promise((resolve) => { signalStaleFetch = resolve; });
  let releaseStaleFetch;
  const staleGate = new Promise((resolve) => { releaseStaleFetch = resolve; });
  const staleScan = runSePayApiV2Scan(
    database,
    gatedFetch(sePayTransaction("b1111111-1111-4111-8111-111111111111"), signalStaleFetch, staleGate),
    scanOptions(staleKey),
  );
  await staleFetchStarted;
  await database.prepare(
    `UPDATE sepay_api_reconciliation_cursors
     SET lease_expires_at = '2000-01-01T00:00:00.000Z'
     WHERE scan_key = ? AND scan_mode = 'DATE_WINDOW'`,
  ).bind(staleKey).run();
  let signalReplacementFetch;
  const replacementFetchStarted = new Promise((resolve) => {
    signalReplacementFetch = resolve;
  });
  let releaseReplacementFetch;
  const replacementGate = new Promise((resolve) => { releaseReplacementFetch = resolve; });
  const replacementScan = runSePayApiV2Scan(
    database,
    gatedFetch(
      sePayTransaction("b2222222-2222-4222-8222-222222222222"),
      signalReplacementFetch,
      replacementGate,
    ),
    scanOptions(staleKey),
  );
  await replacementFetchStarted;
  releaseStaleFetch();
  try {
    await staleScan;
    outcomes.staleWorkerRejected = false;
  } catch (error) {
    outcomes.staleWorkerRejected =
      error instanceof SePayApiV2LeaseError && error.code === "LEASE_LOST";
  }
  const replacementLease = await database.prepare(
    `SELECT lease_token FROM sepay_api_reconciliation_cursors
     WHERE scan_key = ? AND scan_mode = 'DATE_WINDOW'`,
  ).bind(staleKey).first();
  outcomes.staleWorkerCannotReleaseReplacementLease =
    typeof replacementLease?.lease_token === "string" &&
    replacementLease.lease_token.length > 0;
  outcomes.staleWorkerCannotPersistPage = (await database.prepare(
    `SELECT COUNT(*) AS count FROM sepay_api_observations
     WHERE transaction_uuid = 'b1111111-1111-4111-8111-111111111111'`,
  ).first()).count === 0;
  releaseReplacementFetch();
  await replacementScan;

  const advanceKey = "d1-contract-sepay-lease-advance";
  const advanceTransactionId = "f3333333-3333-4333-8333-333333333333";
  await database.prepare(
    `CREATE TRIGGER d1_sepay_replace_lease_after_observation
     AFTER INSERT ON sepay_api_observations
     WHEN NEW.transaction_uuid = '${advanceTransactionId}'
     BEGIN
       UPDATE sepay_api_reconciliation_cursors
       SET lease_token = 'replacement-worker',
           lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', julianday('now') + 1.0)
       WHERE scan_key = '${advanceKey}' AND scan_mode = 'DATE_WINDOW';
     END`,
  ).run();
  try {
    try {
      await runSePayApiV2Scan(
        database,
        sePayClient(async () => pageResponse([sePayTransaction(advanceTransactionId)])),
        scanOptions(advanceKey),
      );
      outcomes.staleWorkerCannotAdvanceCursor = false;
    } catch (error) {
      outcomes.staleWorkerCannotAdvanceCursor =
        error instanceof SePayApiV2LeaseError && error.code === "LEASE_LOST";
    }
    const fencedCursor = await database.prepare(
      `SELECT window_end, scan_completed_at, lease_token
       FROM sepay_api_reconciliation_cursors
       WHERE scan_key = ? AND scan_mode = 'DATE_WINDOW'`,
    ).bind(advanceKey).first();
    outcomes.cursorRemainsIncomplete =
      fencedCursor?.window_end === null &&
      fencedCursor?.scan_completed_at === null &&
      fencedCursor?.lease_token === "replacement-worker";
  } finally {
    await database.prepare(
      "DROP TRIGGER d1_sepay_replace_lease_after_observation",
    ).run();
  }
  await database.prepare(
    `UPDATE sepay_api_reconciliation_cursors
     SET lease_expires_at = '2000-01-01T00:00:00.000Z'
     WHERE scan_key = ? AND scan_mode = 'DATE_WINDOW'
       AND lease_token = 'replacement-worker'`,
  ).bind(advanceKey).run();
  let completionRecoveryRefetched = false;
  const recoveredCompletion = await runSePayApiV2Scan(
    database,
    sePayClient(async () => {
      completionRecoveryRefetched = true;
      throw new Error("completed page must not be fetched again");
    }),
    scanOptions(advanceKey),
  );
  outcomes.completedPageRecoversWithoutRefetch =
    recoveredCompletion.status === "completed" &&
    recoveredCompletion.pages === 0 &&
    !completionRecoveryRefetched;

  const modeKey = "d1-contract-sepay-modes";
  const dateModeTransaction = "d1111111-1111-4111-8111-111111111111";
  const sinceModeTransaction = "d2222222-2222-4222-8222-222222222222";
  const dateMode = runSePayApiV2Scan(
    database,
    sePayClient(async () => pageResponse([sePayTransaction(dateModeTransaction)])),
    scanOptions(modeKey),
  );
  const sinceMode = runSePayApiV2Scan(
    database,
    sePayClient(async () => pageResponse([sePayTransaction(sinceModeTransaction)])),
    scanOptions(modeKey, {
      mode: "SINCE_ID",
      dateWindow: undefined,
      initialSinceId: "11111111-1111-4111-8111-111111111111",
    }),
  );
  await Promise.all([dateMode, sinceMode]);
  outcomes.scanModesAreIndependent = (await database.prepare(
    `SELECT COUNT(*) AS count FROM sepay_api_reconciliation_cursors
     WHERE scan_key = ?`,
  ).bind(modeKey).first()).count === 2;

  const timestamp = new Date().toISOString();
  await database.prepare(
    `INSERT INTO customers (
       id, email, email_normalized, status, created_at, updated_at
     ) VALUES ('d1-sepay-owner', 'd1-sepay-owner@example.test',
       'd1-sepay-owner@example.test', 'ACTIVE', ?, ?)`,
  ).bind(timestamp, timestamp).run();
  for (const suffix of ["one", "two"]) {
    await database.prepare(
      `INSERT INTO orders (
         id, customer_id, order_type, status, currency, subtotal_minor, discount_minor,
         total_minor, idempotency_key, created_at, updated_at, order_reference,
         payment_review_required
       ) VALUES (?, 'd1-sepay-owner', 'SELF_SERVICE', 'AWAITING_PAYMENT', 'VND',
         50000, 0, 50000, ?, ?, ?, ?, 0)`,
    ).bind(
      `d1-sepay-order-${suffix}`,
      `d1-sepay-order-idem-${suffix}`,
      timestamp,
      timestamp,
      `d1-sepay-order-ref-${suffix}`,
    ).run();
    await database.prepare(
      `INSERT INTO payments (
         id, order_id, provider, status, amount_minor, currency, idempotency_key,
         created_at, updated_at, payment_reference, review_required
       ) VALUES (?, ?, 'SEPAY', 'PENDING', 50000, 'VND', ?, ?, ?, ?, 0)`,
    ).bind(
      `d1-sepay-payment-${suffix}`,
      `d1-sepay-order-${suffix}`,
      `d1-sepay-payment-idem-${suffix}`,
      timestamp,
      timestamp,
      `d1-sepay-payment-ref-${suffix}`,
    ).run();
  }
  const ownedTransactionId = "e1111111-1111-4111-8111-111111111111";
  await database.prepare(
    `INSERT INTO sepay_api_observations (
       transaction_uuid, bank_account_id, transaction_date, transfer_type,
       amount_in, amount_out, payload_hash, scan_type, status, reason_code,
       payment_id, first_observed_at, last_observed_at
     ) VALUES (?, 'f9e8d7c6-b5a4-3210-fedc-ba0987654321',
       '2026-01-01T10:00:00+07:00', 'in', 50000, 0, ?, 'DATE_WINDOW',
       'CANDIDATE', 'EXACT_MATCH', 'd1-sepay-payment-one', ?, ?)`,
  ).bind(ownedTransactionId, "a".repeat(64), timestamp, timestamp).run();
  await runSePayApiV2Scan(
    database,
    sePayClient(async () => pageResponse([sePayTransaction(ownedTransactionId, 50001)])),
    scanOptions("d1-contract-sepay-ownership"),
  );
  const ownership = await database.prepare(
    `SELECT payment_id, status, reason_code FROM sepay_api_observations
     WHERE transaction_uuid = ?`,
  ).bind(ownedTransactionId).first();
  let ownershipReassignmentRejected = false;
  try {
    await database.prepare(
      `UPDATE sepay_api_observations SET payment_id = 'd1-sepay-payment-two'
       WHERE transaction_uuid = ?`,
    ).bind(ownedTransactionId).run();
  } catch {
    ownershipReassignmentRejected = true;
  }
  outcomes.duplicateUuidCannotChangePaymentOwner =
    ownership?.payment_id === "d1-sepay-payment-one" &&
    ownership?.status === "MANUAL_REVIEW" &&
    ownership?.reason_code === "TRANSACTION_DATA_CHANGED" &&
    ownershipReassignmentRejected;
  return outcomes;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === databaseTestPath) {
      if (request.method !== "POST" ||
          env.ENVIRONMENT !== "local" ||
          env.LOCAL_TEST_MODE !== "true" ||
          env.DATABASE_PROVIDER !== "d1") {
        return new Response(null, { status: 404 });
      }

      const body = await request.json();
      if ((body.action !== "query" && body.action !== "run") ||
          typeof body.sql !== "string" ||
          body.sql.length === 0) {
        return Response.json({ error: "Invalid integration request" }, { status: 400 });
      }

      const statement = env.DB.prepare(body.sql);
      const result = body.action === "query"
        ? await statement.all()
        : await statement.run();
      return Response.json(result);
    }

    if (url.pathname === sePayLeaseContractPath) {
      if (request.method !== "POST" ||
          env.ENVIRONMENT !== "local" ||
          env.LOCAL_TEST_MODE !== "true" ||
          env.DATABASE_PROVIDER !== "d1") {
        return new Response(null, { status: 404 });
      }

      try {
        const outcomes = await runSePayLeaseContract(new D1DatabaseAdapter(env.DB));
        return Response.json(outcomes);
      } catch (error) {
        const detail = error instanceof SePayApiV2LeaseError || error instanceof SePayApiV2Error
          ? error.code
          : error instanceof Error ? error.name : "UNKNOWN_ERROR";
        return Response.json({ error: "INTEGRATION_LEASE_CONTRACT_FAILED", detail }, {
          status: 500,
        });
      }
    }

    if (url.pathname === sePayScanTestPath) {
      if (request.method !== "POST" ||
          env.ENVIRONMENT !== "local" ||
          env.LOCAL_TEST_MODE !== "true" ||
          env.DATABASE_PROVIDER !== "d1") {
        return new Response(null, { status: 404 });
      }

      const body = await request.json();
      if (typeof body.scan_key !== "string" ||
          typeof body.bank_account_id !== "string" ||
          !Array.isArray(body.transactions) ||
          !Number.isInteger(body.per_page) ||
          body.per_page < 1 ||
          body.per_page > 100 ||
          (body.max_pages !== undefined &&
            (!Number.isInteger(body.max_pages) || body.max_pages < 1 || body.max_pages > 1000)) ||
          (body.fail_page !== undefined && !Number.isInteger(body.fail_page))) {
        return Response.json({ error: "Invalid integration scan request" }, { status: 400 });
      }

      const apiClient = new SePayApiV2Client({
        baseUrl: "https://userapi-sandbox.sepay.vn/v2",
        apiToken: "x".repeat(64),
        maxRetries: 0,
        minimumRequestIntervalMs: 0,
        fetch: async (input) => {
          const apiUrl = new URL(String(input));
          const page = Number(apiUrl.searchParams.get("page"));
          if (page === body.fail_page) {
            return new Response("", { status: 503 });
          }
          const perPage = Number(apiUrl.searchParams.get("per_page"));
          const lastPage = Math.ceil(body.transactions.length / perPage);
          const data = body.transactions.slice((page - 1) * perPage, page * perPage);
          return Response.json({
            status: "success",
            data,
            meta: {
              pagination: {
                total: body.transactions.length,
                per_page: perPage,
                current_page: page,
                last_page: lastPage,
                has_more: page < lastPage,
              },
            },
          });
        },
      });
      const database = new D1DatabaseAdapter(env.DB);
      try {
        const result = await runSePayApiV2Scan(database, apiClient, {
          scanKey: body.scan_key,
          mode: "DATE_WINDOW",
          bankAccountId: body.bank_account_id,
          dateWindow: {
            initialFrom: new Date("2026-01-01T00:00:00.000Z"),
            scanThrough: new Date("2026-01-02T00:00:00.000Z"),
            overlapMs: 24 * 60 * 60_000,
          },
          perPage: body.per_page,
          maxPages: body.max_pages,
        });
        return Response.json(result, { status: result.status === "partial" ? 206 : 200 });
      } catch (error) {
        const code = error instanceof SePayApiV2Error
          ? error.code
          : "INTEGRATION_SCAN_FAILED";
        return Response.json({ error: code }, { status: 500 });
      }
    }

    if (url.pathname !== fulfillmentTestPath) {
      const imageNormalizer = localTestImageNormalizer(env);
      return worker.fetch(request, imageNormalizer
        ? { ...env, IMAGE_NORMALIZER: imageNormalizer }
        : env, ctx);
    }

    if (request.method !== "POST" ||
        env.ENVIRONMENT !== "local" ||
        env.LOCAL_TEST_MODE !== "true" ||
        env.DATABASE_PROVIDER !== "d1" ||
        !env.MEDIA) {
      return new Response(null, { status: 404 });
    }

    const body = await request.json();
    if ((body.action !== "fulfill" && body.action !== "recover") ||
        (body.action === "fulfill" && typeof body.order_id !== "string")) {
      return Response.json({ error: "Invalid integration request" }, { status: 400 });
    }

    const testEnv = {
      DB: new D1DatabaseAdapter(env.DB),
      STORAGE: new R2StorageAdapter(env.MEDIA),
      ENVIRONMENT: "local",
      LOCAL_TEST_MODE: "true",
      PAYMENT_MODE: "sepay-test",
    };
    const result = body.action === "fulfill"
      ? await handleFulfillmentForOrder(testEnv, body.order_id)
      : await recoverPendingFulfillments(testEnv, 100);
    return Response.json(result);
  },
};

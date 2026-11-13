import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { recoverPendingSePayWebhookEvents } from "../src/payments.ts";
import {
  createOrderReference,
  createPaymentReference,
  createSePayQrUrl,
  parseWebhookBody,
  sepayPaymentProvider,
  verifySePaySignature,
} from "../src/payments/sepay.ts";
import { handleApiRequest } from "../src/index.ts";
import { createVercelApiHandler, validateVercelEnvironment } from "../src/platform/vercel.ts";
import { resolvePaymentEnvironmentPolicy } from "../src/payments/policy.ts";
import { handleFulfillmentForOrder, recoverPendingFulfillments } from "../src/publications.ts";
import type { Database } from "../src/database.ts";

describe("SePay local-only payment safeguards", () => {
  it("verifies the raw-body HMAC and rejects tampering or stale timestamps", async () => {
    const secret = "test-only-random-secret";
    const timestamp = Math.floor(Date.now() / 1000);
    const body = new TextEncoder().encode('{"id":123,"amount":50000}');
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${new TextDecoder().decode(body)}`)
      .digest("hex");
    const headers = new Headers({
      "X-SePay-Timestamp": String(timestamp),
      "X-SePay-Signature": `sha256=${signature}`,
    });

    assert.equal(await verifySePaySignature(headers, body, secret), true);
    assert.equal(await verifySePaySignature(new Headers(), body, secret), false);
    assert.equal(await verifySePaySignature(
      new Headers({
        "X-SePay-Timestamp": String(timestamp),
        "X-SePay-Signature": `sha256=${"0".repeat(64)}`,
      }),
      body,
      secret,
    ), false);
    assert.equal(await verifySePaySignature(headers, new TextEncoder().encode("{}"), secret), false);
    assert.equal(await verifySePaySignature(
      new Headers({ ...Object.fromEntries(headers), "X-SePay-Timestamp": String(timestamp - 301) }),
      body,
      secret,
    ), false);
    assert.equal(await verifySePaySignature(
      new Headers({
        "X-SePay-Timestamp": String(timestamp + 301),
        "X-SePay-Signature": headers.get("X-SePay-Signature")!,
      }),
      body,
      secret,
    ), false);
  });

  it("records malformed payloads as reviewable events instead of treating them as payments", async () => {
    const parsed = await parseWebhookBody(new TextEncoder().encode("{"));
    assert.equal(parsed.transactionId, null);
    assert.match(parsed.reviewReason ?? "", /JSON/);
    assert.match(parsed.eventId, /^invalid-[a-f0-9]{64}$/);
    const invalidUtf8 = await parseWebhookBody(new Uint8Array([0xc3, 0x28]));
    assert.equal(invalidUtf8.transactionId, null);
    assert.match(invalidUtf8.reviewReason ?? "", /UTF-8/);
  });

  it("only generates a QR when valid sandbox bank settings are present", () => {
    assert.equal(createSePayQrUrl(undefined, undefined, 50_000, "CRF123"), null);
    const qr = createSePayQrUrl("mb", "1234567890", 50_000, "CRF A+B");
    assert.ok(qr);
    const url = new URL(qr);
    assert.equal(url.origin, "https://vietqr.app");
    assert.equal(url.searchParams.get("amount"), "50000");
    assert.equal(url.searchParams.get("des"), "CRF A+B");
    assert.equal(url.searchParams.get("acc"), "1234567890");
  });

  it("uses distinct random order and payment references", () => {
    const orderReference = createOrderReference();
    const paymentReference = createPaymentReference();
    assert.match(orderReference, /^CRF[A-F0-9]{16}$/);
    assert.match(paymentReference, /^CRP[A-F0-9]{16}$/);
    assert.notEqual(orderReference, paymentReference);
  });

  it("provides bank instructions only for SePay Test mode and normalizes its webhook", () => {
    const input = {
      mode: "sepay-test" as const,
      amountMinor: 50_000,
      reference: "CRP1234567890ABCDEF",
      bankCode: "mb",
      bankAccount: "1234567890",
      accountName: "Crushify Test",
    };
    const instructions = sepayPaymentProvider.createInstructions(input);
    assert.ok(instructions);
    assert.equal(instructions.bankCode, "MB");
    assert.equal(instructions.bankAccount, input.bankAccount);
    assert.equal(instructions.accountName, input.accountName);
    assert.equal(instructions.amountMinor, input.amountMinor);
    assert.equal(instructions.reference, input.reference);
    assert.equal(new URL(instructions.qrUrl).origin, "https://vietqr.app");
    assert.equal(sepayPaymentProvider.createInstructions({ ...input, mode: "mock" }), null);

    const transaction = sepayPaymentProvider.normalizeTransaction({
      id: 123,
      accountNumber: "1234567890",
      code: input.reference,
      transferType: "in",
      transferAmount: 50_000,
    });
    assert.deepEqual(transaction, {
      transactionId: "123",
      paymentReference: input.reference,
      receivingAccount: "1234567890",
      direction: "in",
      amountMinor: 50_000,
    });
    assert.equal(sepayPaymentProvider.mapStatus(transaction), "SUCCEEDED");
    assert.equal(sepayPaymentProvider.mapStatus({ ...transaction, direction: "out" }), "MANUAL_REVIEW");
  });

  it("selects mock only for Preview and disables unknown payment environments", () => {
    const production = resolvePaymentEnvironmentPolicy({ ENVIRONMENT: "production" });
    assert.equal(production.provider, "SEPAY");
    assert.equal(production.orderCreationEnabled, false);
    assert.equal(production.sepayWebhookEnabled, false);

    const preview = resolvePaymentEnvironmentPolicy({
      ENVIRONMENT: "staging",
      PAYMENT_MODE: "sepay-test",
    });
    assert.equal(preview.provider, "MOCK");
    assert.equal(preview.mode, "mock");
    assert.equal(preview.sepayWebhookEnabled, false);
    assert.equal(preview.fulfillmentEnabled, false);

    const localMock = resolvePaymentEnvironmentPolicy({
      ENVIRONMENT: "local",
      LOCAL_TEST_MODE: "true",
      PAYMENT_MODE: "mock",
    });
    assert.equal(localMock.mode, "mock");
    assert.equal(localMock.sepayWebhookEnabled, true);
    assert.equal(resolvePaymentEnvironmentPolicy({
      ENVIRONMENT: "local",
      LOCAL_TEST_MODE: "true",
      PAYMENT_MODE: "sepay-test",
    }).provider, "SEPAY");
    assert.equal(resolvePaymentEnvironmentPolicy({
      ENVIRONMENT: "local",
      PAYMENT_MODE: "sepay-test",
    }).provider, null);
    assert.equal(resolvePaymentEnvironmentPolicy({}).provider, null);
  });

  it("maps Vercel Preview to mock payments without opening checkout while Preview auth is disabled", async () => {
    let queries = 0;
    const unusedDatabase: Database = {
      prepare() {
        queries++;
        throw new Error("database must not be accessed");
      },
      async batch() {
        queries++;
        throw new Error("database must not be accessed");
      },
    };
    const previewEnvironment = {
      VERCEL_ENV: "preview",
      ENVIRONMENT: "staging",
      VERCEL_URL: "crushify-preview.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: "crushify.vercel.app",
      DATABASE_PROVIDER: "turso",
      TURSO_STAGING_DATABASE_URL: "libsql://crushify-staging-synthetic.turso.io",
      TURSO_STAGING_AUTH_TOKEN: "synthetic-staging-token",
      STORAGE_PROVIDER: "mock",
    };
    assert.equal(validateVercelEnvironment(previewEnvironment), null);
    assert.equal(validateVercelEnvironment({
      ...previewEnvironment,
      PAYMENT_MODE: "sepay-test",
    }), "RUNTIME_CONFIGURATION_ERROR");
    assert.equal(validateVercelEnvironment({
      ...previewEnvironment,
      SEPAY_WEBHOOK_SECRET: "synthetic-preview-secret",
    }), "RUNTIME_CONFIGURATION_ERROR");

    const handler = createVercelApiHandler(previewEnvironment, {
      async connectDatabase() {
        return { database: unusedDatabase, close() {} };
      },
    });
    const response = await handler(new Request(
      "https://crushify-preview.vercel.app/api/v1/orders",
      {
        method: "POST",
        headers: {
          Origin: "https://crushify-preview.vercel.app",
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    ));
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "AUTH_UNAVAILABLE");
    assert.equal(queries, 0);
  });

  it("rejects a correctly signed SePay webhook in Preview before verification or database access", async () => {
    let queries = 0;
    const unusedDatabase: Database = {
      prepare() {
        queries++;
        throw new Error("database must not be accessed");
      },
      async batch() {
        queries++;
        throw new Error("database must not be accessed");
      },
    };
    const secret = "synthetic-preview-webhook-secret";
    const timestamp = Math.floor(Date.now() / 1000);
    const rawBody = JSON.stringify({
      id: 123,
      accountNumber: "1234567890",
      code: "CRP1234567890ABCDEF",
      transferType: "in",
      transferAmount: 50_000,
    });
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");
    const response = await handleApiRequest(
      new Request("https://crushify.test/api/v1/payments/sepay/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-SePay-Timestamp": String(timestamp),
          "X-SePay-Signature": `sha256=${signature}`,
        },
        body: rawBody,
      }),
      {
        DB: unusedDatabase,
        ENVIRONMENT: "staging",
        PAYMENT_MODE: "sepay-test",
        SEPAY_WEBHOOK_SECRET: secret,
        SEPAY_BANK_ACCOUNT: "1234567890",
      },
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { error: { code: string } }).error.code,
      "MOCK_SETTLEMENT_UNAVAILABLE");
    assert.equal(queries, 0);
  });

  it("keeps Preview mock confirmation and fulfillment unavailable rather than treating mock state as SePay", async () => {
    let queries = 0;
    const unusedDatabase: Database = {
      prepare() {
        queries++;
        throw new Error("database must not be accessed");
      },
      async batch() {
        queries++;
        throw new Error("database must not be accessed");
      },
    };
    const env = { DB: unusedDatabase, ENVIRONMENT: "staging" as const, PAYMENT_MODE: "mock" as const };
    const confirmation = await handleApiRequest(
      new Request("https://crushify.test/api/v1/payments/mock/confirm", { method: "POST" }),
      env,
    );
    assert.equal(confirmation.status, 404);
    await assert.rejects(() => handleFulfillmentForOrder(env, crypto.randomUUID()),
      /fulfillment is disabled/);
    await assert.rejects(() => recoverPendingFulfillments(env),
      /fulfillment recovery is disabled/);
    await assert.rejects(() => recoverPendingSePayWebhookEvents(env),
      /SePay webhook recovery is disabled/);
    assert.equal(queries, 0);
  });

  it("disables order creation outside local test mode before touching the database", async () => {
    const unusedDatabase: Database = {
      prepare() {
        throw new Error("database must not be accessed");
      },
      async batch() {
        throw new Error("database must not be accessed");
      },
    };
    const response = await handleApiRequest(
      new Request("https://crushify.test/api/v1/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ design_id: crypto.randomUUID() }),
      }),
      {
        DB: unusedDatabase,
        ENVIRONMENT: "production",
        LOCAL_TEST_MODE: "true",
        PAYMENT_MODE: "mock",
        SEPAY_WEBHOOK_SECRET: "test-only-random-secret",
      },
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "PAYMENTS_DISABLED");
  });

  it("preserves local mock webhook signature verification", async () => {
    const unusedDatabase: Database = {
      prepare() {
        throw new Error("database must not be accessed");
      },
      async batch() {
        throw new Error("database must not be accessed");
      },
    };
    const env = {
      DB: unusedDatabase,
      ENVIRONMENT: "local" as const,
      LOCAL_TEST_MODE: "true",
      PAYMENT_MODE: "mock" as const,
      SEPAY_WEBHOOK_SECRET: "synthetic-local-webhook-secret",
    };

    const checkout = await handleApiRequest(
      new Request("https://crushify.test/api/v1/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      env,
    );
    assert.equal(checkout.status, 401);
    assert.equal((await checkout.json() as { error: { code: string } }).error.code, "UNAUTHENTICATED");

    for (const path of [
      "/api/v1/orders",
      `/api/v1/orders/${crypto.randomUUID()}/status`,
    ]) {
      const response = await handleApiRequest(new Request(`https://crushify.test${path}`), env);
      assert.equal(response.status, 401);
      assert.equal((await response.json() as { error: { code: string } }).error.code, "UNAUTHENTICATED");
    }

    const webhook = await handleApiRequest(
      new Request("https://crushify.test/api/v1/payments/sepay/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      env,
    );
    assert.equal(webhook.status, 401);
    assert.equal(
      (await webhook.json() as { error: { code: string } }).error.code,
      "INVALID_WEBHOOK_SIGNATURE",
    );
  });
});

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  createOrderReference,
  createPaymentReference,
  createSePayQrUrl,
  parseWebhookBody,
  sepayPaymentProvider,
  verifySePaySignature,
} from "../src/payments/sepay.ts";
import { handleApiRequest } from "../src/index.ts";
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
});

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { createSePayQrUrl, parseWebhookBody, verifySePaySignature } from "../src/payments/sepay.ts";
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
    assert.equal(await verifySePaySignature(headers, new TextEncoder().encode("{}"), secret), false);
    assert.equal(await verifySePaySignature(
      new Headers({ ...Object.fromEntries(headers), "X-SePay-Timestamp": String(timestamp - 301) }),
      body,
      secret,
    ), false);
  });

  it("records malformed payloads as reviewable events instead of treating them as payments", async () => {
    const parsed = await parseWebhookBody(new TextEncoder().encode("{"));
    assert.equal(parsed.transactionId, null);
    assert.match(parsed.reviewReason ?? "", /JSON/);
    assert.match(parsed.eventId, /^invalid-[a-f0-9]{64}$/);
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

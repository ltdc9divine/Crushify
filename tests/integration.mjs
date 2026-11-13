import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDatabaseContract } from "./database-contract.mjs";
import { runPaymentContract } from "./payment-contract.mjs";
import { createLocalEmailSink } from "./local-email-sink.mjs";

const root = process.cwd();
const persistDirectory = await mkdtemp(join(tmpdir(), "crushify-d1-contract-"));
const port = 8787;
const origin = `http://127.0.0.1:${port}`;
const webhookSecret = randomBytes(32).toString("hex");
const receivingAccount = "0000000000";
const emailSink = await createLocalEmailSink();
const child = spawn(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "dev",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--local-protocol",
    "http",
    "--persist-to",
    persistDirectory,
    "--var",
    "ENVIRONMENT:local",
    "--var",
    "LOCAL_TEST_MODE:true",
    "--var",
    `LOCAL_TEST_MAIL_SINK_URL:${emailSink.url}`,
    "--var",
    "LOCAL_TEST_CATALOG_OVERRIDE:true",
    "--var",
    "PAYMENT_MODE:sepay-test",
    "--var",
    `SEPAY_WEBHOOK_SECRET:${webhookSecret}`,
    "--var",
    "SEPAY_BANK_CODE:MB",
    "--var",
    `SEPAY_BANK_ACCOUNT:${receivingAccount}`,
    "--var",
    "SEPAY_ACCOUNT_NAME:Crushify Test",
  ],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
);
let logs = "";
let ready = false;
const capture = (chunk) => {
  logs += chunk.toString();
  if (logs.includes("Ready on")) ready = true;
};
child.stdout.on("data", capture);
child.stderr.on("data", capture);

function sanitizedLogs() {
  return logs.replace(/magic_token=[A-Za-z0-9_-]+/g, "magic_token=[redacted]");
}

function executeLocalD1(sql) {
  return execFileSync(process.execPath, [
    "node_modules/wrangler/bin/wrangler.js",
    "d1",
    "execute",
    "crushify-local",
    "--local",
    "--persist-to",
    persistDirectory,
    "--command",
    sql,
    "--json",
  ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function queryLocalD1(sql) {
  const result = JSON.parse(executeLocalD1(sql));
  return result[0]?.results || [];
}

function assertD1Failure(sql, pattern) {
  try {
    executeLocalD1(sql);
  } catch (error) {
    const output = error instanceof Error && "stdout" in error && "stderr" in error
      ? `${String(error.stdout)}\n${String(error.stderr)}\n${error.message}`
      : String(error);
    assert.match(output, pattern);
    return;
  }
  assert.fail("Expected local D1 command to fail");
}

async function stopWorker() {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await new Promise((resolveExit) => child.once("exit", resolveExit));
  }
}

async function waitReady() {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (ready) return;
    if (child.exitCode !== null) throw new Error(`Wrangler exited before ready.\n${sanitizedLogs()}`);
    await delay(250);
  }
  throw new Error(`Wrangler did not become ready.\n${sanitizedLogs()}`);
}

async function waitForMagicToken(after) {
  return emailSink.waitForMagicToken(after);
}

function makeRequest(session, options = {}) {
  const headers = new Headers(options.headers || {});
  if (session?.cookies.length) headers.set("Cookie", session.cookies.join("; "));
  if (options.mutating) {
    headers.set("Origin", origin);
    if (session?.csrf) headers.set("X-CSRF-Token", session.csrf);
  }
  return { ...options, headers };
}

async function json(path, session, options = {}) {
  const request = makeRequest(session, options);
  request.headers.set("Connection", "close");
  const response = await fetch(origin + "/api/v1" + path, request);
  const body = response.status === 204 ||
    !response.headers.get("content-type")?.includes("application/json")
    ? null
    : await response.json();
  return { response, body };
}

async function paymentContractRequest(path, session, options = {}) {
  const { json: jsonBody, token, ...requestOptions } = options;
  const headers = new Headers(requestOptions.headers || {});
  if (jsonBody !== undefined) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return json(path, session, {
    ...requestOptions,
    headers,
    ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}),
  });
}

async function signIn(email) {
  const start = emailSink.current();
  const requested = await json("/customers/session", null, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  assert.equal(requested.response.status, 202);
  assert.doesNotMatch(logs, /magic_token=/, "magic links must not appear in Wrangler logs");
  const token = await waitForMagicToken(start);
  const magicLinkMessage = emailSink.messages[start];
  assert.match(magicLinkMessage.text, /#magic_token=/);
  assert.doesNotMatch(magicLinkMessage.text, /\?magic_token=/);
  const verified = await json("/customers/session/verify", null, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(verified.response.status, 200, JSON.stringify(verified.body));
  const setCookies = verified.response.headers.getSetCookie();
  const cookies = setCookies.map((value) => value.split(";", 1)[0]);
  const csrf = cookies.find((value) => value.startsWith("crushify_csrf="))?.split("=", 2)[1];
  const sessionCookie = setCookies.find((value) => value.startsWith("crushify_session="));
  const csrfCookie = setCookies.find((value) => value.startsWith("crushify_csrf="));
  assert.ok(sessionCookie, `${email}: session cookie`);
  assert.ok(csrfCookie, `${email}: CSRF cookie`);
  const sessionAttributes = sessionCookie.slice(sessionCookie.indexOf(";") + 1);
  const csrfAttributes = csrfCookie.slice(csrfCookie.indexOf(";") + 1);
  assert.ok(/(?:^|;)\s*HttpOnly(?:;|$)/i.test(sessionAttributes), "local session cookie is HttpOnly");
  assert.ok(/(?:^|;)\s*SameSite=Lax(?:;|$)/i.test(sessionAttributes), "local session cookie uses SameSite=Lax");
  assert.ok(/(?:^|;)\s*Path=\/api\/v1(?:;|$)/i.test(sessionAttributes), "local session cookie has a narrow API path");
  assert.ok(/(?:^|;)\s*Max-Age=1209600(?:;|$)/i.test(sessionAttributes), "local session cookie has a 14-day lifetime");
  assert.ok(!/(?:^|;)\s*Secure(?:;|$)/i.test(sessionAttributes), "local HTTP session cookie omits Secure");
  assert.ok(!/(?:^|;)\s*Domain=|(?:^|;)\s*Expires=/i.test(sessionAttributes), "local session cookie has no Domain or Expires attribute");
  assert.ok(!/(?:^|;)\s*HttpOnly(?:;|$)/i.test(csrfAttributes), "CSRF cookie is readable by the client");
  assert.ok(/(?:^|;)\s*SameSite=Lax(?:;|$)/i.test(csrfAttributes), "local CSRF cookie uses SameSite=Lax");
  assert.ok(/(?:^|;)\s*Path=\/api\/v1(?:;|$)/i.test(csrfAttributes), "local CSRF cookie has a narrow API path");
  assert.ok(/(?:^|;)\s*Max-Age=1209600(?:;|$)/i.test(csrfAttributes), "local CSRF cookie has a 14-day lifetime");
  assert.ok(!/(?:^|;)\s*Secure(?:;|$)/i.test(csrfAttributes), "local HTTP CSRF cookie omits Secure");
  assert.ok(!/(?:^|;)\s*Domain=|(?:^|;)\s*Expires=/i.test(csrfAttributes), "local CSRF cookie has no Domain or Expires attribute");
  assert.ok(csrf);
  const session = { cookies, csrf };
  const me = await json("/customers/me", session);
  assert.equal(me.response.status, 200);
  return session;
}

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function seedPaidOrder(email, designId, revision) {
  const customer = queryLocalD1(
    `SELECT id FROM customers WHERE email_normalized = ${sqlText(email)}`,
  )[0];
  assert.ok(customer?.id);
  const now = new Date().toISOString();
  const orderId = crypto.randomUUID();
  const orderItemId = crypto.randomUUID();
  const storageItemId = crypto.randomUUID();
  const paymentId = crypto.randomUUID();
  const webhookId = crypto.randomUUID();
  const transactionId = `phase6-${randomBytes(12).toString("hex")}`;
  const orderReference = `CRF${randomBytes(8).toString("hex").toUpperCase()}`;
  const paymentReference = `CRP${randomBytes(8).toString("hex").toUpperCase()}`;
  const statements = [
    `INSERT INTO orders (
       id, customer_id, order_type, status, currency, subtotal_minor, discount_minor, total_minor,
       design_id, idempotency_key, created_at, updated_at, paid_at, expires_at, order_reference,
       design_revision, request_hash, payment_review_required
     ) VALUES (
       ${sqlText(orderId)}, ${sqlText(customer.id)}, 'SELF_SERVICE', 'PAID', 'VND', 50000, 0, 50000,
       ${sqlText(designId)}, ${sqlText(`phase6-${orderId}`)}, ${sqlText(now)}, ${sqlText(now)},
       ${sqlText(now)}, NULL, ${sqlText(orderReference)}, ${revision}, ${sqlText("a".repeat(64))}, 0
     )`,
    `INSERT INTO order_items (
       id, order_id, item_type, reference_id, description_snapshot, quantity, unit_amount_minor,
       line_total_minor, metadata_json, created_at
     ) VALUES (
       ${sqlText(orderItemId)}, ${sqlText(orderId)}, 'TEMPLATE_LICENSE', 'our-universe',
       'Our Universe', 1, 50000, 50000, '{"schema_version":1}', ${sqlText(now)}
     )`,
    `INSERT INTO order_items (
       id, order_id, item_type, reference_id, description_snapshot, quantity, unit_amount_minor,
       line_total_minor, metadata_json, created_at
     ) VALUES (
       ${sqlText(storageItemId)}, ${sqlText(orderId)}, 'ADD_ON', '1-month',
       '1 tháng', 1, 0, 0,
       '{"kind":"STORAGE_PLAN","storage_plan_id":"1-month","title":"1 tháng","duration_months":1,"lifetime":false,"asset_consents":[]}',
       ${sqlText(now)}
     )`,
    `INSERT INTO payments (
       id, order_id, provider, provider_payment_id, status, amount_minor, currency, idempotency_key,
       created_at, updated_at, succeeded_at, payment_reference, review_required
     ) VALUES (
       ${sqlText(paymentId)}, ${sqlText(orderId)}, 'SEPAY', ${sqlText(transactionId)}, 'SUCCEEDED',
       50000, 'VND', ${sqlText(`phase6-payment-${paymentId}`)}, ${sqlText(now)}, ${sqlText(now)},
       ${sqlText(now)}, ${sqlText(paymentReference)}, 0
     )`,
    `INSERT INTO payment_webhook_events (
       id, provider, event_id, payload_hash, received_at, processed_at, outcome,
       raw_payload, provider_transaction_id, order_reference, expected_amount_minor, actual_amount_minor
     ) VALUES (
       ${sqlText(webhookId)}, 'SEPAY', ${sqlText(transactionId)}, ${sqlText("b".repeat(64))},
       ${sqlText(now)}, ${sqlText(now)}, 'PROCESSED', '{}', ${sqlText(transactionId)},
       ${sqlText(orderReference)}, 50000, 50000
     )`,
  ];
  for (const statement of statements) executeLocalD1(statement);
  return orderId;
}

function makePng() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc32 = (bytes) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const kind = Buffer.from(type);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([kind, data])));
    return Buffer.concat([length, kind, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", Buffer.from([120, 156, 99, 248, 207, 192, 240, 31, 0, 5, 0, 1, 255])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function uploadImage(session, designId, bytes, declaredType = "image/png") {
  const grant = await json("/assets/upload-url", session, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ design_id: designId, media_type: declaredType, size: bytes.length }),
  });
  assert.equal(grant.response.status, 201);
  const uploaded = await fetch(origin + grant.body.upload_url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${grant.body.upload_token}`,
      "Content-Type": declaredType,
    },
    body: bytes,
  });
  return { grant: grant.body, uploaded };
}

try {
  execFileSync(process.execPath, [
    "node_modules/wrangler/bin/wrangler.js",
    "d1",
    "migrations",
    "apply",
    "crushify-local",
    "--local",
    "--persist-to",
    persistDirectory,
  ], { cwd: root, stdio: "ignore" });
  await waitReady();
  const live = await json("/health/live", null);
  assert.equal(live.response.status, 200);

  const ownerEmail = `phase2-${crypto.randomUUID()}@example.test`;
  const first = await signIn(ownerEmail);
  const csrfRequest = (csrfToken) => fetch(origin + "/api/v1/designs", {
    method: "POST",
    headers: {
      Cookie: first.cookies.join("; "),
      Origin: origin,
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    },
    body: JSON.stringify({ template_id: "our-universe", schema_version: 1 }),
  });
  assert.equal((await csrfRequest(null)).status, 403, "missing CSRF header is rejected");
  assert.equal((await csrfRequest("synthetic-mismatched-csrf-token")).status, 403,
    "mismatched CSRF header is rejected");

  const invalidReturnPaths = [
    "https://evil.example",
    "//evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:alert(1)",
    "file:///synthetic",
    "/%2f%2fevil.example",
    "/%252e%252e%252f",
  ];
  for (const [index, returnTo] of invalidReturnPaths.entries()) {
    const invalidReturn = await json("/customers/session", null, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `redirect-check-${index}-${crypto.randomUUID()}@example.test`,
        return_to: returnTo,
      }),
    });
    assert.equal(invalidReturn.response.status, 400, `unsafe return path ${index} is rejected`);
  }

  const expiredMagicStart = emailSink.current();
  const expiredMagicEmail = `expired-magic-${crypto.randomUUID()}@example.test`;
  const expiredMagicRequest = await json("/customers/session", null, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: expiredMagicEmail }),
  });
  assert.equal(expiredMagicRequest.response.status, 202);
  const expiredMagicToken = await waitForMagicToken(expiredMagicStart);
  const expiredMagicHash = createHash("sha256").update(expiredMagicToken).digest("hex");
  executeLocalD1(
    `UPDATE login_tokens SET expires_at = '2000-01-01T00:00:00.000Z' ` +
    `WHERE token_hash = ${sqlText(expiredMagicHash)}`,
  );
  const expiredMagicVerify = await json("/customers/session/verify", null, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: expiredMagicToken }),
  });
  assert.equal(expiredMagicVerify.response.status, 401, "expired magic link is rejected");

  const expiringSession = await signIn(`expired-session-${crypto.randomUUID()}@example.test`);
  const rawSessionCookie = expiringSession.cookies.find((value) =>
    value.startsWith("crushify_session="),
  );
  assert.ok(rawSessionCookie, "synthetic session cookie exists");
  const rawSession = rawSessionCookie.slice("crushify_session=".length);
  const sessionHash = createHash("sha256").update(rawSession).digest("hex");
  executeLocalD1(
    `UPDATE customer_sessions SET expires_at = '2000-01-01T00:00:00.000Z' ` +
    `WHERE token_hash = ${sqlText(sessionHash)}`,
  );
  assert.equal(
    (await json("/customers/me", expiringSession)).response.status,
    401,
    "expired session is rejected",
  );

  const unauthenticated = await json("/designs", null, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template_id: "our-universe", schema_version: 1 }),
  });
  assert.equal(unauthenticated.response.status, 401);

  const unsupported = await json("/designs", first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template_id: "not-a-template", schema_version: 1 }),
  });
  assert.equal(unsupported.response.status, 422);

  const created = await json("/designs", first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template_id: "our-universe", schema_version: 1 }),
  });
  assert.equal(created.response.status, 201);
  const designId = created.body.design_id;
  assert.equal(created.body.data.sender, "Minh");
  const paymentDesign = await json("/designs", first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template_id: "our-universe", schema_version: 1 }),
  });
  assert.equal(paymentDesign.response.status, 201);
  const paymentDesignData = structuredClone(paymentDesign.body.data);
  const syntheticHeadline = `ORDERS-2.7 synthetic ${crypto.randomUUID()}`;
  paymentDesignData.headline = syntheticHeadline;
  const savedPaymentDesign = await json(`/designs/${paymentDesign.body.design_id}`, first, {
    method: "PUT",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schema_version: paymentDesign.body.schema_version,
      expected_revision: paymentDesign.body.revision,
      data: paymentDesignData,
    }),
  });
  assert.equal(savedPaymentDesign.response.status, 200);
  assert.equal(savedPaymentDesign.body.revision, paymentDesign.body.revision + 1);
  const reloadedPaymentDesign = await json(`/designs/${paymentDesign.body.design_id}`, first);
  assert.equal(reloadedPaymentDesign.response.status, 200);
  assert.equal(reloadedPaymentDesign.body.data.headline, syntheticHeadline);
  const designPreview = await json(`/designs/${paymentDesign.body.design_id}/preview`, first, {
    method: "POST",
    mutating: true,
  });
  assert.equal(designPreview.response.status, 201);
  const previewData = await paymentContractRequest("/previews", null, {
    token: designPreview.body.token,
  });
  assert.equal(previewData.response.status, 200);
  assert.equal(previewData.body.data.headline, syntheticHeadline);
  await runPaymentContract({
    request: paymentContractRequest,
    async seedPrice(amount) {
      for (const [templateId, schemaVersion] of [
        ["our-universe", 1],
        ["love-letter", 2],
        ["our-memories", 1],
        ["say-yes", 1],
        ["distance-means-nothing", 1],
      ]) {
        executeLocalD1(
          `INSERT INTO template_prices (
            id, template_id, schema_version, currency, amount_minor, is_active, created_at, updated_at
          ) VALUES (
            'payment-test-price-${templateId}', '${templateId}', ${schemaVersion}, 'VND', ${amount}, 1,
            '${new Date().toISOString()}', '${new Date().toISOString()}'
          )`,
        );
      }
      for (const [planId, priceId] of [
        ["1-month", "payment-test-storage-1"],
        ["3-months", "payment-test-storage-3"],
        ["6-months", "payment-test-storage-6"],
        ["12-months", "payment-test-storage-12"],
        ["lifetime", "payment-test-storage-life"],
      ]) {
        executeLocalD1(
          `INSERT INTO storage_plan_prices (
            id, storage_plan_id, currency, amount_minor, is_active, created_at, updated_at
          ) VALUES (
            '${priceId}', '${planId}', 'VND', 1000, 1,
            '${new Date().toISOString()}', '${new Date().toISOString()}'
          )`,
        );
      }
    },
    inspectOrderPricingSnapshot(orderId) {
      const readSnapshot = () => queryLocalD1(
        `SELECT item_type, unit_amount_minor, line_total_minor, metadata_json
         FROM order_items WHERE order_id = '${orderId}' ORDER BY item_type`,
      );
      const before = readSnapshot();
      const templateRow = queryLocalD1(
        "SELECT id, amount_minor FROM template_prices WHERE template_id = 'our-universe' AND is_active = 1",
      )[0];
      const storageRow = queryLocalD1(
        "SELECT id, amount_minor FROM storage_plan_prices WHERE storage_plan_id = '1-month' AND is_active = 1",
      )[0];
      assert.ok(templateRow?.id && storageRow?.id);
      try {
        executeLocalD1(`UPDATE template_prices SET amount_minor = ${templateRow.amount_minor + 1} WHERE id = '${templateRow.id}'`);
        executeLocalD1(`UPDATE storage_plan_prices SET amount_minor = ${storageRow.amount_minor + 1} WHERE id = '${storageRow.id}'`);
        assert.deepEqual(readSnapshot(), before, "saved order price snapshots do not change with catalog updates");
      } finally {
        executeLocalD1(`UPDATE template_prices SET amount_minor = ${templateRow.amount_minor} WHERE id = '${templateRow.id}'`);
        executeLocalD1(`UPDATE storage_plan_prices SET amount_minor = ${storageRow.amount_minor} WHERE id = '${storageRow.id}'`);
      }
    },
    tamperOrderPricingSnapshot(orderId) {
      const row = queryLocalD1(
        `SELECT metadata_json FROM order_items
         WHERE order_id = '${orderId}' AND item_type = 'ADD_ON'`,
      )[0];
      assert.ok(row?.metadata_json);
      const original = row.metadata_json;
      const metadata = JSON.parse(original);
      metadata.pricing_snapshot.total_minor += 1;
      executeLocalD1(
        `UPDATE order_items SET metadata_json = ${sqlText(JSON.stringify(metadata))}
         WHERE order_id = '${orderId}' AND item_type = 'ADD_ON'`,
      );
      return original;
    },
    restoreOrderPricingSnapshot(orderId, metadata) {
      executeLocalD1(
        `UPDATE order_items SET metadata_json = ${sqlText(metadata)}
         WHERE order_id = '${orderId}' AND item_type = 'ADD_ON'`,
      );
    },
    owner: first,
    otherOwner: await signIn(`phase2-payment-other-${crypto.randomUUID()}@example.test`),
    designId: paymentDesign.body.design_id,
    webhookSecret,
    receivingAccount,
    async cancelOrder(orderId) {
      executeLocalD1(
        `UPDATE orders SET status = 'CANCELLED' WHERE id = '${orderId}'`,
      );
      executeLocalD1(
        `UPDATE payments SET status = 'CANCELLED' WHERE order_id = '${orderId}' AND status = 'PENDING'`,
      );
    },
    expireOrder(orderId) {
      executeLocalD1(
        `UPDATE orders SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = '${orderId}'`,
      );
    },
    inspectWebhookOutcomes(transactionIds) {
      const values = transactionIds.map((id) => `'${id}'`).join(", ");
      const rows = queryLocalD1(
        `SELECT outcome FROM payment_webhook_events
          WHERE provider = 'SEPAY' AND event_id IN (${values})`,
      );
      return rows.map((row) => row.outcome);
    },
    inspectWebhookEvent(transactionId) {
      const rows = queryLocalD1(
        `SELECT outcome, review_reason, processing_attempts, provider_transaction_id,
                order_reference, expected_amount_minor, actual_amount_minor
           FROM payment_webhook_events WHERE provider = 'SEPAY' AND event_id = '${transactionId}'`,
      );
      assert.equal(rows.length, 1);
      return rows[0];
    },
    setPublicationExpiry(publicationId, expiresAt) {
      executeLocalD1(
        `UPDATE publications SET expires_at = '${expiresAt}' WHERE id = '${publicationId}'`,
      );
      executeLocalD1(
        `UPDATE storage_entitlements SET expires_at = '${expiresAt}', status = 'ACTIVE'
          WHERE publication_id = '${publicationId}' AND status IN ('ACTIVE','EXPIRED')`,
      );
    },
    deactivateTemplatePrice() {
      executeLocalD1(
        "UPDATE template_prices SET is_active = 0 WHERE template_id = 'our-universe' AND schema_version = 1",
      );
    },
    inspectEntitlement(orderId) {
      const rows = queryLocalD1(
        `SELECT activated_at, starts_at, previous_expires_at, expires_at, status, duration_months
          FROM storage_entitlements WHERE order_id = '${orderId}'`,
      );
      assert.equal(rows.length, 1);
      return rows[0];
    },
    inspectStoragePlan(planId) {
      const rows = queryLocalD1(
        `SELECT id, duration_months, is_lifetime, status
          FROM storage_plans WHERE id = '${planId}'`,
      );
      assert.equal(rows.length, 1);
      return rows[0];
    },
    failOrderPayment(orderId) {
      executeLocalD1(
        `CREATE TRIGGER d1_reject_test_order_paid BEFORE UPDATE OF status ON orders ` +
        `WHEN NEW.id = '${orderId}' AND NEW.status = 'PAID' ` +
        "BEGIN SELECT RAISE(ABORT, 'forced payment transaction failure'); END",
      );
    },
    restoreOrderPayment() {
      executeLocalD1("DROP TRIGGER d1_reject_test_order_paid");
    },
    expectedMode: "sepay-test",
    testStandardPricing: true,
    allTemplates: true,
    label: "Cloudflare Worker + local D1/R2",
  });

  const oversized = await json(`/designs/${designId}`, first, {
    method: "PUT",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(70_000) }),
  });
  assert.equal(oversized.response.status, 413);

  const invalid = await json(`/designs/${designId}`, first, {
    method: "PUT",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schema_version: 1,
      expected_revision: 1,
      data: { ...created.body.data, startDate: "2024-99-99" },
    }),
  });
  assert.equal(invalid.response.status, 422);

  const changed = {
    ...created.body.data,
    sender: "An",
    receiver: "Bình",
    headline: "Bầu trời của đôi mình",
    mainMessage: "Tin nhắn được lưu trên D1",
    startDate: "2025-03-08",
    theme: "blue-aurora",
  };
  const updated = await json(`/designs/${designId}`, first, {
    method: "PUT",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schema_version: 1, expected_revision: 1, data: changed }),
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.revision, 2);

  const conflict = await json(`/designs/${designId}`, first, {
    method: "PUT",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schema_version: 1, expected_revision: 1, data: changed }),
  });
  assert.equal(conflict.response.status, 409);

  const reloaded = await json(`/designs/${designId}`, first);
  assert.equal(reloaded.response.status, 200);
  assert.equal(reloaded.body.data.receiver, "Bình");
  assert.equal(reloaded.body.data.mainMessage, "Tin nhắn được lưu trên D1");
  assert.equal(reloaded.body.data.startDate, "2025-03-08");
  assert.equal(reloaded.body.data.theme, "blue-aurora");

  const second = await signIn(`phase2-${crypto.randomUUID()}@example.test`);
  const crossOwner = await json(`/designs/${designId}`, second);
  assert.equal(crossOwner.response.status, 404);
  const crossOwnerUpdate = await json(`/designs/${designId}`, second, {
    method: "PUT",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schema_version: 1, expected_revision: 2, data: changed }),
  });
  assert.equal(crossOwnerUpdate.response.status, 404);

  const tooLargeGrant = await json("/assets/upload-url", first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ design_id: designId, media_type: "image/png", size: 5 * 1024 * 1024 + 1 }),
  });
  assert.equal(tooLargeGrant.response.status, 413);

  const badImage = await uploadImage(first, designId, Buffer.from("GIF89a", "ascii"));
  assert.equal(badImage.uploaded.status, 422);
  const badImageDelete = await json(`/assets/${badImage.grant.asset_id}`, first, {
    method: "DELETE",
    mutating: true,
  });
  assert.equal(badImageDelete.response.status, 200);

  const png = makePng();
  const goodImage = await uploadImage(first, designId, png);
  assert.equal(goodImage.uploaded.status, 204);
  const completed = await json(`/assets/${goodImage.grant.asset_id}/complete`, first, {
    method: "POST",
    mutating: true,
  });
  assert.equal(completed.response.status, 200);
  assert.equal(completed.body.status, "READY");

  const privateImage = await fetch(origin + `/api/v1/assets/${goodImage.grant.asset_id}`, {
    headers: { Cookie: second.cookies.join("; ") },
  });
  assert.equal(privateImage.status, 404);
  const anonymousImage = await fetch(origin + `/api/v1/assets/${goodImage.grant.asset_id}`);
  assert.equal(anonymousImage.status, 401);
  const ownerImage = await fetch(origin + `/api/v1/assets/${goodImage.grant.asset_id}`, {
    headers: { Cookie: first.cookies.join("; ") },
  });
  assert.equal(ownerImage.status, 200);
  assert.equal(ownerImage.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await ownerImage.arrayBuffer()), png);

  const withPhoto = { ...changed, photos: [{ asset_id: goodImage.grant.asset_id, caption: "Kỷ niệm" }] };
  const savedPhoto = await json(`/designs/${designId}`, first, {
    method: "PUT",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schema_version: 1, expected_revision: 2, data: withPhoto }),
  });
  assert.equal(savedPhoto.response.status, 200);
  const photoReloaded = await json(`/designs/${designId}`, first);
  assert.equal(photoReloaded.response.status, 200);
  assert.deepEqual(photoReloaded.body.data.photos, [{ asset_id: goodImage.grant.asset_id, caption: "Kỷ niệm" }]);
  const previewCreated = await json(`/designs/${designId}/preview`, first, {
    method: "POST",
    mutating: true,
  });
  assert.equal(previewCreated.response.status, 201);
  assert.ok(previewCreated.body.url.includes("#"));

  const crossBrowserPreview = await fetch(origin + "/api/v1/previews", {
    headers: { Authorization: `Bearer ${previewCreated.body.token}` },
  });
  assert.equal(crossBrowserPreview.status, 200);
  const previewBody = await crossBrowserPreview.json();
  assert.equal(previewBody.data.sender, "An");
  assert.equal(previewBody.data.photos[0].caption, "Kỷ niệm");
  const previewImage = await fetch(origin + previewBody.data.photos[0].url, {
    headers: { Authorization: `Bearer ${previewCreated.body.token}` },
  });
  assert.equal(previewImage.status, 200);

  const paidOrderId = seedPaidOrder(ownerEmail, designId, 3);
  const consent = {
    asset_id: goodImage.grant.asset_id,
    consent_version: "public-image-v1",
  };
  const unauthorizedPublication = await json("/publications", second, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_id: paidOrderId, expected_revision: 3, asset_consents: [consent] }),
  });
  assert.equal(unauthorizedPublication.response.status, 422);

  const createdPublication = await json("/publications", first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_id: paidOrderId, expected_revision: 3, asset_consents: [consent] }),
  });
  assert.equal(createdPublication.response.status, 201, JSON.stringify(createdPublication.body));
  const publicationId = createdPublication.body.publication_id;
  const publicationSlug = new URL(createdPublication.body.url).pathname.split("/").at(-1);
  assert.match(publicationSlug, /^g[A-Za-z0-9_-]{20,40}$/);
  const unpublishedPublicRead = await json(`/publications/${publicationSlug}`, null);
  assert.equal(unpublishedPublicRead.response.status, 410);
  const publicationShell = await fetch(origin + `/p/${publicationSlug}`);
  assert.equal(publicationShell.status, 200);
  assert.match(publicationShell.headers.get("content-type") || "", /text\/html/);
  const publicationCss = await fetch(origin + "/p/publication.css");
  assert.match(publicationCss.headers.get("content-type") || "", /text\/css/);
  assert.equal((await fetch(origin + "/shared/publication-bootstrap.js")).status, 200);

  const crossOwnerPublication = await json(`/publications/${publicationId}`, second);
  assert.equal(crossOwnerPublication.response.status, 404);
  const firstPublish = await json(`/publications/${publicationId}/publish`, first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_lifecycle_revision: 1 }),
  });
  assert.equal(firstPublish.response.status, 200, JSON.stringify(firstPublish.body));
  const publicRead = await json(`/publications/${publicationSlug}`, null);
  assert.equal(publicRead.response.status, 200, JSON.stringify(publicRead.body));
  assert.equal(publicRead.body.template_id, "our-universe");
  assert.equal(publicRead.body.data.photos[0].caption, "Kỷ niệm");
  assert.equal(publicRead.body.data.photos[0].asset_id, undefined);
  const publishedImagePath = publicRead.body.data.photos[0].url;
  const publishedImage = await fetch(origin + publishedImagePath);
  assert.equal(publishedImage.status, 200);
  assert.equal(publishedImage.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await publishedImage.arrayBuffer()), png);

  const firstUnpublish = await json(`/publications/${publicationId}/unpublish`, first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_lifecycle_revision: 2 }),
  });
  assert.equal(firstUnpublish.response.status, 200);
  assert.equal((await json(`/publications/${publicationSlug}`, null)).response.status, 410);
  const republished = await json(`/publications/${publicationId}/republish`, first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_lifecycle_revision: 3 }),
  });
  assert.equal(republished.response.status, 200, JSON.stringify(republished.body));

  const changedPublicationData = { ...withPhoto, headline: "Bầu trời của chúng mình" };
  const changedForPublication = await json(`/designs/${designId}`, first, {
    method: "PUT",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schema_version: 1, expected_revision: 3, data: changedPublicationData }),
  });
  assert.equal(changedForPublication.response.status, 200);
  const unpublishBeforeUpdate = await json(`/publications/${publicationId}/unpublish`, first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_lifecycle_revision: 4 }),
  });
  assert.equal(unpublishBeforeUpdate.response.status, 200);
  const updateBody = JSON.stringify({
      expected_revision: 4,
      expected_lifecycle_revision: 5,
      asset_consents: [],
    });
  const concurrentUpdates = await Promise.all([
    json(`/publications/${publicationId}`, first, {
      method: "PATCH",
      mutating: true,
      headers: { "Content-Type": "application/json" },
      body: updateBody,
    }),
    json(`/publications/${publicationId}`, first, {
      method: "PATCH",
      mutating: true,
      headers: { "Content-Type": "application/json" },
      body: updateBody,
    }),
  ]);
  assert.deepEqual(
    concurrentUpdates.map((item) => item.response.status).sort(),
    [200, 409],
    "one publication update succeeds and the stale concurrent update conflicts",
  );
  const updateSnapshot = concurrentUpdates.find((item) => item.response.status === 200);
  assert.ok(updateSnapshot);
  assert.equal(updateSnapshot.body.lifecycle_revision, 6);
  const publishUpdated = await json(`/publications/${publicationId}/publish`, first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_lifecycle_revision: 6 }),
  });
  assert.equal(publishUpdated.response.status, 200, JSON.stringify(publishUpdated.body));
  const updatedPublicRead = await json(`/publications/${publicationSlug}`, null);
  assert.equal(updatedPublicRead.response.status, 200);
  assert.equal(updatedPublicRead.body.data.headline, "Bầu trời của chúng mình");
  assert.deepEqual(updatedPublicRead.body.data.photos, []);

  const unpublishBeforeConsent = await json(`/publications/${publicationId}/unpublish`, first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_lifecycle_revision: 7 }),
  });
  assert.equal(unpublishBeforeConsent.response.status, 200);
  const regrantConsent = await json(`/publications/${publicationId}`, first, {
    method: "PATCH",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      expected_revision: 4,
      expected_lifecycle_revision: 8,
      asset_consents: [consent],
    }),
  });
  assert.equal(regrantConsent.response.status, 200);
  const publishWithConsent = await json(`/publications/${publicationId}/publish`, first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_lifecycle_revision: 9 }),
  });
  assert.equal(publishWithConsent.response.status, 200);
  const withdrawConsent = await json(
    `/publications/${publicationId}/assets/${goodImage.grant.asset_id}/consent`,
    first,
    { method: "POST", mutating: true, headers: { "Content-Type": "application/json" }, body: "{}" },
  );
  assert.equal(withdrawConsent.response.status, 200, JSON.stringify(withdrawConsent.body));
  const consentWithdrawnRead = await json(`/publications/${publicationSlug}`, null);
  assert.deepEqual(consentWithdrawnRead.body.data.photos, []);
  assert.equal((await fetch(origin + publishedImagePath)).status, 404);
  const revokePublication = await json(`/publications/${publicationId}/revoke`, first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_lifecycle_revision: 11 }),
  });
  assert.equal(revokePublication.response.status, 200);
  assert.equal((await json(`/publications/${publicationSlug}`, null)).response.status, 410);

  const websites = await json("/publications", first);
  assert.equal(websites.response.status, 200);
  assert.ok(websites.body.websites.some((website) => website.publication_id === publicationId));

  const referencedDelete = await json(`/assets/${goodImage.grant.asset_id}`, first, {
    method: "DELETE",
    mutating: true,
  });
  assert.equal(referencedDelete.response.status, 409, JSON.stringify(referencedDelete.body));
  const withoutPhoto = { ...changedPublicationData, photos: [] };
  const unlinked = await json(`/designs/${designId}`, first, {
    method: "PUT",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schema_version: 1, expected_revision: 4, data: withoutPhoto }),
  });
  assert.equal(unlinked.response.status, 200);
  const removed = await json(`/assets/${goodImage.grant.asset_id}`, first, {
    method: "DELETE",
    mutating: true,
  });
  assert.equal(removed.response.status, 200);
  const removedRead = await fetch(origin + `/api/v1/assets/${goodImage.grant.asset_id}`, {
    headers: { Cookie: first.cookies.join("; ") },
  });
  assert.equal(removedRead.status, 404);

  const tokenHash = createHash("sha256").update(previewCreated.body.token).digest("hex");
  execFileSync(process.execPath, [
    "node_modules/wrangler/bin/wrangler.js",
    "d1",
    "execute",
    "crushify-local",
    "--local",
    "--command",
    `UPDATE preview_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token_hash = '${tokenHash}'`,
  ], { cwd: root, stdio: "ignore" });
  const expiredPreview = await fetch(origin + "/api/v1/previews", {
    headers: { Authorization: `Bearer ${previewCreated.body.token}` },
  });
  assert.equal(expiredPreview.status, 404);

  const deletedDesign = await json(`/designs/${designId}`, first, {
    method: "DELETE",
    mutating: true,
  });
  assert.equal(deletedDesign.response.status, 200);
  const goneDesign = await json(`/designs/${designId}`, first);
  assert.equal(goneDesign.response.status, 404);

  const designForDeletion = await json("/designs", first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template_id: "our-universe", schema_version: 1 }),
  });
  assert.equal(designForDeletion.response.status, 201);
  const deletionDesignId = designForDeletion.body.design_id;
  const deletionImage = await uploadImage(first, deletionDesignId, png);
  assert.equal(deletionImage.uploaded.status, 204);
  const deletionImageComplete = await json(`/assets/${deletionImage.grant.asset_id}/complete`, first, {
    method: "POST",
    mutating: true,
  });
  assert.equal(deletionImageComplete.response.status, 200);
  const deletionDesignWithPhoto = await json(`/designs/${deletionDesignId}`, first, {
    method: "PUT",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schema_version: 1,
      expected_revision: 1,
      data: {
        ...designForDeletion.body.data,
        photos: [{ asset_id: deletionImage.grant.asset_id, caption: "Deletion cleanup" }],
      },
    }),
  });
  assert.equal(deletionDesignWithPhoto.response.status, 200);
  const deletionOrderId = seedPaidOrder(ownerEmail, deletionDesignId, 2);
  const deletionPublication = await json("/publications", first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      order_id: deletionOrderId,
      expected_revision: 2,
      asset_consents: [{
        asset_id: deletionImage.grant.asset_id,
        consent_version: "public-image-v1",
      }],
    }),
  });
  assert.equal(deletionPublication.response.status, 201);
  const deletionPublicationId = deletionPublication.body.publication_id;
  const deletionPublicationSlug = new URL(deletionPublication.body.url).pathname.split("/").at(-1);
  const publishForDeletion = await json(`/publications/${deletionPublicationId}/publish`, first, {
    method: "POST",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_lifecycle_revision: 1 }),
  });
  assert.equal(publishForDeletion.response.status, 200);
  const liveDeletionPublication = await json(`/publications/${deletionPublicationSlug}`, null);
  assert.equal(liveDeletionPublication.response.status, 200);
  const deletionPublicImagePath = liveDeletionPublication.body.data.photos[0].url;
  assert.equal((await fetch(origin + deletionPublicImagePath)).status, 200);
  const removedPublishedDesign = await json(`/designs/${deletionDesignId}`, first, {
    method: "DELETE",
    mutating: true,
  });
  assert.equal(removedPublishedDesign.response.status, 200);
  assert.equal((await json(`/publications/${deletionPublicationSlug}`, null)).response.status, 404);
  assert.equal((await fetch(origin + deletionPublicImagePath)).status, 404);
  const deletionState = queryLocalD1(
    `SELECT d.status AS design_status, p.status AS publication_status,
            pa.derivative_status, pa.derivative_key, a.status AS asset_status
       FROM designs d
       JOIN publications p ON p.design_id = d.id
       JOIN publication_assets pa ON pa.publication_id = p.id
       JOIN assets a ON a.id = pa.asset_id
      WHERE d.id = '${deletionDesignId}'`,
  );
  assert.equal(deletionState.length, 1);
  assert.equal(deletionState[0].design_status, "ARCHIVED");
  assert.equal(deletionState[0].publication_status, "REVOKED");
  assert.equal(deletionState[0].derivative_status, "DELETED");
  assert.equal(deletionState[0].derivative_key, null);
  assert.equal(deletionState[0].asset_status, "DELETED");

  const revoked = await json("/customers/session", first, {
    method: "DELETE",
    mutating: true,
  });
  assert.equal(revoked.response.status, 200);
  const revokedMe = await json("/customers/me", first);
  assert.equal(revokedMe.response.status, 401);

  const contractRequest = async (path, session, options = {}) => {
    const headers = new Headers(options.headers ?? {});
    if (session?.cookies.length) headers.set("Cookie", session.cookies.join("; "));
    if (options.mutating) {
      headers.set("Origin", origin);
      if (session?.csrf) headers.set("X-CSRF-Token", session.csrf);
    }
    if (options.json !== undefined) {
      headers.set("Content-Type", "application/json");
      options = { ...options, body: JSON.stringify(options.json) };
    }
    if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
    const response = await fetch(origin + "/api/v1" + path, {
      method: options.method ?? "GET",
      headers,
      body: options.body,
    });
    const body = response.status === 204 ||
      !response.headers.get("content-type")?.includes("application/json")
      ? null
      : await response.json();
    return { response, body };
  };
  const contract = await runDatabaseContract({
    request: contractRequest,
    getMagicToken: () => emailSink.waitForMagicToken(),
    label: "Cloudflare D1 + local R2",
  });

  const assetFailureDesign = await contractRequest("/designs", contract.owner, {
    method: "POST",
    mutating: true,
    json: { template_id: "our-universe", schema_version: 1 },
  });
  assert.equal(assetFailureDesign.response.status, 201);
  executeLocalD1(
    "CREATE TRIGGER d1_contract_reject_asset_metadata BEFORE UPDATE OF sha256 ON assets " +
    "WHEN NEW.status = 'QUARANTINED' BEGIN SELECT RAISE(ABORT, 'forced asset metadata failure'); END",
  );
  const failedUpload = await uploadImage(contract.owner, assetFailureDesign.body.design_id, makePng());
  assert.equal(failedUpload.uploaded.status, 502);
  const inaccessibleFailedUpload = await contractRequest(
    `/assets/${failedUpload.grant.asset_id}`,
    contract.owner,
  );
  assert.equal(inaccessibleFailedUpload.response.status, 404);
  executeLocalD1("DROP TRIGGER d1_contract_reject_asset_metadata");
  const uploadRetry = await fetch(origin + failedUpload.grant.upload_url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${failedUpload.grant.upload_token}`,
      "Content-Type": "image/png",
    },
    body: makePng(),
  });
  assert.equal(uploadRetry.status, 204, "failed DB write should clean binary and release the one-time upload token");
  const completedRetry = await contractRequest(
    `/assets/${failedUpload.grant.asset_id}/complete`,
    contract.owner,
    { method: "POST", mutating: true },
  );
  assert.equal(completedRetry.response.status, 200);

  const rollbackDesign = await contractRequest("/designs", contract.owner, {
    method: "POST",
    mutating: true,
    json: { template_id: "our-universe", schema_version: 1 },
  });
  assert.equal(rollbackDesign.response.status, 201);
  executeLocalD1(
    "CREATE TRIGGER d1_contract_reject_revision BEFORE INSERT ON design_revisions " +
    "WHEN NEW.revision = 2 BEGIN SELECT RAISE(ABORT, 'forced contract failure'); END",
  );
  const rejectedUpdate = await contractRequest(`/designs/${rollbackDesign.body.design_id}`, contract.owner, {
    method: "PUT",
    mutating: true,
    json: {
      schema_version: 1,
      expected_revision: 1,
      data: { ...rollbackDesign.body.data, sender: "Should roll back" },
    },
  });
  assert.equal(rejectedUpdate.response.status, 500);
  const unchangedAfterRollback = await contractRequest(
    `/designs/${rollbackDesign.body.design_id}`,
    contract.owner,
  );
  assert.equal(unchangedAfterRollback.response.status, 200);
  assert.equal(unchangedAfterRollback.body.revision, 1);
  assert.notEqual(unchangedAfterRollback.body.data.sender, "Should roll back");
  executeLocalD1("DROP TRIGGER d1_contract_reject_revision");

  let verificationRateLimited = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const verification = await json("/customers/session/verify", null, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: `synthetic-invalid-token-${attempt}` }),
    });
    if (verification.response.status === 429) {
      verificationRateLimited = true;
      break;
    }
    assert.equal(verification.response.status, 401, "invalid magic link is rejected before rate limit");
  }
  assert.ok(verificationRateLimited, "verification endpoint enforces its local rate limit");

  await stopWorker();
  executeLocalD1(
    "CREATE TABLE d1_contract_unique (id TEXT PRIMARY KEY, value TEXT NOT NULL UNIQUE)",
  );
  executeLocalD1("INSERT INTO d1_contract_unique (id, value) VALUES ('one', 'same')");
  assertD1Failure(
    "INSERT INTO d1_contract_unique (id, value) VALUES ('two', 'same')",
    /UNIQUE constraint failed/i,
  );
  executeLocalD1(
    "CREATE TABLE d1_contract_fk (id TEXT PRIMARY KEY, customer_id TEXT REFERENCES customers(id))",
  );
  assertD1Failure(
    "INSERT INTO d1_contract_fk (id, customer_id) VALUES ('orphan', 'missing-customer')",
    /FOREIGN KEY constraint failed/i,
  );

  console.log("Local integration: passed (D1 API and payment contracts, legacy regression, constraints, and batch rollback).");
} catch (error) {
  console.error(error);
  console.error(sanitizedLogs());
  process.exitCode = 1;
} finally {
  await stopWorker();
  await emailSink.close();
  if (process.platform === "win32") {
    const cleanup = spawn(
      process.execPath,
      [
        "-e",
        "const fs=require('node:fs');setTimeout(()=>fs.rmSync(process.argv[1],{recursive:true,force:true}),3000)",
        persistDirectory,
      ],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    cleanup.unref();
  } else {
    await rm(persistDirectory, { recursive: true, force: true });
  }
}

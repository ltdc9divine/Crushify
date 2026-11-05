import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runDatabaseContract } from "./database-contract.mjs";
import { runPaymentContract } from "./payment-contract.mjs";

const root = process.cwd();
const devVars = resolve(root, ".dev.vars");
if (!existsSync(devVars)) {
  throw new Error("Copy .dev.vars.example to .dev.vars before running npm run test:integration.");
}

const persistDirectory = await mkdtemp(join(tmpdir(), "crushify-d1-contract-"));
const port = 8787;
const origin = `http://127.0.0.1:${port}`;
const webhookSecret = randomBytes(32).toString("hex");
const receivingAccount = "0000000000";
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
    "PAYMENT_MODE:mock",
    "--var",
    `SEPAY_WEBHOOK_SECRET:${webhookSecret}`,
    "--var",
    `SEPAY_BANK_ACCOUNT:${receivingAccount}`,
  ],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
);
let logs = "";
let ready = false;
let logCursor = 0;
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
  for (let attempt = 0; attempt < 80; attempt++) {
    const text = logs.slice(after);
    const match = text.match(/magic_token=([A-Za-z0-9_-]+)/);
    if (match) return match[1];
    await delay(100);
  }
  throw new Error(`Local email adapter did not emit a link.\n${sanitizedLogs()}`);
}

async function waitForNextMagicToken() {
  for (let attempt = 0; attempt < 80; attempt++) {
    const text = logs.slice(logCursor);
    const match = text.match(/magic_token=([A-Za-z0-9_-]+)/);
    if (match) {
      logCursor += text.indexOf(match[0]) + match[0].length;
      return match[1];
    }
    await delay(100);
  }
  throw new Error(`Local email adapter did not emit a contract magic link.\n${sanitizedLogs()}`);
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
  const response = await fetch(origin + "/api/v1" + path, makeRequest(session, options));
  const body = response.status === 204 ||
    !response.headers.get("content-type")?.includes("application/json")
    ? null
    : await response.json();
  return { response, body };
}

async function signIn(email) {
  const start = logs.length;
  const requested = await json("/customers/session", null, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  assert.equal(requested.response.status, 202);
  const magicLinkLog = logs.slice(start);
  assert.match(magicLinkLog, /#magic_token=/);
  assert.doesNotMatch(magicLinkLog, /\?magic_token=/);
  const token = await waitForMagicToken(start);
  const verified = await json("/customers/session/verify", null, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(verified.response.status, 200, JSON.stringify(verified.body));
  const setCookies = verified.response.headers.getSetCookie();
  const cookies = setCookies.map((value) => value.split(";", 1)[0]);
  const csrf = cookies.find((value) => value.startsWith("crushify_csrf="))?.split("=", 2)[1];
  assert.ok(cookies.some((value) => value.startsWith("crushify_session=")));
  assert.ok(csrf);
  const session = { cookies, csrf };
  const me = await json("/customers/me", session);
  assert.equal(me.response.status, 200);
  return session;
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

  const first = await signIn(`phase2-${crypto.randomUUID()}@example.test`);
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
    body: JSON.stringify({ template_id: "say-yes", schema_version: 1 }),
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
  await runPaymentContract({
    request: json,
    async seedPrice(amount) {
      executeLocalD1(
        `INSERT INTO template_prices (
          id, template_id, schema_version, currency, amount_minor, is_active, created_at, updated_at
        ) VALUES (
          'payment-test-price', 'our-universe', 1, 'VND', ${amount}, 1,
          '${new Date().toISOString()}', '${new Date().toISOString()}'
        )`,
      );
    },
    owner: first,
    designId,
    webhookSecret,
    receivingAccount,
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

  const referencedDelete = await json(`/assets/${goodImage.grant.asset_id}`, first, {
    method: "DELETE",
    mutating: true,
  });
  assert.equal(referencedDelete.response.status, 409, JSON.stringify(referencedDelete.body));
  const withoutPhoto = { ...withPhoto, photos: [] };
  const unlinked = await json(`/designs/${designId}`, first, {
    method: "PUT",
    mutating: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schema_version: 1, expected_revision: 3, data: withoutPhoto }),
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
  logCursor = logs.length;
  const contract = await runDatabaseContract({
    request: contractRequest,
    getMagicToken: waitForNextMagicToken,
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

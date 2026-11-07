import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = process.cwd();
const port = 8788;
const origin = `http://127.0.0.1:${port}`;
const persistDirectory = await mkdtemp(join(tmpdir(), "crushify-love-letter-browser-"));
const webhookSecret = randomBytes(32).toString("hex");
const accountNumber = "0000000000";
const child = spawn(process.execPath, [
  "node_modules/wrangler/bin/wrangler.js",
  "dev",
  "--ip", "127.0.0.1",
  "--port", String(port),
  "--local-protocol", "http",
  "--persist-to", persistDirectory,
  "--var", "ENVIRONMENT:local",
  "--var", "LOCAL_TEST_MODE:true",
  "--var", "PAYMENT_MODE:sepay-test",
  "--var", `APP_ORIGIN:${origin}`,
  "--var", `SEPAY_WEBHOOK_SECRET:${webhookSecret}`,
  "--var", "SEPAY_BANK_CODE:MB",
  "--var", `SEPAY_BANK_ACCOUNT:${accountNumber}`,
  "--var", "SEPAY_ACCOUNT_NAME:Crushify Test",
], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });

let logs = "";
let ready = false;
let session;
let photoAssetId;
const publications = {};
const controlServer = createServer();
const capture = (chunk) => {
  logs += chunk.toString();
  if (logs.includes("Ready on")) ready = true;
};
child.stdout.on("data", capture);
child.stderr.on("data", capture);

function safeLogs() {
  return logs.replace(/magic_token=[A-Za-z0-9_-]+/g, "magic_token=[redacted]");
}

function d1(sql) {
  return execFileSync(process.execPath, [
    "node_modules/wrangler/bin/wrangler.js",
    "d1", "execute", "crushify-local", "--local", "--persist-to", persistDirectory,
    "--command", sql,
  ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function waitReady() {
  for (let i = 0; i < 160; i++) {
    if (ready) return;
    if (child.exitCode !== null) throw new Error(`Local Worker exited before ready.\n${safeLogs()}`);
    await delay(250);
  }
  throw new Error(`Local Worker did not become ready.\n${safeLogs()}`);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (session?.cookies.length) headers.set("Cookie", session.cookies.join("; "));
  if (options.mutating) {
    headers.set("Origin", origin);
    if (session?.csrf) headers.set("X-CSRF-Token", session.csrf);
  }
  if (options.json !== undefined) {
    headers.set("Content-Type", "application/json");
    options.body = JSON.stringify(options.json);
  }
  const response = await fetch(`${origin}/api/v1${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body,
  });
  const body = response.headers.get("content-type")?.includes("application/json")
    ? await response.json()
    : null;
  return { response, body };
}

async function signIn() {
  const cursor = logs.length;
  const requested = await api("/customers/session", {
    method: "POST",
    json: { email: `browser-${randomUUID()}@example.test` },
  });
  assert.equal(requested.response.status, 202);
  let token;
  for (let i = 0; i < 100; i++) {
    token = logs.slice(cursor).match(/magic_token=([A-Za-z0-9_-]+)/)?.[1];
    if (token) break;
    await delay(100);
  }
  assert.ok(token, `Local test mail adapter did not emit a token.\n${safeLogs()}`);
  const verified = await api("/customers/session/verify", {
    method: "POST",
    json: { token },
  });
  assert.equal(verified.response.status, 200);
  const cookies = verified.response.headers.getSetCookie().map((value) => value.split(";", 1)[0]);
  const csrf = cookies.find((value) => value.startsWith("crushify_csrf="))?.split("=", 2)[1];
  assert.ok(cookies.some((value) => value.startsWith("crushify_session=")));
  assert.ok(csrf);
  session = { cookies, csrf };
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

async function uploadPhoto(designId) {
  const bytes = makePng();
  const grant = await api("/assets/upload-url", {
    method: "POST",
    mutating: true,
    json: { design_id: designId, media_type: "image/png", size: bytes.length },
  });
  assert.equal(grant.response.status, 201);
  const uploaded = await fetch(`${origin}${grant.body.upload_url}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${grant.body.upload_token}`,
      "Content-Type": "image/png",
    },
    body: bytes,
  });
  assert.equal(uploaded.status, 204);
  const completed = await api(`/assets/${grant.body.asset_id}/complete`, {
    method: "POST",
    mutating: true,
  });
  assert.equal(completed.response.status, 200);
  return grant.body.asset_id;
}

async function createRecipient(templateVersion, withPhoto, consentPhoto, name) {
  const created = await api("/designs", {
    method: "POST",
    mutating: true,
    json: { template_id: "love-letter", schema_version: 2 },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const designId = created.body.design_id;
  const data = {
    ...created.body.data,
    from: "Browser test",
    to: name,
    title: `Bức thư ${name}`,
    msg: "Nội dung kiểm tra recipient mode.",
    secret: "Chỉ dùng trong kiểm thử.",
    theme: "rose",
    spd: "1",
  };
  if (withPhoto) {
    photoAssetId = await uploadPhoto(designId);
    data.photos = [{ asset_id: photoAssetId, caption: "Ảnh kiểm thử được đồng ý" }];
  } else {
    data.photos = [];
  }
  const saved = await api(`/designs/${designId}`, {
    method: "PUT",
    mutating: true,
    json: { schema_version: 2, expected_revision: 1, data },
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
  if (templateVersion === 1) {
    const legacyData = { ...data };
    delete legacyData.photos;
    const snapshot = JSON.stringify(legacyData).replaceAll("'", "''");
    d1(`UPDATE designs SET schema_version = 1, data_json = '${snapshot}'
        WHERE id = '${designId}'`);
    d1(`UPDATE design_revisions SET data_json = '${snapshot}'
        WHERE design_id = '${designId}' AND revision = ${saved.body.revision}`);
  }

  const order = await api("/orders", {
    method: "POST",
    mutating: true,
    headers: { "Idempotency-Key": `browser-${randomUUID()}` },
    json: {
      design_id: designId,
      storage_plan_id: "1-month",
      asset_consents: consentPhoto
        ? [{ asset_id: photoAssetId, consent_version: "public-image-v1" }]
        : [],
    },
  });
  assert.equal(order.response.status, 201, JSON.stringify(order.body));
  const transactionId = String(Date.now() + Math.floor(Math.random() * 10000));
  const payload = JSON.stringify({
    id: transactionId,
    accountNumber,
    code: order.body.payment.reference,
    transferType: "in",
    transferAmount: order.body.total_minor,
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", webhookSecret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.from(payload)]))
    .digest("hex");
  const paid = await fetch(`${origin}/api/v1/payments/sepay/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SePay-Timestamp": String(timestamp),
      "X-SePay-Signature": `sha256=${signature}`,
    },
    body: payload,
  });
  assert.equal(paid.status, 200, await paid.text());
  const status = await api(`/orders/${order.body.order_id}/status`);
  assert.equal(status.body.status, "FULFILLED", JSON.stringify(status.body));
  const websites = await api("/publications");
  const website = websites.body.websites.find((item) => item.design_id === designId);
  assert.ok(website?.publication_id, "payment fulfillment should publish the template");
  const publicInfo = await api(`/publications/${website.publication_id}`);
  assert.equal(publicInfo.response.status, 200);
  const slug = new URL(publicInfo.body.url).pathname.split("/").at(-1);
  const content = await fetch(`${origin}/api/v1/publications/${slug}`);
  assert.equal(content.status, 200);
  const publicData = await content.json();
  if (consentPhoto) {
    assert.equal(publicData.schema_version, 2);
    assert.equal(publicData.data.photos.length, 1);
    assert.equal(publicData.data.photos[0].asset_id, undefined);
    assert.match(publicData.data.photos[0].url, new RegExp(`/publications/${slug}/assets/`));
    assert.doesNotMatch(publicData.data.photos[0].url, /\/api\/v1\/assets\//);
  } else {
    assert.deepEqual(publicData.data.photos || [], []);
  }
  return {
    publicationId: website.publication_id,
    url: `${origin}/p/${slug}`,
    slug,
  };
}

async function stopWorker() {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await new Promise((resolveExit) => child.once("exit", resolveExit));
  }
}

try {
  if (!existsSync(resolve(root, ".dev.vars"))) {
    throw new Error("Copy .dev.vars.example to .dev.vars before running browser QA.");
  }
  execFileSync(process.execPath, [
    "node_modules/wrangler/bin/wrangler.js",
    "d1", "migrations", "apply", "crushify-local", "--local", "--persist-to", persistDirectory,
  ], { cwd: root, stdio: "ignore" });
  await waitReady();
  await signIn();
  const now = new Date().toISOString();
  d1(`INSERT INTO storage_plan_prices (
        id, storage_plan_id, currency, amount_minor, is_active, created_at, updated_at
      ) VALUES ('browser-storage-price', '1-month', 'VND', 1000, 1, '${now}', '${now}')`);
  for (const version of [1, 2]) {
    d1(`INSERT INTO template_prices (
          id, template_id, schema_version, currency, amount_minor, is_active, created_at, updated_at
        ) VALUES (
          'browser-love-letter-${version}', 'love-letter', ${version}, 'VND', 50000, 1, '${now}', '${now}'
        )`);
  }

  publications.v1 = await createRecipient(1, false, false, "schema v1");
  publications.v2Empty = await createRecipient(2, false, false, "schema v2");
  publications.v2Unconsented = await createRecipient(2, true, false, "ảnh chưa đồng ý");
  publications.v2Photo = await createRecipient(2, true, true, "ảnh được đồng ý");

  controlServer.on("request", async (request, response) => {
    try {
      if (request.method === "POST" && request.url === "/withdraw") {
        const revoked = await api(
          `/publications/${publications.v2Photo.publicationId}/assets/${photoAssetId}/consent`,
          { method: "POST", mutating: true, json: {} },
        );
        response.writeHead(revoked.response.status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(revoked.body));
        return;
      }
      if (request.method === "GET" && request.url === "/state") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ origin, publications, photoAssetId }));
        return;
      }
      if (request.method === "POST" && request.url === "/finish") {
        response.writeHead(200);
        response.end("finished");
        controlServer.close();
        return;
      }
      response.writeHead(404);
      response.end();
    } catch (error) {
      response.writeHead(500);
      response.end(error instanceof Error ? error.message : "Browser test control failed");
    }
  });
  await new Promise((resolveListen, reject) => {
    controlServer.once("error", reject);
    controlServer.listen(0, "127.0.0.1", resolveListen);
  });
  const address = controlServer.address();
  const controlUrl = `http://127.0.0.1:${address.port}`;
  console.log(`BROWSER_QA_READY ${JSON.stringify({ ...publications, controlUrl })}`);
  await new Promise((resolveClose) => controlServer.once("close", resolveClose));
  await stopWorker();
} catch (error) {
  console.error(error);
  console.error(safeLogs());
  process.exitCode = 1;
} finally {
  if (controlServer.listening) controlServer.close();
  await stopWorker();
  if (process.platform === "win32") {
    const cleanup = spawn(process.execPath, [
      "-e",
      "const fs=require('node:fs');setTimeout(()=>fs.rmSync(process.argv[1],{recursive:true,force:true}),3000)",
      persistDirectory,
    ], { detached: true, stdio: "ignore", windowsHide: true });
    cleanup.unref();
  } else {
    await rm(persistDirectory, { recursive: true, force: true });
  }
}

import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createLocalEmailSink } from "./local-email-sink.mjs";

const root = process.cwd();
const origin = "http://127.0.0.1:8799";
const controlServer = createServer();
const persistDirectory = await mkdtemp(join(tmpdir(), "crushify-orders-2-10-"));
const emailSink = await createLocalEmailSink();
const wrangler = "node_modules/wrangler/bin/wrangler.js";
const templates = new Set([
  "our-universe",
  "love-letter",
  "our-memories",
  "say-yes",
  "distance-means-nothing",
]);
let worker;
let logs = "";
let ready = false;
let magicToken = "";
let closing = false;
const capture = (chunk) => {
  logs += chunk.toString();
  if (logs.includes("Ready on")) ready = true;
};
function safeLogs() {
  return logs.replace(/magic_token=[A-Za-z0-9_-]+/g, "magic_token=[redacted]");
}

function startWorker() {
  worker = spawn(process.execPath, [
    wrangler,
    "dev",
    "--ip", "127.0.0.1",
    "--port", "8799",
    "--local-protocol", "http",
    "--persist-to", persistDirectory,
    "--var", "ENVIRONMENT:local",
    "--var", "LOCAL_TEST_MODE:true",
    "--var", `LOCAL_TEST_MAIL_SINK_URL:${emailSink.url}`,
    "--var", "LOCAL_TEST_CATALOG_OVERRIDE:true",
    "--var", "LOCAL_TEST_PRICING_POLICY:true",
    "--var", "PAYMENT_MODE:mock",
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  worker.stdout.on("data", capture);
  worker.stderr.on("data", capture);
}

async function waitReady() {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (ready) return;
    if (worker.exitCode !== null) throw new Error(`Local Worker exited before ready.\n${safeLogs()}`);
    await delay(250);
  }
  throw new Error(`Local Worker did not become ready.\n${safeLogs()}`);
}

async function prepareSyntheticLogin() {
  const emailCursor = emailSink.current();
  const requested = await fetch(`${origin}/api/v1/customers/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `orders-2-10-${randomUUID()}@example.test` }),
  });
  if (requested.status !== 202) throw new Error(`Synthetic sign-in request returned ${requested.status}`);
  if (/magic_token=/.test(logs)) throw new Error("Magic link was unexpectedly written to Worker logs");
  magicToken = await emailSink.waitForMagicToken(emailCursor);
}

async function stopWorker() {
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    worker.kill();
    await new Promise((resolve) => worker.once("exit", resolve));
  }
}

async function cleanup() {
  if (closing) return;
  closing = true;
  if (controlServer.listening) {
    await new Promise((resolve) => controlServer.close(resolve));
  }
  await stopWorker();
  await emailSink.close();
  await delay(500);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(persistDirectory, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 4) throw error;
      await delay(500);
    }
  }
}

try {
  execFileSync(process.execPath, [
    wrangler,
    "d1", "migrations", "apply", "crushify-local", "--local",
    "--persist-to", persistDirectory,
  ], { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
  startWorker();
  await waitReady();
  await prepareSyntheticLogin();
  controlServer.on("request", (request, response) => {
    if (request.method === "POST" && request.url === "/cleanup") {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("cleaning");
      void cleanup();
      return;
    }

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/open" ||
        !templates.has(url.searchParams.get("template") ?? "")) {
      response.writeHead(404);
      response.end();
      return;
    }

    const template = url.searchParams.get("template");
    const firstUse = Boolean(magicToken);
    const target = new URL(`/templates/${template}/`, origin);
    if (firstUse) {
      target.searchParams.set("magic_token", magicToken);
      magicToken = "";
    }
    response.writeHead(302, { Location: target.href, "Cache-Control": "no-store" });
    response.end();
  });
  await new Promise((resolve, reject) => {
    controlServer.once("error", reject);
    controlServer.listen(54965, "127.0.0.1", resolve);
  });
  console.log(`BROWSER_FIXTURE_READY ${JSON.stringify({
    origin,
    controlOrigin: "http://127.0.0.1:54965",
    templates: [...templates],
  })}`);
  await new Promise((resolve) => controlServer.once("close", resolve));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Browser fixture failed");
  console.error(safeLogs());
  process.exitCode = 1;
} finally {
  await cleanup();
}

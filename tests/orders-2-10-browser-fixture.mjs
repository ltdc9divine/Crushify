import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createLocalEmailSink } from "./local-email-sink.mjs";

const root = process.cwd();
const origin = "http://127.0.0.1:8799";
const controlServer = createServer();
const persistDirectory = await mkdtemp(join(tmpdir(), "crushify-orders-2-10-"));
const wranglerConfig = join(persistDirectory, "wrangler.browser.jsonc");
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
let imageNormalizer;
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

async function d1Json(sql) {
  const response = await fetch(`${origin}/api/__integration/database`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "query", sql }),
  });
  if (!response.ok) {
    throw new Error(`Local D1 integration query returned ${response.status}`);
  }
  const result = await response.json();
  return result?.results?.[0] ?? {};
}

function startWorker() {
  const args = [
    wrangler,
    "dev",
    "--config", wranglerConfig,
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
  ];
  if (imageNormalizer) {
    args.push("--var", `LOCAL_TEST_IMAGE_NORMALIZER_URL:${imageNormalizer.url}`);
  }
  worker = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
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
    body: JSON.stringify({ email: "orders-2-10-admin@example.test" }),
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
  if (imageNormalizer) await imageNormalizer.close();
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
  await writeFile(wranglerConfig, JSON.stringify({
    name: "crushify-browser-fixture",
    main: join(root, "tests", "integration-worker.mjs"),
    compatibility_date: "2025-11-01",
    workers_dev: false,
    assets: {
      directory: root,
      binding: "ASSETS",
      run_worker_first: ["/api/*"],
      not_found_handling: "none",
    },
    vars: {
      DATABASE_PROVIDER: "d1",
      STORAGE_PROVIDER: "r2",
      ADMIN_EMAILS: "orders-2-10-admin@example.test",
    },
    d1_databases: [{
      binding: "DB",
      database_name: "crushify-local",
      database_id: "00000000-0000-4000-8000-000000000001",
      migrations_dir: join(root, "migrations"),
    }],
    r2_buckets: [{
      binding: "MEDIA",
      bucket_name: "crushify-media-local",
    }],
  }, null, 2));
  execFileSync(process.execPath, [
    wrangler,
    "d1", "migrations", "apply", "crushify-local", "--local",
    "--config", wranglerConfig,
    "--persist-to", persistDirectory,
  ], { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
  if (process.argv.includes("--with-local-image-normalizer")) {
    const { createLocalImageNormalizer } = await import("./local-image-normalizer.mjs");
    imageNormalizer = await createLocalImageNormalizer();
  }
  startWorker();
  await waitReady();
  await prepareSyntheticLogin();
  controlServer.on("request", async (request, response) => {
    if (request.method === "POST" && request.url === "/cleanup") {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("cleaning");
      void cleanup();
      return;
    }

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/login") {
      const email = url.searchParams.get("email");
      const returnTo = url.searchParams.get("return_to");
      if (!email) {
        response.writeHead(400).end();
        return;
      }
      const cursor = emailSink.current();
      const requested = await fetch(`${origin}/api/v1/customers/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, ...(returnTo ? { return_to: returnTo } : {}) }),
      });
      if (requested.status !== 202) {
        response.writeHead(500).end(JSON.stringify({ status: requested.status }));
        return;
      }
      try {
        const token = await emailSink.waitForMagicToken(cursor);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ token }));
      } catch (error) {
        response.writeHead(500).end(JSON.stringify({
          error: error instanceof Error ? error.message : "Login fixture failed",
        }));
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/db-counts") {
      const designId = url.searchParams.get("design_id") ?? "";
      const orderId = url.searchParams.get("order_id") ?? "";
      const customerEmail = url.searchParams.get("customer_email") ?? "";
      if (!designId || !orderId) {
        response.writeHead(400).end();
        return;
      }
      const customer = customerEmail
        ? await d1Json(`SELECT id FROM customers WHERE email_normalized = '${customerEmail.replaceAll("'", "''")}'`)
        : {};
      const customerScope = customer.id
        ? ` AND customer_id = '${customer.id}'`
        : "";
      const orderCount = await d1Json(
        `SELECT COUNT(*) AS count FROM orders
         WHERE design_id = '${designId.replaceAll("'", "''")}'${customerScope}`,
      );
      const paymentCount = await d1Json(
        `SELECT COUNT(*) AS count FROM payments p
         JOIN orders o ON o.id = p.order_id
         WHERE p.order_id = '${orderId.replaceAll("'", "''")}'${customerScope.replace("customer_id", "o.customer_id")}`,
      );
      const matchingCount = await d1Json(
        `SELECT COUNT(*) AS count FROM orders o
         WHERE o.design_id = '${designId.replaceAll("'", "''")}'
           AND o.id = '${orderId.replaceAll("'", "''")}'${customerScope.replace("customer_id", "o.customer_id")}`,
      );
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ordersForDesign: Number(orderCount.count ?? 0),
        paymentsForOrder: Number(paymentCount.count ?? 0),
        matchingOrder: Number(matchingCount.count ?? 0),
      }));
      return;
    }
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

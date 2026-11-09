import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type AddressInfo, type IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { createClient } from "@libsql/client";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { applyMigrations, type SqlMigration } from "../src/database/migrations.ts";
import { TursoDatabaseAdapter } from "../src/database/turso.ts";
import { connectDatabaseFromEnvironment } from "../src/database/provider.ts";
import type { Database } from "../src/database.ts";
import type { Storage } from "../src/storage.ts";
import { MemoryStorageAdapter } from "../src/storage/mock.ts";
import { recoverPendingFulfillments } from "../src/publications.ts";
import { createVercelApiHandler, VERCEL_UPLOAD_MAX_BYTES } from "../src/platform/vercel.ts";
import nodeHandler, { readVercelRequestBody } from "../api/[...path].ts";
import { runDatabaseContract } from "./database-contract.mjs";
import { runPaymentContract } from "./payment-contract.mjs";

async function loadMigrations(): Promise<SqlMigration[]> {
  const directory = join(process.cwd(), "migrations");
  const files = (await readdir(directory)).filter((file) => file.toLowerCase().endsWith(".sql")).sort();
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

function requestWithOrigin(path: string, origin: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("Origin", origin);
  return new Request(`https://crushify.test/api/v1${path}`, { ...init, headers });
}

describe("Vercel API runtime adapter", () => {
  it("enables mock settlement only for explicit local SQLite and mock storage", async () => {
    const unusedDatabase: Database = {
      prepare() {
        throw new Error("Database must not be accessed by this guard test");
      },
      async batch() {
        throw new Error("Database must not be accessed by this guard test");
      },
    };
    const dependencies = {
      async connectDatabase() {
        return { database: unusedDatabase, close: () => undefined };
      },
      createMockStorage: () => new MemoryStorageAdapter(),
      createCloudinaryStorage: () => new MemoryStorageAdapter(),
    };
    const secret = randomBytes(32).toString("hex");
    const webhook = () => new Request("https://crushify.test/api/v1/payments/sepay/webhook", {
      method: "POST",
      headers: { Origin: "https://crushify.test", "Content-Type": "application/json" },
      body: "{}",
    });
    const local = {
      DATABASE_PROVIDER: "turso",
      TURSO_DATABASE_URL: "file:.local/mock-settlement.db",
      STORAGE_PROVIDER: "mock",
      LOCAL_TEST_MODE: "true",
      ENVIRONMENT: "local",
      PAYMENT_MODE: "mock",
      SEPAY_WEBHOOK_SECRET: secret,
      APP_ORIGIN: "https://crushify.test",
      VERCEL_ENV: "development",
    };

    const enabled = createVercelApiHandler(local, dependencies);
    const enabledResponse = await enabled(webhook());
    assert.equal(enabledResponse.status, 401, "a correctly configured local mock runtime reaches signature verification");
    assert.equal((await enabledResponse.json() as { error: { code: string } }).error.code,
      "INVALID_WEBHOOK_SIGNATURE");

    const remoteDatabase = createVercelApiHandler({
      ...local,
      TURSO_DATABASE_URL: "libsql://crushify-staging.invalid",
      TURSO_AUTH_TOKEN: "synthetic-test-only",
    }, dependencies);
    const remoteResponse = await remoteDatabase(webhook());
    assert.equal(remoteResponse.status, 503);
    assert.equal((await remoteResponse.json() as { error: { code: string } }).error.code,
      "PAYMENTS_DISABLED");

    const cloudStorage = createVercelApiHandler({
      ...local,
      STORAGE_PROVIDER: "cloudinary",
      CLOUDINARY_CLOUD_NAME: "hgtcizux",
      CLOUDINARY_API_KEY: "synthetic-test-only",
      CLOUDINARY_API_SECRET: "synthetic-test-only",
    }, dependencies);
    const cloudStorageResponse = await cloudStorage(webhook());
    assert.equal(cloudStorageResponse.status, 503);
    assert.equal((await cloudStorageResponse.json() as { error: { code: string } }).error.code,
      "PAYMENTS_DISABLED");

    const preview = createVercelApiHandler({
      ...local,
      DATABASE_PROVIDER: "turso",
      TURSO_DATABASE_URL: "libsql://crushify-staging.turso.io",
      TURSO_AUTH_TOKEN: "synthetic-test-only",
      STORAGE_PROVIDER: "cloudinary",
      CLOUDINARY_CLOUD_NAME: "hgtcizux",
      CLOUDINARY_API_KEY: "synthetic-test-only",
      CLOUDINARY_API_SECRET: "synthetic-test-only",
      ENVIRONMENT: "staging",
      VERCEL_ENV: "preview",
    }, dependencies);
    const previewResponse = await preview(webhook());
    assert.equal(previewResponse.status, 503);
    assert.equal((await previewResponse.json() as { error: { code: string } }).error.code,
      "PAYMENTS_DISABLED");

    const production = createVercelApiHandler({
      ...local,
      TURSO_DATABASE_URL: "https://production.invalid",
      TURSO_AUTH_TOKEN: "synthetic-test-only",
      STORAGE_PROVIDER: "cloudinary",
      CLOUDINARY_CLOUD_NAME: "hgtcizux",
      CLOUDINARY_API_KEY: "synthetic-test-only",
      CLOUDINARY_API_SECRET: "synthetic-test-only",
      ENVIRONMENT: "production",
      VERCEL_ENV: "production",
      VERCEL_PROJECT_PRODUCTION_URL: "crushify.test",
    }, dependencies);
    const productionResponse = await production(webhook());
    assert.equal(productionResponse.status, 503);
    assert.equal((await productionResponse.json() as { error: { code: string } }).error.code,
      "PAYMENTS_DISABLED");

    const nonLocal = createVercelApiHandler({
      ...local,
      ENVIRONMENT: "staging",
    }, dependencies);
    const nonLocalResponse = await nonLocal(webhook());
    assert.equal(nonLocalResponse.status, 500);
    assert.equal((await nonLocalResponse.json() as { error: { code: string } }).error.code,
      "RUNTIME_CONFIGURATION_ERROR");

    const noPrivilegedRoute = createVercelApiHandler(local, dependencies);
    const absentRoute = await noPrivilegedRoute(
      new Request("https://crushify.test/api/v1/payments/mock/settle"),
    );
    assert.equal(absentRoute.status, 404);
  });

  it("uses the stable project production origin when configured and rejects mismatched APP_ORIGIN", async () => {
    const productionHost = "crushify-n3l98mrkf-ltdc9divine-5816s-projects.vercel.app";
    const validHandler = createVercelApiHandler({
      DATABASE_PROVIDER: "turso",
      TURSO_DATABASE_URL: "https://example.turso.io",
      TURSO_AUTH_TOKEN: "secret-token",
      STORAGE_PROVIDER: "cloudinary",
      CLOUDINARY_CLOUD_NAME: "hgtcizux",
      CLOUDINARY_API_KEY: "key",
      CLOUDINARY_API_SECRET: "secret",
      APP_ORIGIN: `https://${productionHost}`,
      VERCEL_ENV: "production",
      VERCEL_PROJECT_PRODUCTION_URL: productionHost,
    });
    const validResponse = await validHandler(new Request(`https://${productionHost}/api/v1/customers/me`));
    assert.notEqual(validResponse.status, 500);
    assert.equal((await validResponse.text()).includes("RUNTIME_CONFIGURATION_ERROR"), false);

    const mismatchedHandler = createVercelApiHandler({
      DATABASE_PROVIDER: "turso",
      TURSO_DATABASE_URL: "https://example.turso.io",
      TURSO_AUTH_TOKEN: "secret-token",
      STORAGE_PROVIDER: "cloudinary",
      CLOUDINARY_CLOUD_NAME: "hgtcizux",
      CLOUDINARY_API_KEY: "key",
      CLOUDINARY_API_SECRET: "secret",
      APP_ORIGIN: "https://attacker.example",
      VERCEL_ENV: "production",
      VERCEL_PROJECT_PRODUCTION_URL: productionHost,
    });
    const mismatchedResponse = await mismatchedHandler(
      new Request("https://attacker.example/api/v1/customers/me"),
    );
    assert.equal(mismatchedResponse.status, 500);
    assert.equal((await mismatchedResponse.text()).includes("RUNTIME_CONFIGURATION_ERROR"), true);
  });

  it("runs the shared API contract on a local Turso file and local mock storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "crushify-vercel-runtime-"));
    const databasePath = join(directory, "vercel.db");
    const databaseUrl = pathToFileURL(databasePath).href;
    const migrationClient = createClient({ url: databaseUrl, intMode: "number" });
    const tokenQueue: string[] = [];
    const webhookSecret = randomBytes(32).toString("hex");
    const receivingAccount = "0000000000";
    let closeRuntimeDatabase = () => undefined;
    let databaseConnections = 0;
    const storage: Storage = new MemoryStorageAdapter();
    const handler = createVercelApiHandler({
      DATABASE_PROVIDER: "turso",
      TURSO_DATABASE_URL: databaseUrl,
      STORAGE_PROVIDER: "mock",
      LOCAL_TEST_MODE: "true",
      ENVIRONMENT: "local",
      PAYMENT_MODE: "mock",
      SEPAY_WEBHOOK_SECRET: webhookSecret,
      SEPAY_BANK_CODE: "MB",
      SEPAY_BANK_ACCOUNT: receivingAccount,
      SEPAY_ACCOUNT_NAME: "Crushify Test",
      APP_ORIGIN: "https://crushify.test",
      VERCEL_ENV: "development",
    }, {
      async connectDatabase(environment) {
        databaseConnections++;
        const connection = await connectDatabaseFromEnvironment(environment);
        closeRuntimeDatabase = connection.close;
        return connection;
      },
      createMockStorage: () => storage,
    });

    try {
      assert.deepEqual(await applyMigrations(migrationClient, await loadMigrations()), [1, 2, 3, 4, 5, 6, 7, 8]);
      const live = await handler(requestWithOrigin("/health/live", "https://crushify.test"));
      assert.equal(live.status, 200);
      const ready = await handler(requestWithOrigin("/health/ready", "https://crushify.test"));
      assert.equal(ready.status, 200);

      const preflight = await handler(new Request("https://crushify.test/api/v1/designs", {
        method: "OPTIONS",
        headers: {
          Origin: "https://crushify.test",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type,idempotency-key,x-csrf-token",
        },
      }));
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), "https://crushify.test");
      assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
      assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /idempotency-key/i);

      const deniedPreflight = await handler(new Request("https://crushify.test/api/v1/designs", {
        method: "OPTIONS",
        headers: {
          Origin: "https://attacker.example",
          "Access-Control-Request-Method": "POST",
        },
      }));
      assert.equal(deniedPreflight.status, 403);
      assert.equal(deniedPreflight.headers.get("access-control-allow-origin"), null);

      const wrongMethod = await handler(requestWithOrigin("/not-a-route", "https://crushify.test", {
        method: "GET",
      }));
      assert.equal(wrongMethod.status, 404);
      assert.equal(wrongMethod.headers.get("cache-control"), "no-store");
      assert.equal(wrongMethod.headers.get("x-content-type-options"), "nosniff");
      assert.equal(wrongMethod.headers.get("referrer-policy"), "no-referrer");
      assert.equal(wrongMethod.headers.get("x-frame-options"), "DENY");

      const removedStagingRoute = await handler(new Request("https://crushify.test/api/ops/staging"));
      assert.equal(removedStagingRoute.status, 404);

      const originalInfo = console.info;
      console.info = (message?: unknown, details?: unknown, ...extra: unknown[]) => {
        if (message === "Local-only Crushify magic link" && details && typeof details === "object" &&
            "text" in details && typeof details.text === "string") {
          const token = details.text.match(/#magic_token=([A-Za-z0-9_-]+)/)?.[1];
          if (token) tokenQueue.push(token);
          return;
        }
        originalInfo(message, details, ...extra);
      };
      try {
        const contract = await runDatabaseContract({
          request: async (path: string, session?: { cookies: string[]; csrf: string }, options = {}) => {
            const settings = options as {
              method?: string;
              mutating?: boolean;
              json?: unknown;
              token?: string;
              headers?: HeadersInit;
              body?: BodyInit;
            };
            const headers = new Headers(settings.headers);
            if (session?.cookies.length) headers.set("Cookie", session.cookies.join("; "));
            if (settings.mutating ||
                ["POST", "PUT", "PATCH", "DELETE"].includes(settings.method ?? "")) {
              headers.set("Origin", "https://crushify.test");
              if (session?.csrf) headers.set("X-CSRF-Token", session.csrf);
            }
            if (settings.json !== undefined) headers.set("Content-Type", "application/json");
            if (settings.token) headers.set("Authorization", `Bearer ${settings.token}`);
            if (path === "/customers/session" || path === "/customers/session/verify") {
              headers.set("x-vercel-forwarded-for", "198.51.100.40");
            }
            const response = await handler(new Request(`https://crushify.test/api/v1${path}`, {
              method: settings.method ?? "GET",
              headers,
              body: settings.json === undefined ? settings.body : JSON.stringify(settings.json),
            }));
            const body = response.status === 204 ||
              !response.headers.get("content-type")?.includes("application/json")
              ? null
              : await response.json();
            return { response, body };
          },
          getMagicToken: async () => {
            const token = tokenQueue.shift();
            assert.ok(token, "Vercel local-test email should capture a magic link token");
            return token;
          },
          label: "Vercel adapter + Turso local file + mock storage",
        });
        await runPaymentContract({
          request: async (path: string, session?: { cookies: string[]; csrf: string }, options = {}) => {
            const settings = options as {
              method?: string;
              mutating?: boolean;
              json?: unknown;
              token?: string;
              headers?: HeadersInit;
              body?: BodyInit;
            };
            const headers = new Headers(settings.headers);
            if (session?.cookies.length) headers.set("Cookie", session.cookies.join("; "));
            if (settings.token) headers.set("Authorization", `Bearer ${settings.token}`);
            if (settings.mutating ||
                ["POST", "PUT", "PATCH", "DELETE"].includes(settings.method ?? "")) {
              headers.set("Origin", "https://crushify.test");
              if (session?.csrf) headers.set("X-CSRF-Token", session.csrf);
            }
            if (settings.json !== undefined) headers.set("Content-Type", "application/json");
            const response = await handler(new Request(`https://crushify.test/api/v1${path}`, {
              method: settings.method ?? "GET",
              headers,
              body: settings.json === undefined ? settings.body : JSON.stringify(settings.json),
            }));
            const body = response.status === 204 ||
              !response.headers.get("content-type")?.includes("application/json")
              ? null
              : await response.json();
            return { response, body };
          },
          async seedPrice(amount) {
            const versions = await migrationClient.execute(
              `SELECT t.id AS template_id, t.current_schema_version AS schema_version
               FROM templates t
               JOIN template_versions v ON v.template_id = t.id
                 AND v.schema_version = t.current_schema_version AND v.status = 'ACTIVE'
               WHERE t.status = 'ACTIVE' ORDER BY t.id`,
            );
            for (const version of versions.rows) {
              await migrationClient.execute({
                sql: `INSERT INTO template_prices (
                  id, template_id, schema_version, currency, amount_minor, is_active, created_at, updated_at
                ) VALUES (?, ?, ?, 'VND', ?, 1, ?, ?)`,
                args: [
                  `test-price-${crypto.randomUUID()}`,
                  String(version.template_id),
                  Number(version.schema_version),
                  amount,
                  new Date().toISOString(),
                  new Date().toISOString(),
                ],
              });
            }
            for (const [planId, priceId] of [
              ["1-month", "test-storage-price-1"],
              ["3-months", "test-storage-price-3"],
              ["6-months", "test-storage-price-6"],
              ["12-months", "test-storage-price-12"],
              ["lifetime", "test-storage-price-life"],
            ]) {
              await migrationClient.execute({
                sql: `INSERT INTO storage_plan_prices (
                  id, storage_plan_id, currency, amount_minor, is_active, created_at, updated_at
                ) VALUES (?, ?, 'VND', 1000, 1, ?, ?)`,
                args: [priceId, planId, new Date().toISOString(), new Date().toISOString()],
              });
            }
          },
          owner: contract.owner,
          otherOwner: contract.other,
          designId: contract.designId,
          webhookSecret,
          receivingAccount,
          async cancelOrder(orderId: string) {
            await migrationClient.batch([
              {
                sql: "UPDATE orders SET status = 'CANCELLED' WHERE id = ?",
                args: [orderId],
              },
              {
                sql: "UPDATE payments SET status = 'CANCELLED' WHERE order_id = ? AND status = 'PENDING'",
                args: [orderId],
              },
            ], "write");
          },
          async expireOrder(orderId: string) {
            await migrationClient.execute({
              sql: "UPDATE orders SET expires_at = ? WHERE id = ?",
              args: ["2000-01-01T00:00:00.000Z", orderId],
            });
          },
          async inspectWebhookOutcomes(transactionIds: string[]) {
            const result = await migrationClient.execute({
              sql: `SELECT outcome FROM payment_webhook_events
                WHERE provider = 'SEPAY' AND event_id IN (?, ?)`,
              args: transactionIds,
            });
            return result.rows.map((row) => String(row.outcome));
          },
          async inspectWebhookEvent(transactionId: string) {
            const result = await migrationClient.execute({
              sql: `SELECT outcome, review_reason, processing_attempts, provider_transaction_id,
                    order_reference, expected_amount_minor, actual_amount_minor
                FROM payment_webhook_events WHERE provider = 'SEPAY' AND event_id = ?`,
              args: [transactionId],
            });
            assert.equal(result.rows.length, 1);
            return result.rows[0];
          },
          async setPublicationExpiry(publicationId: string, expiresAt: string) {
            await migrationClient.batch([
              {
                sql: "UPDATE publications SET expires_at = ? WHERE id = ?",
                args: [expiresAt, publicationId],
              },
              {
                sql: `UPDATE storage_entitlements SET expires_at = ?, status = 'ACTIVE'
                      WHERE publication_id = ? AND status IN ('ACTIVE','EXPIRED')`,
                args: [expiresAt, publicationId],
              },
            ], "write");
          },
          async deactivateTemplatePrice() {
            await migrationClient.execute(
              "UPDATE template_prices SET is_active = 0 WHERE template_id = 'our-universe' AND schema_version = 1",
            );
          },
          async inspectEntitlement(orderId: string) {
            const result = await migrationClient.execute({
              sql: `SELECT activated_at, starts_at, previous_expires_at, expires_at, status
                    FROM storage_entitlements WHERE order_id = ?`,
              args: [orderId],
            });
            assert.equal(result.rows.length, 1);
            return result.rows[0];
          },
          async inspectOrderArtifacts(orderId: string) {
            const result = await migrationClient.execute({
              sql: `SELECT
                (SELECT COUNT(*) FROM payments WHERE order_id = ?) AS payments,
                (SELECT COUNT(*) FROM payment_webhook_events e
                 JOIN payments p ON p.provider = e.provider AND p.provider_payment_id = e.event_id
                 WHERE p.order_id = ? AND e.outcome = 'PROCESSED') AS processed_events,
                (SELECT COUNT(*) FROM publications WHERE order_id = ?) AS publications,
                (SELECT COUNT(*) FROM storage_entitlements WHERE order_id = ?) AS entitlements,
                (SELECT COUNT(*) FROM fulfillment_jobs WHERE order_id = ?) AS fulfillment_jobs,
                (SELECT COUNT(*) FROM fulfillment_jobs WHERE order_id = ? AND status = 'FAILED') AS failed_jobs`,
              args: [orderId, orderId, orderId, orderId, orderId, orderId],
            });
            const row = result.rows[0]!;
            return {
              payments: Number(row.payments),
              processedEvents: Number(row.processed_events),
              publications: Number(row.publications),
              entitlements: Number(row.entitlements),
              fulfillmentJobs: Number(row.fulfillment_jobs),
              ...(Number(row.failed_jobs) ? { failedJobs: Number(row.failed_jobs) } : {}),
            };
          },
          async setPaymentCurrency(orderId: string, currency: string) {
            await migrationClient.execute({
              sql: "UPDATE payments SET currency = ? WHERE order_id = ?",
              args: [currency, orderId],
            });
          },
          async restorePaymentCurrency(orderId: string) {
            await migrationClient.execute({
              sql: "UPDATE payments SET currency = 'VND' WHERE order_id = ?",
              args: [orderId],
            });
          },
          async failPublicationCreation(orderId: string) {
            await migrationClient.execute(
              `CREATE TRIGGER reject_test_publication_creation BEFORE INSERT ON publications
               WHEN NEW.order_id = '${orderId}'
               BEGIN SELECT RAISE(ABORT, 'forced publication creation failure'); END`,
            );
          },
          async restorePublicationCreation() {
            await migrationClient.execute("DROP TRIGGER reject_test_publication_creation");
          },
          async recoverFulfillments() {
            return recoverPendingFulfillments({
              DB: new TursoDatabaseAdapter(migrationClient),
              STORAGE: storage,
              ENVIRONMENT: "local",
              APP_ORIGIN: "https://crushify.test",
            });
          },
          async failOrderPayment(orderId: string) {
            await migrationClient.execute(
              `CREATE TRIGGER reject_test_order_paid BEFORE UPDATE OF status ON orders
               WHEN NEW.id = '${orderId}' AND NEW.status = 'PAID'
               BEGIN SELECT RAISE(ABORT, 'forced payment transaction failure'); END`,
            );
          },
          async restoreOrderPayment() {
            await migrationClient.execute("DROP TRIGGER reject_test_order_paid");
          },
          allTemplates: true,
          expectedMode: "mock",
          label: "Vercel adapter + local mock settlement",
        });
        const uploadDesign = await handler(requestWithOrigin("/designs", "https://crushify.test", {
          method: "POST",
          headers: {
            Cookie: contract.owner.cookies.join("; "),
            "X-CSRF-Token": contract.owner.csrf,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ template_id: "our-universe", schema_version: 1 }),
        }));
        assert.equal(uploadDesign.status, 201);
        const uploadGrant = await handler(requestWithOrigin("/assets/upload-url", "https://crushify.test", {
          method: "POST",
          headers: {
            Cookie: contract.owner.cookies.join("; "),
            "X-CSRF-Token": contract.owner.csrf,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            design_id: (await uploadDesign.json() as { design_id: string }).design_id,
            media_type: "image/png",
            size: 1,
          }),
        }));
        assert.equal(uploadGrant.status, 201);
        assert.equal((await uploadGrant.json() as { max_bytes: number }).max_bytes, VERCEL_UPLOAD_MAX_BYTES);
      } finally {
        console.info = originalInfo;
      }

      assert.equal(databaseConnections, 1, "warm runtime should reuse its Turso connection");
      assert.equal(VERCEL_UPLOAD_MAX_BYTES, 4 * 1024 * 1024);
    } finally {
      closeRuntimeDatabase();
      migrationClient.close();
      if (process.platform === "win32") {
        const cleanup = spawn(
          process.execPath,
          [
            "-e",
            "const fs=require('node:fs');setTimeout(()=>fs.rmSync(process.argv[1],{recursive:true,force:true}),3000)",
            directory,
          ],
          { detached: true, stdio: "ignore", windowsHide: true },
        );
        cleanup.unref();
      } else {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("fails closed for missing providers and does not expose connection details", async () => {
    let connectCalls = 0;
    const missingDatabase = createVercelApiHandler({
      DATABASE_PROVIDER: "turso",
      STORAGE_PROVIDER: "mock",
      LOCAL_TEST_MODE: "true",
      APP_ORIGIN: "https://crushify.test",
      VERCEL_ENV: "development",
    }, {
      async connectDatabase() {
        connectCalls++;
        throw new Error("should not be called");
      },
    });
    const databaseResponse = await missingDatabase(
      new Request("https://crushify.test/api/v1/customers/me"),
    );
    assert.equal(databaseResponse.status, 500);
    assert.equal((await databaseResponse.text()).includes("should not be called"), false);

    const missingStorage = createVercelApiHandler({
      DATABASE_PROVIDER: "turso",
      TURSO_DATABASE_URL: "file:local.db",
      STORAGE_PROVIDER: "cloudinary",
      APP_ORIGIN: "https://crushify.test",
      VERCEL_ENV: "development",
    }, {
      async connectDatabase() {
        connectCalls++;
        throw new Error("should not be called");
      },
    });
    const storageResponse = await missingStorage(
      new Request("https://crushify.test/api/v1/customers/me"),
    );
    assert.equal(storageResponse.status, 500);
    assert.equal((await storageResponse.text()).includes("should not be called"), false);
    assert.equal(connectCalls, 0);

    const previewFileDatabase = createVercelApiHandler({
      DATABASE_PROVIDER: "turso",
      TURSO_DATABASE_URL: "file:local.db",
      STORAGE_PROVIDER: "cloudinary",
      CLOUDINARY_CLOUD_NAME: "cloud",
      CLOUDINARY_API_KEY: "key",
      CLOUDINARY_API_SECRET: "secret",
      VERCEL_ENV: "preview",
      VERCEL_URL: "preview-crushify.vercel.app",
    });
    const previewResponse = await previewFileDatabase(
      new Request("https://crushify.test/api/v1/customers/me"),
    );
    assert.equal(previewResponse.status, 500, "deployed Vercel environments must not use file databases");
  });

  it("preserves API cookies and request routing through the Vercel Node adapter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "crushify-vercel-http-"));
    const databasePath = join(directory, "http.db");
    const databaseUrl = pathToFileURL(databasePath).href;
    const migrationClient = createClient({ url: databaseUrl, intMode: "number" });
    const envNames = [
      "DATABASE_PROVIDER",
      "TURSO_DATABASE_URL",
      "TURSO_AUTH_TOKEN",
      "STORAGE_PROVIDER",
      "LOCAL_TEST_MODE",
      "APP_ORIGIN",
      "VERCEL_ENV",
      "VERCEL_URL",
    ];
    const originalEnvironment = new Map(envNames.map((name) => [name, process.env[name]]));
    const tokenQueue: string[] = [];
    const server = createServer((request, response) => {
      void nodeHandler(request, response);
    });

    try {
      assert.deepEqual(await applyMigrations(migrationClient, await loadMigrations()), [1, 2, 3, 4, 5, 6, 7, 8]);
      process.env.DATABASE_PROVIDER = "turso";
      process.env.TURSO_DATABASE_URL = databaseUrl;
      process.env.TURSO_AUTH_TOKEN = "";
      process.env.STORAGE_PROVIDER = "mock";
      process.env.LOCAL_TEST_MODE = "true";
      process.env.VERCEL_ENV = "development";
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${address.port}`;
      process.env.APP_ORIGIN = origin;

      const originalInfo = console.info;
      console.info = (message?: unknown, details?: unknown, ...extra: unknown[]) => {
        if (message === "Local-only Crushify magic link" && details && typeof details === "object" &&
            "text" in details && typeof details.text === "string") {
          const token = details.text.match(/#magic_token=([A-Za-z0-9_-]+)/)?.[1];
          if (token) tokenQueue.push(token);
          return;
        }
        originalInfo(message, details, ...extra);
      };
      try {
        const baseUrl = origin;
        const request = async (path: string, session?: { cookies: string[]; csrf: string }, options = {}) => {
          const settings = options as {
            method?: string;
            mutating?: boolean;
            json?: unknown;
            token?: string;
            headers?: HeadersInit;
            body?: BodyInit;
          };
          const headers = new Headers(settings.headers);
          if (session?.cookies.length) headers.set("Cookie", session.cookies.join("; "));
          if (settings.mutating ||
              ["POST", "PUT", "PATCH", "DELETE"].includes(settings.method ?? "")) {
            headers.set("Origin", origin);
            if (session?.csrf) headers.set("X-CSRF-Token", session.csrf);
          }
          if (settings.json !== undefined) headers.set("Content-Type", "application/json");
          if (settings.token) headers.set("Authorization", `Bearer ${settings.token}`);
          if (path === "/customers/session" || path === "/customers/session/verify") {
            headers.set("x-vercel-forwarded-for", "198.51.100.41");
          }
          const response = await fetch(`${baseUrl}/api/v1${path}`, {
            method: settings.method ?? "GET",
            headers,
            body: settings.json === undefined ? settings.body : JSON.stringify(settings.json),
          });
          const body = response.status === 204 ||
            !response.headers.get("content-type")?.includes("application/json")
            ? null
            : await response.json();
          return { response, body };
        };
        const live = await fetch(`${baseUrl}/api/v1/health/live`);
        assert.equal(live.status, 200);
        const unsupported = await fetch(`${baseUrl}/api/v1/health/live`, { method: "HEAD" });
        assert.equal(unsupported.status, 405);

        await runDatabaseContract({
          request,
          getMagicToken: async () => {
            const token = tokenQueue.shift();
            assert.ok(token, "Vercel local-test email should capture a magic link token");
            return token;
          },
          label: "Vercel Node adapter + Turso local file + mock storage",
        });
      } finally {
        console.info = originalInfo;
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const [name, value] of originalEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      migrationClient.close();
      if (process.platform === "win32") {
        const cleanup = spawn(
          process.execPath,
          [
            "-e",
            "const fs=require('node:fs');setTimeout(()=>fs.rmSync(process.argv[1],{recursive:true,force:true}),3000)",
            directory,
          ],
          { detached: true, stdio: "ignore", windowsHide: true },
        );
        cleanup.unref();
      } else {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("maps Turso connection errors to a safe 503 and retries a failed initialization", async () => {
    let attempts = 0;
    const handler = createVercelApiHandler({
      DATABASE_PROVIDER: "turso",
      TURSO_DATABASE_URL: "libsql://test.turso.io",
      TURSO_AUTH_TOKEN: "test-token",
      STORAGE_PROVIDER: "mock",
      LOCAL_TEST_MODE: "true",
      APP_ORIGIN: "https://crushify.test",
      VERCEL_ENV: "development",
    }, {
      async connectDatabase() {
        attempts++;
        throw new Error("connection failed with token secret-must-not-leak");
      },
    });
    const originalError = console.error;
    const logged: unknown[] = [];
    console.error = (...values: unknown[]) => logged.push(values);
    try {
      const first = await handler(new Request("https://crushify.test/api/v1/customers/me"));
      const second = await handler(new Request("https://crushify.test/api/v1/customers/me"));
      assert.equal(first.status, 503);
      assert.equal(second.status, 503);
      assert.equal((await first.text()).includes("secret-must-not-leak"), false);
      assert.equal(attempts, 2);
      assert.equal(JSON.stringify(logged).includes("secret-must-not-leak"), false);
    } finally {
      console.error = originalError;
    }
  });

  it("bounds and times out incoming Node request bodies", async () => {
    const validBody = ReadableRequest([Buffer.from("safe")]);
    assert.equal(Buffer.from(await readVercelRequestBody(validBody, 8)).toString(), "safe");

    const oversized = ReadableRequest([Buffer.alloc(9)]);
    await assert.rejects(readVercelRequestBody(oversized, 8), /too large/);

    const stalled = ReadableRequest([]);
    try {
      await assert.rejects(readVercelRequestBody(stalled, 8, 10), /timed out/);
    } finally {
      stalled.destroy();
    }
  });
});

function ReadableRequest(chunks: Buffer[]): IncomingMessage {
  const request = new PassThrough();
  queueMicrotask(() => {
    for (const chunk of chunks) request.write(chunk);
    if (chunks.length > 0) request.end();
  });
  return request as IncomingMessage;
}

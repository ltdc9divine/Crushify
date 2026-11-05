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
import { connectDatabaseFromEnvironment } from "../src/database/provider.ts";
import type { Storage } from "../src/storage.ts";
import { MemoryStorageAdapter } from "../src/storage/mock.ts";
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
      PAYMENT_MODE: "mock",
      SEPAY_WEBHOOK_SECRET: webhookSecret,
      SEPAY_BANK_ACCOUNT: receivingAccount,
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
      assert.deepEqual(await applyMigrations(migrationClient, await loadMigrations()), [1, 2, 3]);
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
            await migrationClient.execute({
              sql: `INSERT INTO template_prices (
                id, template_id, schema_version, currency, amount_minor, is_active, created_at, updated_at
              ) VALUES (?, 'our-universe', 1, 'VND', ?, 1, ?, ?)`,
              args: [`test-price-${crypto.randomUUID()}`, amount, new Date().toISOString(), new Date().toISOString()],
            });
          },
          owner: contract.owner,
          designId: contract.designId,
          webhookSecret,
          receivingAccount,
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
          label: "Vercel adapter + Turso local file + mock storage",
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
      assert.deepEqual(await applyMigrations(migrationClient, await loadMigrations()), [1, 2, 3]);
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

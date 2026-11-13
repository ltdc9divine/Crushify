import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createClient } from "@libsql/client";
import { applyMigrations, type SqlMigration } from "../src/database/migrations.ts";
import { TursoDatabaseAdapter } from "../src/database/turso.ts";
import { MemoryStorageAdapter } from "../src/storage/mock.ts";
import type { Env } from "../src/types.ts";
import {
  acquireScheduledTaskLease,
  runScheduledPublicationLifecycle,
} from "../src/scheduler.ts";
import { createVercelApiHandler } from "../src/platform/vercel.ts";

async function loadMigrations(): Promise<SqlMigration[]> {
  const directory = join(process.cwd(), "migrations");
  const files = (await readdir(directory))
    .filter((file) => file.toLowerCase().endsWith(".sql"))
    .sort();
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

async function createDatabase() {
  const client = createClient({ url: "file::memory:", intMode: "number" });
  await applyMigrations(client, await loadMigrations());
  return { client, database: new TursoDatabaseAdapter(client) };
}

describe("Vercel scheduled publication lifecycle", () => {
  it("fails closed when the Cron secret or required providers are missing", async () => {
    const { client, database } = await createDatabase();
    const secret = "local-synthetic-cron-secret-with-sufficient-length";
    const stagingSecret = "c".repeat(64);
    let connections = 0;
    const dependencies = {
      async connectDatabase() {
        connections++;
        return { database, close: () => undefined };
      },
      createCloudinaryStorage: () => new MemoryStorageAdapter(),
    };
    const baseEnvironment = {
      DATABASE_PROVIDER: "turso",
      TURSO_DATABASE_URL: "libsql://crushify-production-test-org.turso.io",
      TURSO_AUTH_TOKEN: "synthetic-token",
      STORAGE_PROVIDER: "cloudinary",
      CLOUDINARY_CLOUD_NAME: "crushify-production-test",
      CLOUDINARY_API_KEY: "synthetic-api-key",
      CLOUDINARY_API_SECRET: "synthetic-api-secret",
      ENVIRONMENT: "production",
      VERCEL_ENV: "production",
      VERCEL_PROJECT_PRODUCTION_URL: "crushify.test",
      CRON_SECRET: secret,
    };
    const request = (authorization = `Bearer ${secret}`) => new Request(
      "https://crushify.test/api/cron/publication-lifecycle",
      { headers: { Authorization: authorization } },
    );
    try {
      const missingSecret = createVercelApiHandler({
        ...baseEnvironment,
        CRON_SECRET: undefined,
      }, dependencies);
      assert.equal((await missingSecret(request())).status, 401);
      assert.equal(connections, 0);

      const shortSecret = createVercelApiHandler({
        ...baseEnvironment,
        CRON_SECRET: "too-short",
      }, dependencies);
      assert.equal((await shortSecret(request("Bearer too-short"))).status, 401);
      assert.equal(connections, 0);

      const stagingSecretOnly = createVercelApiHandler({
        ...baseEnvironment,
        CRON_SECRET: undefined,
        STAGING_LIFECYCLE_SECRET: stagingSecret,
      }, dependencies);
      assert.equal((await stagingSecretOnly(request(`Bearer ${stagingSecret}`))).status, 401);
      assert.equal(connections, 0);

      const missingDatabase = createVercelApiHandler({
        ...baseEnvironment,
        TURSO_DATABASE_URL: undefined,
      }, dependencies);
      const databaseResponse = await missingDatabase(request());
      assert.equal(databaseResponse.status, 500);
      assert.equal(
        (await databaseResponse.json() as { error: { code: string } }).error.code,
        "DATABASE_CONFIGURATION_ERROR",
      );
      assert.equal(connections, 0);

      const missingStorage = createVercelApiHandler({
        ...baseEnvironment,
        STORAGE_PROVIDER: undefined,
      }, dependencies);
      const storageResponse = await missingStorage(request());
      assert.equal(storageResponse.status, 500);
      assert.equal(
        (await storageResponse.json() as { error: { code: string } }).error.code,
        "STORAGE_CONFIGURATION_ERROR",
      );
      assert.equal(connections, 0);
    } finally {
      client.close();
    }
  });

  it("keeps Vercel Cron as the only configured automatic lifecycle scheduler", async () => {
    const vercel = JSON.parse(await readFile(join(process.cwd(), "vercel.json"), "utf8")) as {
      crons?: unknown[];
    };
    assert.deepEqual(vercel.crons, [
      { path: "/api/cron/publication-lifecycle", schedule: "0 3 * * *" },
    ]);

    for (const file of ["wrangler.jsonc", "wrangler.staging.jsonc"]) {
      const config = JSON.parse(await readFile(join(process.cwd(), file), "utf8")) as {
        triggers?: { crons?: unknown[] };
      };
      assert.equal(config.triggers?.crons, undefined, `${file} must not schedule duplicate lifecycle work`);
    }
  });

  it("uses a persistent exclusive lease and records successful idempotent runs", async () => {
    const { client, database } = await createDatabase();
    const now = new Date("2027-01-02T03:04:05.000Z");
    const env: Env = {
      DB: database,
      STORAGE: new MemoryStorageAdapter(),
      ENVIRONMENT: "staging",
    };
    try {
      const firstToken = await acquireScheduledTaskLease(env, now, "first-lease");
      assert.equal(firstToken, "first-lease");
      assert.equal(await acquireScheduledTaskLease(env, now, "overlapping-lease"), null);
      assert.equal(
        await acquireScheduledTaskLease(
          env,
          new Date(now.getTime() + 5 * 60 * 1000),
          "expired-lease",
        ),
        "expired-lease",
      );

      const runNow = new Date(now.getTime() + 10 * 60 * 1000);
      const first = await runScheduledPublicationLifecycle(env, { now: runNow, limit: 10 });
      assert.deepEqual(first, { acquired: true, expired: 0, erased: 0, retryable: 0 });
      const second = await runScheduledPublicationLifecycle(env, { now: runNow, limit: 10 });
      assert.deepEqual(second, { acquired: true, expired: 0, erased: 0, retryable: 0 });

      const competingLeases = await Promise.all([
        acquireScheduledTaskLease(env, new Date(now.getTime() + 20 * 60 * 1000), "parallel-one"),
        acquireScheduledTaskLease(env, new Date(now.getTime() + 20 * 60 * 1000), "parallel-two"),
      ]);
      assert.equal(competingLeases.filter(Boolean).length, 1);

      const runs = await database.prepare(
        "SELECT status, result_json FROM scheduled_task_runs ORDER BY started_at, id",
      ).all<{ status: string; result_json: string }>();
      assert.equal(runs.results.length, 2);
      assert.ok(runs.results.every((run) => run.status === "COMPLETED"));
      assert.ok(runs.results.every((run) => JSON.parse(run.result_json).expired === 0));
    } finally {
      client.close();
    }
  });

  it("requires durable Preview storage before running the manual lifecycle route", async () => {
    const { client, database } = await createDatabase();
    const secret = "a".repeat(64);
    const cronSecret = "b".repeat(64);
    let connections = 0;
    let storageCreations = 0;
    const environment = {
      DATABASE_PROVIDER: "turso",
      TURSO_STAGING_DATABASE_URL: "libsql://crushify-staging-test-org.turso.io",
      TURSO_STAGING_AUTH_TOKEN: "synthetic-token",
      STORAGE_PROVIDER: "mock",
      ENVIRONMENT: "staging",
      VERCEL_ENV: "preview",
      APP_ORIGIN: "https://crushify-staging.vercel.app",
      VERCEL_URL: "crushify-staging.vercel.app",
      CRON_SECRET: cronSecret,
      STAGING_LIFECYCLE_SECRET: secret,
    };
    const dependencies = {
      async connectDatabase() {
        connections++;
        return { database, close: () => undefined };
      },
      createMockStorage() {
        storageCreations++;
        return new MemoryStorageAdapter();
      },
    };
    const handler = createVercelApiHandler(environment, dependencies);
    const createScopedHandler = (overrides: Partial<typeof environment>) =>
      createVercelApiHandler({ ...environment, ...overrides }, dependencies);
    const url = "https://crushify-staging.vercel.app/api/ops/staging/publication-lifecycle";
    const authorizedRequest = (
      requestUrl = url,
      body?: string,
      authorization = `Bearer ${secret}`,
      method = "POST",
    ) => new Request(requestUrl, {
      method,
      headers: { Authorization: authorization },
      ...(body === undefined ? {} : { body }),
    });
    try {
      const unauthorized = await handler(
        new Request(url, { method: "POST" }),
      );
      assert.equal(unauthorized.status, 401);
      assert.equal(connections, 0);
      assert.equal(storageCreations, 0);

      const failures = [
        await createScopedHandler({ STAGING_LIFECYCLE_SECRET: undefined })(
          authorizedRequest(url, undefined, `Bearer ${cronSecret}`),
        ),
        await createScopedHandler({ STAGING_LIFECYCLE_SECRET: undefined })(
          authorizedRequest(url),
        ),
        await handler(authorizedRequest(url, undefined, `Bearer ${"c".repeat(64)}`)),
        await createScopedHandler({ STAGING_LIFECYCLE_SECRET: "" })(authorizedRequest()),
        await createScopedHandler({ STAGING_LIFECYCLE_SECRET: "short" })(
          authorizedRequest(url, undefined, "Bearer short"),
        ),
        await createScopedHandler({ STAGING_LIFECYCLE_SECRET: `${secret.slice(0, 63)}!` })(
          authorizedRequest(url, undefined, `Bearer ${secret.slice(0, 63)}!`),
        ),
      ];
      const failureBodies = await Promise.all(failures.map(async (response) => {
        assert.equal(response.status, 401);
        const body = await response.json() as { error: { code: string; message: string } };
        return { code: body.error.code, message: body.error.message };
      }));
      assert.ok(failureBodies.every((body) => body.code === "UNAUTHENTICATED"));
      assert.ok(failureBodies.every((body) => body.message === failureBodies[0]?.message));
      assert.equal(connections, 0);
      assert.equal(storageCreations, 0);

      const bodyCannotAuthorize = await handler(new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authorization: `Bearer ${secret}` }),
      }));
      const queryCannotAuthorize = await handler(new Request(
        `${url}?authorization=${encodeURIComponent(`Bearer ${secret}`)}`,
        { method: "POST" },
      ));
      assert.equal(bodyCannotAuthorize.status, 401);
      assert.equal(queryCannotAuthorize.status, 401);

      for (const method of ["GET", "PUT"]) {
        assert.equal((await handler(authorizedRequest(url, undefined, `Bearer ${secret}`, method))).status, 405);
      }

      const withBody = await handler(authorizedRequest(url, '{"limit":1000,"environment":"production"}'));
      assert.equal(withBody.status, 400);
      const withQuery = await handler(authorizedRequest(`${url}?limit=1000&environment=production`));
      assert.equal(withQuery.status, 400);
      assert.equal(connections, 0);
      assert.equal(storageCreations, 0);

      const authorized = await handler(authorizedRequest());
      assert.equal(authorized.status, 503);
      assert.equal(
        (await authorized.json() as { error: { code: string } }).error.code,
        "STORAGE_UNAVAILABLE",
      );
      assert.equal(connections, 0);
      assert.equal(storageCreations, 0);

      const sharedCronPath = await handler(new Request(
        "https://crushify-staging.vercel.app/api/cron/publication-lifecycle",
        { headers: { Authorization: `Bearer ${cronSecret}` } },
      ));
      assert.equal(sharedCronPath.status, 404);
      assert.equal(connections, 0);
      assert.equal(storageCreations, 0);

      const previewWithProductionCredentials = createVercelApiHandler({
        ...environment,
        TURSO_DATABASE_URL: "libsql://crushify-production.example.turso.io",
        TURSO_AUTH_TOKEN: "synthetic-production-token",
        CLOUDINARY_CLOUD_NAME: "production-cloud",
        CLOUDINARY_API_KEY: "synthetic-production-key",
        CLOUDINARY_API_SECRET: "synthetic-production-secret",
      }, {
        async connectDatabase() {
          connections++;
          return { database, close: () => undefined };
        },
      });
      const rejectedProductionCredentials = await previewWithProductionCredentials(new Request(
        url,
        { method: "POST", headers: { Authorization: `Bearer ${secret}` } },
      ));
      assert.equal(rejectedProductionCredentials.status, 500);
      assert.equal(
        (await rejectedProductionCredentials.json() as { error: { code: string } }).error.code,
        "RUNTIME_CONFIGURATION_ERROR",
      );
      assert.equal(connections, 0);
      assert.equal(storageCreations, 0);

      for (const otherScope of [
        { ENVIRONMENT: "production", VERCEL_ENV: "production" },
        { ENVIRONMENT: "local", VERCEL_ENV: "development" },
        { ENVIRONMENT: "staging", VERCEL_ENV: "unknown" },
      ]) {
        const rejectedScope = createVercelApiHandler({
          ...environment,
          ...otherScope,
        }, {
          async connectDatabase() {
            connections++;
            return { database, close: () => undefined };
          },
        });
        const hidden = await rejectedScope(authorizedRequest());
        assert.equal(hidden.status, 404);
        assert.equal(connections, 0);
        assert.equal(storageCreations, 0);
      }
    } finally {
      client.close();
    }
  });
});

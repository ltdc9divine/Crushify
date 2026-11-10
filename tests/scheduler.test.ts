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

  it("protects the staging lifecycle route with CRON_SECRET and rejects non-staging deployments", async () => {
    const { client, database } = await createDatabase();
    const secret = "local-test-cron-secret-32-characters";
    let connections = 0;
    const environment = {
      DATABASE_PROVIDER: "turso",
      TURSO_STAGING_DATABASE_URL: "libsql://crushify-staging-test-org.turso.io",
      TURSO_STAGING_AUTH_TOKEN: "synthetic-token",
      STORAGE_PROVIDER: "cloudinary",
      CLOUDINARY_STAGING_CLOUD_NAME: "crushify-staging-free",
      CLOUDINARY_STAGING_API_KEY: "synthetic-api-key",
      CLOUDINARY_STAGING_API_SECRET: "synthetic-api-secret",
      CLOUDINARY_STAGING_ISOLATED_ACCOUNT: "I_CONFIRM_SEPARATE_FREE_CLOUD",
      ENVIRONMENT: "staging",
      VERCEL_ENV: "preview",
      APP_ORIGIN: "https://crushify-staging.vercel.app",
      CRON_SECRET: secret,
    };
    const handler = createVercelApiHandler(environment, {
      async connectDatabase() {
        connections++;
        return { database, close: () => undefined };
      },
      createCloudinaryStorage: () => new MemoryStorageAdapter(),
    });
    try {
      const unauthorized = await handler(
        new Request("https://crushify-staging.vercel.app/api/cron/publication-lifecycle"),
      );
      assert.equal(unauthorized.status, 401);
      assert.equal(connections, 0);

      const authorized = await handler(new Request(
        "https://crushify-staging.vercel.app/api/cron/publication-lifecycle",
        { headers: { Authorization: `Bearer ${secret}` } },
      ));
      assert.equal(authorized.status, 200);
      assert.deepEqual(await authorized.json(), {
        acquired: true,
        expired: 0,
        erased: 0,
        retryable: 0,
      });
      assert.equal(connections, 1);

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
        "https://crushify-staging.vercel.app/api/cron/publication-lifecycle",
        { headers: { Authorization: "Bearer " + secret } },
      ));
      assert.equal(rejectedProductionCredentials.status, 500);
      assert.equal(
        (await rejectedProductionCredentials.json() as { error: { code: string } }).error.code,
        "RUNTIME_CONFIGURATION_ERROR",
      );
      assert.equal(connections, 1);

      const wrongEnvironment = createVercelApiHandler({
        ...environment,
        ENVIRONMENT: "production",
      }, {
        async connectDatabase() {
          connections++;
          return { database, close: () => undefined };
        },
      });
      const hidden = await wrongEnvironment(new Request(
        "https://crushify-staging.vercel.app/api/cron/publication-lifecycle",
        { headers: { Authorization: `Bearer ${secret}` } },
      ));
      assert.equal(hidden.status, 404);
      assert.equal(connections, 1);

      const stagingInProduction = createVercelApiHandler({
        ...environment,
        VERCEL_ENV: "production",
      }, {
        async connectDatabase() {
          connections++;
          return { database, close: () => undefined };
        },
      });
      const productionHidden = await stagingInProduction(new Request(
        "https://crushify-staging.vercel.app/api/cron/publication-lifecycle",
        { headers: { Authorization: "Bearer local-test-cron-secret-32-characters" } },
      ));
      assert.equal(productionHidden.status, 404);
      assert.equal(connections, 1);
    } finally {
      client.close();
    }
  });
});

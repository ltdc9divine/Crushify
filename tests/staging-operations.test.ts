import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createClient } from "@libsql/client";
import { applyMigrations, type SqlMigration } from "../src/database/migrations.ts";
import {
  executeStagingOperation,
  handleStagingOperationsRequest,
} from "../src/platform/staging-operations.ts";
import {
  createVercelApiHandler,
  type VercelEnvironment,
} from "../src/platform/vercel.ts";

const operationToken = randomBytes(32).toString("base64url");
const validEnvironment: VercelEnvironment = {
  VERCEL_ENV: "production",
  VERCEL_PROJECT_ID: "prj_nw874WiBWiUZlIjBzOFn6yG2CeHH",
  VERCEL_URL: "crushify.vercel.app",
  ENVIRONMENT: "staging",
  DATABASE_PROVIDER: "turso",
  TURSO_DATABASE_URL: "libsql://crushify-staging-test-org.turso.io",
  TURSO_AUTH_TOKEN: "synthetic-turso-token",
  STORAGE_PROVIDER: "cloudinary",
  CLOUDINARY_CLOUD_NAME: "hgtcizux",
  CLOUDINARY_API_KEY: "synthetic-cloudinary-key",
  CLOUDINARY_API_SECRET: "synthetic-cloudinary-secret",
  APP_ORIGIN: "https://crushify.vercel.app",
  STAGING_OPS_TOKEN: operationToken,
};

async function request(
  environment: VercelEnvironment,
  body: unknown,
  dependencies: Parameters<typeof handleStagingOperationsRequest>[2] = {},
  headers: HeadersInit = {},
): Promise<Response> {
  const requestHeaders = new Headers(headers);
  if (!requestHeaders.has("Authorization")) {
    requestHeaders.set("Authorization", `Bearer ${operationToken}`);
  }
  requestHeaders.set("Content-Type", "application/json");
  return handleStagingOperationsRequest(new Request("https://crushify.vercel.app/api/ops/staging", {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
  }), environment, dependencies);
}

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

async function withLocalDatabase(
  callback: (environment: VercelEnvironment) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "crushify-staging-ops-"));
  const url = new URL(`file:${join(directory, "ops.db").replaceAll("\\", "/")}`).toString();
  const environment: VercelEnvironment = {
    ...validEnvironment,
    TURSO_DATABASE_URL: url,
  };
  try {
    await callback(environment);
  } finally {
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
}

describe("restricted Vercel staging operations endpoint", () => {
  it("requires POST, a bearer token, and rejects browser-origin requests without CORS", async () => {
    let calls = 0;
    const dependencies = {
      async runOperation() {
        calls++;
        return { checks: [{ name: "TEST_OPERATION", status: "PASS" as const }] };
      },
    };
    const url = "https://crushify.vercel.app/api/ops/staging";
    const get = await handleStagingOperationsRequest(new Request(url), validEnvironment, dependencies);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get("cache-control"), "no-store");

    const missing = await handleStagingOperationsRequest(new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "environment-check" }),
    }), validEnvironment, dependencies);
    assert.equal(missing.status, 401);

    const missingConfiguredToken = await request(
      { ...validEnvironment, STAGING_OPS_TOKEN: undefined },
      { operation: "environment-check" },
      dependencies,
    );
    assert.equal(missingConfiguredToken.status, 401);

    const wrong = await request(validEnvironment, { operation: "environment-check" }, dependencies, {
      Authorization: `Bearer ${randomBytes(32).toString("base64url")}`,
    });
    assert.equal(wrong.status, 401);

    const browser = await request(validEnvironment, { operation: "environment-check" }, dependencies, {
      Origin: "https://attacker.example",
    });
    assert.equal(browser.status, 403);
    assert.equal(browser.headers.get("access-control-allow-origin"), null);
    assert.equal(calls, 0);
  });

  it("accepts only fixed operations and exact request shapes", async () => {
    const wrongContentType = await handleStagingOperationsRequest(new Request(
      "https://crushify.vercel.app/api/ops/staging",
      {
        method: "POST",
        headers: { Authorization: `******`, "Content-Type": "text/plain" },
        body: JSON.stringify({ operation: "status" }),
      },
    ), validEnvironment);
    assert.equal(wrongContentType.status, 415);

    const oversized = await request(validEnvironment, {
      operation: "status",
      extra: "x".repeat(4096),
    });
    assert.equal(oversized.status, 413);

    const arbitrarySql = await request(validEnvironment, {
      operation: "turso-smoke",
      sql: "DROP TABLE customers",
    });
    assert.equal(arbitrarySql.status, 400);
    const arbitraryOperation = await request(validEnvironment, {
      operation: "query",
    });
    assert.equal(arbitraryOperation.status, 400);
    const missingRegionAttestation = await request(validEnvironment, {
      operation: "turso-preflight",
    });
    assert.equal(missingRegionAttestation.status, 400);
    const accepted = await request(validEnvironment, {
      operation: "environment-check",
    }, {
      async runOperation() {
        return { checks: [{ name: "ENVIRONMENT", status: "PASS" }] };
      },
    });
    assert.equal(accepted.status, 200);
  });

  it("fails closed for production app mode, a different project, a wrong database host, and another Cloudinary cloud", async () => {
    for (const environment of [
      { ...validEnvironment, ENVIRONMENT: "production" },
      { ...validEnvironment, VERCEL_PROJECT_ID: "prj_other" },
      { ...validEnvironment, TURSO_DATABASE_URL: "libsql://other-db-test-org.turso.io" },
      { ...validEnvironment, CLOUDINARY_CLOUD_NAME: "another-cloud" },
    ]) {
      let called = false;
      const response = await request(environment, {
        operation: "turso-preflight",
        region_confirmation: "Singapore",
      }, {
        async runOperation() {
          called = true;
          return { checks: [{ name: "SHOULD_NOT_RUN", status: "PASS" }] };
        },
      }, { "Content-Type": "application/json" });
      assert.equal(response.status, 403);
      assert.equal(called, false);
    }

    const environmentCheck = await request({
      ...validEnvironment,
      CLOUDINARY_CLOUD_NAME: "another-cloud",
    }, { operation: "environment-check" });
    assert.equal(environmentCheck.status, 409);
    assert.match(await environmentCheck.text(), /CLOUDINARY_TEST_CONFIGURATION/);
  });

  it("returns only sanitized checks and operation identifiers", async () => {
    const response = await request(validEnvironment, { operation: "environment-check" });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /operation_id/);
    assert.doesNotMatch(body, /synthetic-turso-token|synthetic-cloudinary-secret|libsql:\/\//);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  });

  it("routes through the Vercel adapter without applying CORS", async () => {
    const handler = createVercelApiHandler(validEnvironment, {
      async runStagingOperation(_environment, operation) {
        return { checks: [{ name: operation === "status" ? "STATUS" : "OTHER", status: "PASS" }] };
      },
    });
    const response = await handler(new Request("https://crushify.vercel.app/api/ops/staging", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${operationToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ operation: "status" }),
    }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});

describe("staging database operation state", () => {
  it("requires a fresh preflight attestation before applying checksummed migrations", async () => {
    await withLocalDatabase(async (environment) => {
      const skipped = await executeStagingOperation(environment, "turso-migrate", null);
      assert.deepEqual(skipped.checks.map(({ status }) => status), ["FAIL"]);
      assert.equal(skipped.checks[0]?.name, "PREFLIGHT_ATTESTATION");

      const preflight = await executeStagingOperation(environment, "turso-preflight", null);
      assert.ok(preflight.preflight_id);
      assert.ok(preflight.checks
        .filter(({ name }) => name !== "TURSO_DATABASE_IDENTITY")
        .every(({ status }) => status === "PASS"), JSON.stringify(preflight.checks));
      assert.ok(preflight.checks.some(({ name, status }) =>
        name === "TURSO_DATABASE_IDENTITY" && status === "FAIL"));

      const invalid = await executeStagingOperation(environment, "turso-migrate", "invalid-ticket");
      assert.equal(invalid.checks[0]?.name, "PREFLIGHT_ATTESTATION");

      const migration = await executeStagingOperation(
        environment,
        "turso-migrate",
        preflight.preflight_id!,
      );
      assert.ok(migration.checks.every(({ status }) => status === "PASS"), JSON.stringify(migration.checks));
      assert.ok(migration.checks.some(({ name }) => name === "MIGRATIONS_0001_0008"));

      const smoke = await executeStagingOperation(environment, "turso-smoke", null);
      assert.ok(smoke.checks.length >= 3);
      assert.ok(smoke.checks.every(({ status }) => status === "PASS"), JSON.stringify(smoke.checks));

      const client = createClient({ url: environment.TURSO_DATABASE_URL!, intMode: "number" });
      try {
        await client.execute("CREATE VIEW unexpected_view AS SELECT 1 AS value");
      } finally {
        client.close();
      }
      const unexpectedSchema = await executeStagingOperation(environment, "turso-preflight", null);
      assert.ok(unexpectedSchema.checks.some(({ name, status }) =>
        name === "DATABASE_SCHEMA" && status === "FAIL"));
    });
  });

  it("refuses customer data and a modified migration checksum", async () => {
    await withLocalDatabase(async (environment) => {
      const client = createClient({ url: environment.TURSO_DATABASE_URL!, intMode: "number" });
      try {
        const migrations = await loadMigrations();
        await applyMigrations(client, migrations.map((migration, index) =>
          index === 0 ? { ...migration, sql: `${migration.sql}\n-- unexpected checksum` } : migration,
        ));
      } finally {
        client.close();
      }
      const mismatch = await executeStagingOperation(environment, "turso-preflight", null);
      assert.ok(mismatch.checks.some(({ name, status }) =>
        name === "MIGRATION_CHECKSUMS" && status === "FAIL"));
    });

    await withLocalDatabase(async (environment) => {
      const client = createClient({ url: environment.TURSO_DATABASE_URL!, intMode: "number" });
      try {
        await applyMigrations(client, await loadMigrations());
        await client.execute({
          sql: `INSERT INTO customers (
            id, email, email_normalized, status, created_at, updated_at
          ) VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
          args: [
            "synthetic-customer",
            "synthetic@example.test",
            "synthetic@example.test",
            new Date().toISOString(),
            new Date().toISOString(),
          ],
        });
      } finally {
        client.close();
      }
      const data = await executeStagingOperation(environment, "turso-preflight", null);
      assert.ok(data.checks.some(({ name, status }) =>
        name === "BUSINESS_DATA_EMPTY" && status === "FAIL"));
      assert.equal(data.preflight_id, undefined);
    });
  });
});

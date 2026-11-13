import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { applyMigrations, type SqlMigration } from "../src/database/migrations.ts";
import { DatabaseError } from "../src/database.ts";
import { connectDatabaseFromEnvironment } from "../src/database/provider.ts";
import { TursoDatabaseAdapter } from "../src/database/turso.ts";

async function loadMigrations(): Promise<SqlMigration[]> {
  const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
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

describe("Turso/libSQL migrations", () => {
  it("applies the existing schema, preserves constraints, and safely no-ops on repeat", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    try {
      const migrations = await loadMigrations();
      assert.deepEqual(await applyMigrations(client, migrations), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      assert.deepEqual(await applyMigrations(client, migrations), []);

      const ledger = await client.execute(
        "SELECT version, name FROM schema_migrations ORDER BY version",
      );
      assert.deepEqual(ledger.rows.map((row) => [row.version, row.name]), [
        [1, "initial_schema"],
        [2, "auth_previews_and_uploads"],
        [3, "local_test_payments"],
        [4, "payment_webhook_recovery"],
        [5, "publication_delivery"],
        [6, "storage_entitlements"],
        [7, "love_letter_photos"],
        [8, "scheduled_maintenance"],
        [9, "fulfillment_recovery_leases"],
        [10, "asset_upload_leases"],
      ]);

      const foreignKeys = await client.execute("PRAGMA foreign_keys");
      assert.equal(Number(foreignKeys.rows[0]?.foreign_keys), 1);
      const violations = await client.execute("PRAGMA foreign_key_check");
      assert.equal(violations.rows.length, 0);
      const designForeignKeys = await client.execute("PRAGMA foreign_key_list('design_revisions')");
      assert.ok(designForeignKeys.rows.some((row) => row.table === "designs"));
      const uploadSessionColumns = await client.execute("PRAGMA table_info('asset_upload_sessions')");
      assert.ok(uploadSessionColumns.rows.some((row) => row.name === "status"));
      assert.ok(uploadSessionColumns.rows.some((row) => row.name === "lease_expires_at"));

      const database = new TursoDatabaseAdapter(client);
      const customerIndexes = await client.execute("PRAGMA index_list('customers')");
      assert.ok(customerIndexes.rows.some((row) => row.name === "customers_status_created"));
      assert.ok(customerIndexes.rows.some((row) => Number(row.unique) === 1));
      const timestamp = new Date().toISOString();
      await database.prepare(
        `INSERT INTO customers (id, email, email_normalized, status, created_at, updated_at)
         VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
      ).bind("customer-one", "one@example.test", "one@example.test", timestamp, timestamp).run();
      await assert.rejects(database.prepare(
        `INSERT INTO customers (id, email, email_normalized, status, created_at, updated_at)
         VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
      ).bind("customer-two", "two@example.test", "one@example.test", timestamp, timestamp).run());

      await database.prepare("CREATE TABLE adapter_test (id TEXT PRIMARY KEY, label TEXT NOT NULL)").run();
      const inserted = await database.batch([
        database.prepare("INSERT INTO adapter_test (id, label) VALUES (?, ?)").bind("one", "first"),
        database.prepare("INSERT INTO adapter_test (id, label) VALUES (?, ?)").bind("two", "second"),
      ]);
      assert.deepEqual(inserted.map((result) => result.meta.changes), [1, 1]);
      const returned = await database.prepare(
        "INSERT INTO adapter_test (id, label) VALUES (?, ?) RETURNING id, label",
      ).bind("three", "third").first();
      assert.deepEqual(returned, { id: "three", label: "third" });
      assert.deepEqual(
        await database.prepare("SELECT label FROM adapter_test WHERE id = ?").bind("two").first(),
        { label: "second" },
      );
      assert.deepEqual(
        (await database.prepare("SELECT id FROM adapter_test ORDER BY id").all()).results.map((row) => row.id),
        ["one", "three", "two"],
      );
      await assert.rejects(database.batch([
        database.prepare("INSERT INTO adapter_test (id, label) VALUES (?, ?)").bind("four", "fourth"),
        database.prepare("INSERT INTO adapter_test (id, label) VALUES (?, ?)").bind("one", "duplicate"),
      ]));
      assert.equal(
        (await database.prepare("SELECT COUNT(*) AS count FROM adapter_test WHERE id = 'four'").first())?.count,
        0,
      );

      await assert.rejects(
        database.prepare(
          "INSERT INTO design_revisions (design_id, revision, data_json, created_at) VALUES (?, 1, '{}', ?)",
        ).bind("missing-design", new Date().toISOString()).run(),
        (error: unknown) => {
          assert.ok(error instanceof DatabaseError);
          assert.equal(error.code, "CONSTRAINT");
          return true;
        },
      );

      const normalized = await database.prepare("SELECT ? AS enabled, ? AS missing, ? AS created_at")
        .bind(true, null, new Date("2026-11-04T00:00:00.000Z")).first();
      assert.deepEqual(normalized, {
        enabled: 1,
        missing: null,
        created_at: "2026-11-04T00:00:00.000Z",
      });
      assert.throws(
        () => database.prepare("SELECT ?").bind(undefined as never),
        /cannot be undefined/,
      );
    } finally {
      client.close();
    }
  });

  it("backfills existing finalized upload sessions without changing pending uploads", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    try {
      const migrations = await loadMigrations();
      assert.deepEqual(await applyMigrations(client, migrations.slice(0, 9)),
        [1, 2, 3, 4, 5, 6, 7, 8, 9]);
      const timestamp = new Date().toISOString();
      await client.execute({
        sql: `INSERT INTO customers (
          id, email, email_normalized, status, created_at, updated_at
        ) VALUES ('upload-migration-customer', 'upload-migration@example.test',
          'upload-migration@example.test', 'ACTIVE', ?, ?)`,
        args: [timestamp, timestamp],
      });
      await client.execute({
        sql: `INSERT INTO designs (
          id, customer_id, template_id, schema_version, data_json, status, created_at, updated_at
        ) VALUES ('upload-migration-design', 'upload-migration-customer',
          'our-universe', 1, '{}', 'DRAFT', ?, ?)`,
        args: [timestamp, timestamp],
      });
      await client.batch([
        {
          sql: `INSERT INTO assets (
            id, customer_id, design_id, object_key, visibility, status, media_type,
            byte_size, sha256, created_at, updated_at
          ) VALUES ('upload-ready-asset', 'upload-migration-customer',
            'upload-migration-design', 'private/upload-ready.png', 'PRIVATE', 'READY',
            'image/png', 1, ?, ?, ?)`,
          args: ["a".repeat(64), timestamp, timestamp],
        },
        {
          sql: `INSERT INTO assets (
            id, customer_id, design_id, object_key, visibility, status, media_type,
            byte_size, sha256, created_at, updated_at
          ) VALUES ('upload-pending-asset', 'upload-migration-customer',
            'upload-migration-design', 'private/upload-pending.png', 'PRIVATE', 'PENDING',
            'image/png', 1, '', ?, ?)`,
          args: [timestamp, timestamp],
        },
        {
          sql: `INSERT INTO asset_upload_sessions (
            id, asset_id, customer_id, token_hash, expires_at, used_at, created_at
          ) VALUES ('upload-ready-session', 'upload-ready-asset',
            'upload-migration-customer', ?, ?, ?, ?)`,
          args: ["b".repeat(64), timestamp, timestamp, timestamp],
        },
        {
          sql: `INSERT INTO asset_upload_sessions (
            id, asset_id, customer_id, token_hash, expires_at, used_at, created_at
          ) VALUES ('upload-pending-session', 'upload-pending-asset',
            'upload-migration-customer', ?, ?, NULL, ?)`,
          args: ["c".repeat(64), timestamp, timestamp],
        },
      ]);

      assert.deepEqual(await applyMigrations(client, migrations), [10]);
      const sessions = await client.execute(
        `SELECT id, status FROM asset_upload_sessions
         WHERE id IN ('upload-ready-session','upload-pending-session') ORDER BY id`,
      );
      assert.deepEqual(sessions.rows, [
        { id: "upload-pending-session", status: "PENDING" },
        { id: "upload-ready-session", status: "COMPLETE" },
      ]);
    } finally {
      client.close();
    }
  });

  it("preserves existing fulfillment jobs while adding durable recovery fields", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    try {
      const migrations = await loadMigrations();
      assert.deepEqual(await applyMigrations(client, migrations.slice(0, 8)), [
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
      const timestamp = new Date().toISOString();
      await client.execute({
        sql: `INSERT INTO customers (
          id, email, email_normalized, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
        args: ["fulfillment-migration-customer", "fulfillment@example.test",
          "fulfillment@example.test", timestamp, timestamp],
      });
      await client.execute({
        sql: `INSERT INTO orders (
          id, customer_id, order_type, status, currency, subtotal_minor,
          discount_minor, total_minor, idempotency_key, created_at, updated_at
        ) VALUES (?, ?, 'SELF_SERVICE', 'PAID', 'VND', 1, 0, 1, ?, ?, ?)`,
        args: ["fulfillment-migration-order", "fulfillment-migration-customer",
          "fulfillment-migration-key", timestamp, timestamp],
      });
      await client.execute({
        sql: `INSERT INTO fulfillment_jobs (
          id, order_id, status, attempts, last_error_code, started_at,
          created_at, updated_at
        ) VALUES (?, ?, 'FAILED', 3, ?, ?, ?, ?)`,
        args: ["fulfillment-migration-job", "fulfillment-migration-order",
          "PUBLICATION_FAILED", timestamp, timestamp, timestamp],
      });

      assert.deepEqual(await applyMigrations(client, migrations), [9, 10]);
      const preserved = await client.execute(
        `SELECT status, attempts, last_error_code, started_at, completed_at,
                next_attempt_at, lease_token, lease_expires_at, last_failure_at
         FROM fulfillment_jobs WHERE id = ?`,
        ["fulfillment-migration-job"],
      );
      assert.deepEqual(preserved.rows[0], {
        status: "FAILED",
        attempts: 3,
        last_error_code: "PUBLICATION_FAILED",
        started_at: timestamp,
        completed_at: null,
        next_attempt_at: null,
        lease_token: null,
        lease_expires_at: null,
        last_failure_at: null,
      });
      await client.execute(
        "UPDATE fulfillment_jobs SET status = 'MANUAL_REVIEW' WHERE id = ?",
        ["fulfillment-migration-job"],
      );
      const foreignKeyViolations = await client.execute("PRAGMA foreign_key_check");
      assert.equal(foreignKeyViolations.rows.length, 0);
    } finally {
      client.close();
    }
  });

  it("rejects changed migration files after they have been applied", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    try {
      const migrations = await loadMigrations();
      await applyMigrations(client, migrations);
      const changed = migrations.map((migration, index) =>
        index === 0 ? { ...migration, sql: `${migration.sql}\n-- changed` } : migration,
      );
      await assert.rejects(
        applyMigrations(client, changed),
        /does not match the migration files/,
      );
    } finally {
      client.close();
    }
  });

  it("refuses to modify an existing schema with no migration ledger", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    try {
      await client.execute("CREATE TABLE existing_customer_data (id TEXT PRIMARY KEY)");
      await assert.rejects(
        applyMigrations(client, await loadMigrations()),
        /no migration ledger/,
      );
      const ledger = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      );
      assert.equal(ledger.rows.length, 0);
    } finally {
      client.close();
    }
  });
});

describe("Database provider selection", () => {
  it("fails closed unless the provider and its local binding/configuration are explicit", async () => {
    await assert.rejects(connectDatabaseFromEnvironment({}), /DATABASE_PROVIDER must be explicitly set/);
    await assert.rejects(
      connectDatabaseFromEnvironment({ DATABASE_PROVIDER: "d1" }),
      /requires a D1 database binding/,
    );
    await assert.rejects(
      connectDatabaseFromEnvironment({ DATABASE_PROVIDER: "turso" }),
      /TURSO_DATABASE_URL is required/,
    );
    await assert.rejects(
      connectDatabaseFromEnvironment({
        DATABASE_PROVIDER: "turso",
        TURSO_DATABASE_URL: "libsql://example.turso.io",
      }),
      /TURSO_AUTH_TOKEN is required/,
    );
  });
});

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
      assert.deepEqual(await applyMigrations(client, migrations), [1, 2, 3, 4]);
      assert.deepEqual(await applyMigrations(client, migrations), []);

      const ledger = await client.execute(
        "SELECT version, name FROM schema_migrations ORDER BY version",
      );
      assert.deepEqual(ledger.rows.map((row) => [row.version, row.name]), [
        [1, "initial_schema"],
        [2, "auth_previews_and_uploads"],
        [3, "local_test_payments"],
        [4, "payment_webhook_recovery"],
      ]);

      const foreignKeys = await client.execute("PRAGMA foreign_keys");
      assert.equal(Number(foreignKeys.rows[0]?.foreign_keys), 1);
      const violations = await client.execute("PRAGMA foreign_key_check");
      assert.equal(violations.rows.length, 0);
      const designForeignKeys = await client.execute("PRAGMA foreign_key_list('design_revisions')");
      assert.ok(designForeignKeys.rows.some((row) => row.table === "designs"));

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

import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";

export interface SqlMigration {
  version: number;
  name: string;
  sql: string;
}

interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
}

export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

async function enableForeignKeys(client: Client): Promise<void> {
  await client.execute("PRAGMA foreign_keys = ON");
  const result = await client.execute("PRAGMA foreign_keys");
  if (Number(result.rows[0]?.foreign_keys) !== 1) {
    throw new Error("Database connection does not enforce foreign keys");
  }
}

export async function applyMigrations(
  client: Client,
  migrations: SqlMigration[],
): Promise<number[]> {
  await enableForeignKeys(client);
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const versions = new Set<number>();
  for (const migration of ordered) {
    if (!Number.isSafeInteger(migration.version) || migration.version < 1 ||
        !/^[a-z0-9_-]+$/i.test(migration.name) || versions.has(migration.version)) {
      throw new Error(`Invalid or duplicate migration metadata: ${migration.version}`);
    }
    versions.add(migration.version);
  }
  if (ordered.some((migration, index) => migration.version !== index + 1)) {
    throw new Error("Migration files must be numbered consecutively from version 1");
  }

  const schemaTable = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  );
  const hasLedger = schemaTable.rows.length === 1;
  let applied: AppliedMigration[] = [];

  if (hasLedger) {
    const result = await client.execute(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    );
    applied = result.rows.map((row) => ({
      version: Number(row.version),
      name: String(row.name),
      checksum: String(row.checksum),
    }));
    if (applied.length === 0) {
      throw new Error("Existing migration ledger is empty; refusing to assume database state");
    }
  } else {
    const existingTables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    if (existingTables.rows.length > 0) {
      throw new Error("Database has tables but no migration ledger; refusing to alter it");
    }
  }

  for (const [index, record] of applied.entries()) {
    const migration = ordered[index];
    if (!migration || migration.version !== record.version ||
        migration.name !== record.name || migrationChecksum(migration.sql) !== record.checksum) {
      throw new Error(`Applied migration ${record.version} does not match the migration files`);
    }
  }

  const appliedVersions = new Set(applied.map((migration) => migration.version));
  const newlyApplied: number[] = [];
  for (const migration of ordered) {
    if (appliedVersions.has(migration.version)) continue;

    const transaction = await client.transaction("write");
    try {
      await transaction.executeMultiple(migration.sql);
      await transaction.execute({
        sql: `INSERT INTO schema_migrations (version, name, checksum, applied_at)
              VALUES (?, ?, ?, ?)`,
        args: [
          migration.version,
          migration.name,
          migrationChecksum(migration.sql),
          new Date().toISOString(),
        ],
      });
      await transaction.commit();
      newlyApplied.push(migration.version);
    } finally {
      transaction.close();
    }
  }

  const violations = await client.execute("PRAGMA foreign_key_check");
  if (violations.rows.length > 0) {
    throw new Error(`Foreign-key check found ${violations.rows.length} violation(s)`);
  }
  return newlyApplied;
}

export async function verifyMigrationSchema(
  client: Client,
  migrations: SqlMigration[],
): Promise<void> {
  const expected = new Set<string>();
  const declaration = /CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))/gi;
  for (const migration of migrations) {
    for (const match of migration.sql.matchAll(declaration)) {
      const name = match[2] ?? match[3] ?? match[4] ?? match[5];
      if (name) expected.add(`${match[1].toLowerCase()}:${name}`);
    }
  }

  const result = await client.execute(
    "SELECT type, name FROM sqlite_master " +
    "WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'",
  );
  const actual = new Set(result.rows.map((row) => `${String(row.type)}:${String(row.name)}`));
  if (expected.size !== actual.size || [...expected].some((object) => !actual.has(object))) {
    throw new Error("Database tables and indexes do not match the applied migrations");
  }
}

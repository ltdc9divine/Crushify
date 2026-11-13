import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import {
  resolveTursoStagingMigrationTarget,
  StagingConfigurationError,
} from "./staging-config.ts";
import {
  applyMigrations,
  migrationChecksum,
  type SqlMigration,
  verifyMigrationSchema,
} from "../src/database/migrations.ts";

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

async function verifyMigrationState(
  client: ReturnType<typeof createClient>,
  migrations: SqlMigration[],
): Promise<number[]> {
  const ledger = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  );
  if (ledger.rows.length === 0) {
    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    if (tables.rows.length !== 0) {
      throw new Error("Staging database has tables without a migration ledger; refusing to alter it");
    }
    return [];
  }

  const records = await client.execute(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
  );
  if (records.rows.length === 0) {
    throw new Error("Staging database has an empty migration ledger; refusing to assume its state");
  }
  const appliedVersions: number[] = [];
  for (const [index, row] of records.rows.entries()) {
    const migration = migrations[index];
    if (!migration ||
        Number(row.version) !== migration.version ||
        String(row.name) !== migration.name ||
        String(row.checksum) !== migrationChecksum(migration.sql)) {
      throw new Error(`Applied staging migration ${String(row.version)} does not match checked-in files`);
    }
    appliedVersions.push(migration.version);
  }
  const violations = await client.execute("PRAGMA foreign_key_check");
  if (violations.rows.length > 0) {
    throw new Error(`Staging database has ${violations.rows.length} foreign-key violation(s)`);
  }
  return appliedVersions;
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "--preflight" && mode !== "--migrate") {
    throw new Error("Use --preflight or --migrate");
  }
  const target = resolveTursoStagingMigrationTarget(process.env, mode);
  const migrations = await loadMigrations();
  if (migrations.length === 0) throw new Error("No database migrations were found");
  if (migrations.some((migration, index) => migration.version !== index + 1)) {
    throw new Error("Migration files must be numbered consecutively from version 1");
  }
  const client = createClient({
    ...target,
    intMode: "number",
  });
  try {
    const applied = await verifyMigrationState(client, migrations);
    await verifyMigrationSchema(client, migrations.slice(0, applied.length));
    if (mode === "--preflight") {
      console.info(
        "Staging target confirmed: crushify-staging, crushify-staging-sg, Singapore; " +
        `applied migrations ${applied.length ? applied.join(", ") : "none"}; ` +
        `${migrations.length - applied.length} pending`,
      );
      return;
    }
    const newlyApplied = await applyMigrations(client, migrations);
    const appliedAfterMigration = await verifyMigrationState(client, migrations);
    await verifyMigrationSchema(client, migrations.slice(0, appliedAfterMigration.length));
    console.info(
      newlyApplied.length
        ? `Applied staging Turso migrations: ${newlyApplied.join(", ")}`
        : "Staging Turso database is up to date",
    );
  } finally {
    client.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof StagingConfigurationError
    ? error.message
    : `Remote database operation failed (${error instanceof Error ? error.name : "UnknownError"})`;
  console.error("Staging Turso operation failed", message);
  process.exitCode = 1;
});

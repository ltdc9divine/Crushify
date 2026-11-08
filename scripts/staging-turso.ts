import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import {
  applyMigrations,
  migrationChecksum,
  type SqlMigration,
} from "../src/database/migrations.ts";

const expectedDatabase = "crushify-staging";
const expectedGroup = "crushify-staging-sg";
const expectedRegion = "Singapore";

class StagingPreflightError extends Error {}

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

function assertOperatorConfirmation(): URL {
  if (process.env.ENVIRONMENT !== "staging" ||
      process.env.DATABASE_PROVIDER !== "turso" ||
      process.env.TURSO_CONFIRM_DATABASE !== expectedDatabase ||
      process.env.TURSO_CONFIRM_GROUP !== expectedGroup ||
      process.env.TURSO_CONFIRM_REGION !== expectedRegion) {
    throw new StagingPreflightError(
      "Staging migration requires ENVIRONMENT=staging and exact dashboard confirmations for database, group, and Singapore region",
    );
  }
  const rawUrl = process.env.TURSO_DATABASE_URL;
  if (!rawUrl || !process.env.TURSO_AUTH_TOKEN?.trim()) {
    throw new StagingPreflightError("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required");
  }
  const url = new URL(rawUrl);
  if (url.protocol !== "libsql:" ||
      url.username || url.password || url.search || url.hash ||
      !/^crushify-staging-[a-z0-9-]+\.turso\.io$/i.test(url.hostname)) {
    throw new StagingPreflightError("Turso URL does not match the confirmed staging database identity");
  }
  return url;
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
  const url = assertOperatorConfirmation();
  const migrations = await loadMigrations();
  if (migrations.length === 0) throw new Error("No database migrations were found");
  if (migrations.some((migration, index) => migration.version !== index + 1)) {
    throw new Error("Migration files must be numbered consecutively from version 1");
  }
  const client = createClient({
    url: url.toString(),
    authToken: process.env.TURSO_AUTH_TOKEN,
    intMode: "number",
  });
  try {
    const applied = await verifyMigrationState(client, migrations);
    if (mode === "--preflight") {
      console.info(
        `Staging target confirmed: ${expectedDatabase}, ${expectedGroup}, ${expectedRegion}; ` +
        `applied migrations ${applied.length ? applied.join(", ") : "none"}; ` +
        `${migrations.length - applied.length} pending`,
      );
      return;
    }
    const newlyApplied = await applyMigrations(client, migrations);
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
  const message = error instanceof StagingPreflightError
    ? error.message
    : `Remote database operation failed (${error instanceof Error ? error.name : "UnknownError"})`;
  console.error("Staging Turso operation failed", message);
  process.exitCode = 1;
});

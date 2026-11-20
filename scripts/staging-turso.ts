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
import {
  createStagingOperationDiagnostic,
  StagingOperationTrace,
} from "./staging-diagnostics.ts";
import {
  createPreflightFailureReport,
  createPreflightSuccessReport,
} from "./staging-preflight-report.ts";

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
  trace: StagingOperationTrace,
): Promise<{
  ledgerExists: boolean;
  appliedVersions: number[];
  foreignKeyCheckExecuted: boolean;
  foreignKeyViolationCount: number | null;
}> {
  const ledger = await trace.run("read-migration-ledger", () => client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  ));
  if (ledger.rows.length === 0) {
    const tables = await trace.run("read-unmanaged-tables", () => client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ));
    trace.setStage("validate-unmanaged-tables");
    if (tables.rows.length !== 0) {
      throw new Error("Staging database has tables without a migration ledger; refusing to alter it");
    }
    return {
      ledgerExists: false,
      appliedVersions: [],
      foreignKeyCheckExecuted: false,
      foreignKeyViolationCount: null,
    };
  }

  const records = await trace.run("read-migration-records", () => client.execute(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
  ));
  trace.setStage("validate-migration-ledger");
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
  const violations = await trace.run("check-foreign-keys", () =>
    client.execute("PRAGMA foreign_key_check"));
  trace.setStage("validate-foreign-keys");
  if (violations.rows.length > 0) {
    throw new Error(`Staging database has ${violations.rows.length} foreign-key violation(s)`);
  }
  return {
    ledgerExists: true,
    appliedVersions,
    foreignKeyCheckExecuted: true,
    foreignKeyViolationCount: violations.rows.length,
  };
}

const trace = new StagingOperationTrace();

async function main(): Promise<void> {
  const mode = await trace.run("validate-mode", () => {
    const requestedMode = process.argv[2];
    if (requestedMode !== "--preflight" && requestedMode !== "--migrate") {
      throw new Error("Use --preflight or --migrate");
    }
    return requestedMode;
  });
  const target = await trace.run("resolve-target", () =>
    resolveTursoStagingMigrationTarget(process.env, mode));
  const migrations = await trace.run("load-migrations", loadMigrations);
  await trace.run("validate-migration-sequence", () => {
    if (migrations.length === 0) throw new Error("No database migrations were found");
    if (migrations.some((migration, index) => migration.version !== index + 1)) {
      throw new Error("Migration files must be numbered consecutively from version 1");
    }
  });
  const client = await trace.run("create-client", () => createClient({
    ...target,
    intMode: "number",
  }));
  let preflightReport: ReturnType<typeof createPreflightSuccessReport> | undefined;
  try {
    const migrationState = await verifyMigrationState(client, migrations, trace);
    const checkedObjectCount = await verifyMigrationSchema(
      client,
      migrations.slice(0, migrationState.appliedVersions.length),
      (stage) => trace.setStage(stage),
    );
    if (mode === "--preflight") {
      trace.setStage("report-preflight");
      preflightReport = createPreflightSuccessReport({
        migrations,
        ledgerExists: migrationState.ledgerExists,
        appliedCount: migrationState.appliedVersions.length,
        foreignKeyCheckExecuted: migrationState.foreignKeyCheckExecuted,
        foreignKeyViolationCount: migrationState.foreignKeyViolationCount,
        schemaCheckedObjectCount: checkedObjectCount,
      });
    } else {
      trace.setStage("apply-migrations");
      const newlyApplied = await applyMigrations(client, migrations);
      const appliedAfterMigration = await verifyMigrationState(client, migrations, trace);
      await verifyMigrationSchema(
        client,
        migrations.slice(0, appliedAfterMigration.appliedVersions.length),
        (stage) => trace.setStage(stage),
      );
      trace.setStage("report-migration-result");
      console.info(
        newlyApplied.length
          ? `Applied staging Turso migrations: ${newlyApplied.join(", ")}`
          : "Staging Turso database is up to date",
      );
    }
  } finally {
    try {
      client.close();
    } catch (error) {
      trace.setStage("close-client");
      throw error;
    }
  }
  if (preflightReport) {
    process.stdout.write(`${JSON.stringify(preflightReport)}\n`);
  }
}

main().catch((error: unknown) => {
  if (process.argv[2] === "--preflight") {
    const report = createPreflightFailureReport(trace.stage, error);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = 1;
    return;
  }
  const diagnostic = createStagingOperationDiagnostic(trace.stage, error);
  const message = error instanceof StagingConfigurationError
    ? error.message
    : `Remote database operation failed (${diagnostic.error_name})`;
  console.error("Staging Turso operation failed", message);
  console.error("Staging Turso diagnostic", JSON.stringify(diagnostic));
  process.exitCode = 1;
});

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { applyMigrations, migrationChecksum, type SqlMigration } from "../database/migrations.ts";
import type { Storage } from "../storage.ts";
import { CloudinaryStorageAdapter } from "../storage/cloudinary.ts";
import type { VercelEnvironment } from "./vercel.ts";

const PROJECT_ID = "prj_nw874WiBWiUZlIjBzOFn6yG2CeHH";
const DATABASE_NAME = "crushify-staging";
const DATABASE_HOST_PATTERN = new RegExp(
  `^${DATABASE_NAME}-[a-z0-9-]+\\.turso\\.io$`,
  "i",
);
const DATABASE_REGION = "Singapore";
const CLOUDINARY_CLOUD = "hgtcizux";
const REQUIRED_MIGRATIONS = 8;
const PREFLIGHT_TTL_MS = 10 * 60 * 1000;
const EXPECTED_SEED_TABLES = new Set([
  "schema_migrations",
  "templates",
  "template_versions",
  "storage_plans",
]);
const EXPECTED_OPERATIONS = new Set([
  "environment-check",
  "turso-preflight",
  "turso-migrate",
  "turso-smoke",
  "cloudinary-smoke",
  "status",
]);

export type StagingOperation =
  | "environment-check"
  | "turso-preflight"
  | "turso-migrate"
  | "turso-smoke"
  | "cloudinary-smoke"
  | "status";

export interface StagingOperationCheck {
  name: string;
  status: "PASS" | "FAIL";
}

export interface StagingOperationResult {
  operation_id: string;
  checks: StagingOperationCheck[];
  preflight_id?: string;
}

interface MigrationState {
  checks: StagingOperationCheck[];
  appliedVersions: number[];
  ready: boolean;
}

export interface StagingOperationsDependencies {
  runOperation?: (
    environment: VercelEnvironment,
    operation: StagingOperation,
    preflightId: string | null,
  ) => Promise<Omit<StagingOperationResult, "operation_id">>;
}

function pass(name: string): StagingOperationCheck {
  return { name, status: "PASS" };
}

function fail(name: string): StagingOperationCheck {
  return { name, status: "FAIL" };
}

function validHttpsVercelOrigin(
  value: string | undefined,
  allowedHosts: Array<string | undefined>,
): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== value ||
        !url.hostname.toLowerCase().endsWith(".vercel.app")) return false;
    const host = url.hostname.toLowerCase();
    return allowedHosts.some((allowedHost) =>
      allowedHost !== undefined &&
      /^[a-z0-9.-]+$/i.test(allowedHost) &&
      host === allowedHost.toLowerCase()) ||
      host === "crushify-one.vercel.app" ||
      host === "crushify-ltdc9divine-5816s-projects.vercel.app" ||
      host === "crushify-git-main-ltdc9divine-5816s-projects.vercel.app";
  } catch {
    return false;
  }
}

export function stagingEnvironmentChecks(
  environment: VercelEnvironment,
): StagingOperationCheck[] {
  let validDatabaseUrl = false;
  try {
    const url = new URL(environment.TURSO_DATABASE_URL ?? "");
    validDatabaseUrl = url.protocol === "libsql:" &&
      !url.username && !url.password && !url.search && !url.hash &&
      DATABASE_HOST_PATTERN.test(url.hostname);
  } catch {
    validDatabaseUrl = false;
  }
  const checks = [
    environment.VERCEL_ENV === "production" &&
        environment.VERCEL_PROJECT_ID === PROJECT_ID &&
        environment.ENVIRONMENT === "staging"
      ? pass("VERCEL_STAGING_PROJECT")
      : fail("VERCEL_STAGING_PROJECT"),
    environment.DATABASE_PROVIDER === "turso" && validDatabaseUrl
      ? pass("TURSO_STAGING_TARGET")
      : fail("TURSO_STAGING_TARGET"),
    Boolean(environment.TURSO_AUTH_TOKEN?.trim())
      ? pass("TURSO_AUTH_TOKEN")
      : fail("TURSO_AUTH_TOKEN"),
    environment.STORAGE_PROVIDER === "cloudinary" &&
        environment.CLOUDINARY_CLOUD_NAME === CLOUDINARY_CLOUD &&
        Boolean(environment.CLOUDINARY_API_KEY?.trim()) &&
        Boolean(environment.CLOUDINARY_API_SECRET?.trim())
      ? pass("CLOUDINARY_TEST_CONFIGURATION")
      : fail("CLOUDINARY_TEST_CONFIGURATION"),
    validHttpsVercelOrigin(environment.APP_ORIGIN, [
      environment.VERCEL_URL,
      environment.VERCEL_BRANCH_URL,
      environment.VERCEL_PROJECT_PRODUCTION_URL,
    ])
      ? pass("APP_ORIGIN")
      : fail("APP_ORIGIN"),
  ];
  return checks;
}

function secureTokenMatch(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected || expected.length < 43) return false;
  const actualBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  const size = Math.max(actualBytes.length, expectedBytes.length);
  const actual = Buffer.alloc(size);
  const wanted = Buffer.alloc(size);
  actualBytes.copy(actual);
  expectedBytes.copy(wanted);
  return timingSafeEqual(actual, wanted) && actualBytes.length === expectedBytes.length;
}

function createDatabaseClient(environment: VercelEnvironment): Client {
  const url = environment.TURSO_DATABASE_URL;
  const authToken = environment.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("Missing staging database configuration");
  return createClient({ url, authToken, intMode: "number" });
}

async function loadMigrations(): Promise<SqlMigration[]> {
  const directory = join(process.cwd(), "migrations");
  const files = (await readdir(directory))
    .filter((file) => file.toLowerCase().endsWith(".sql"))
    .sort();
  const migrations = await Promise.all(files.map(async (file) => {
    const match = file.match(/^(\d{4})_([a-z0-9_-]+)\.sql$/i);
    if (!match) throw new Error("Invalid migration filename");
    return {
      version: Number(match[1]),
      name: match[2],
      sql: await readFile(join(directory, file), "utf8"),
    };
  }));
  if (migrations.length !== REQUIRED_MIGRATIONS ||
      migrations.some((migration, index) => migration.version !== index + 1)) {
    throw new Error("Unexpected staging migration set");
  }
  return migrations;
}

function migrationObjects(migrations: SqlMigration[], versions: number[]): {
  tables: Set<string>;
  indexes: Set<string>;
} {
  const selected = migrations.filter((migration) => versions.includes(migration.version));
  const tables = new Set<string>();
  const indexes = new Set<string>();
  for (const migration of selected) {
    for (const match of migration.sql.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([A-Za-z_][A-Za-z0-9_]*)/gi)) {
      tables.add(match[1].toLowerCase());
    }
    for (const match of migration.sql.matchAll(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([A-Za-z_][A-Za-z0-9_]*)/gi)) {
      indexes.add(match[1].toLowerCase());
    }
  }
  return { tables, indexes };
}

async function inspectDatabase(
  client: Client,
  migrations: SqlMigration[],
): Promise<MigrationState> {
  await client.execute("SELECT 1");
  const schema = await client.execute(
    "SELECT name, type FROM sqlite_master WHERE type IN ('table','index','view') AND name NOT LIKE 'sqlite_%'",
  );
  const tables = new Set(schema.rows.filter((row) => row.type === "table").map((row) => String(row.name).toLowerCase()));
  const indexes = new Set(schema.rows.filter((row) => row.type === "index").map((row) => String(row.name).toLowerCase()));
  const views = schema.rows.filter((row) => row.type === "view");
  if (!tables.has("schema_migrations")) {
    return {
      checks: [
        pass("TURSO_CONNECTION"),
        tables.size === 0 && views.length === 0 ? pass("DATABASE_EMPTY") : fail("DATABASE_EMPTY"),
        pass("MIGRATION_CHECKSUMS"),
        pass("BUSINESS_DATA_EMPTY"),
      ],
      appliedVersions: [],
      ready: tables.size === 0 && views.length === 0,
    };
  }

  const ledger = await client.execute(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
  );
  if (ledger.rows.length === 0 || ledger.rows.length > migrations.length) {
    return {
      checks: [
        pass("TURSO_CONNECTION"),
        fail("MIGRATION_LEDGER"),
        fail("MIGRATION_CHECKSUMS"),
        fail("BUSINESS_DATA_EMPTY"),
      ],
      appliedVersions: [],
      ready: false,
    };
  }
  const appliedVersions: number[] = [];
  let checksumsMatch = true;
  for (const [index, row] of ledger.rows.entries()) {
    const migration = migrations[index];
    if (!migration ||
        Number(row.version) !== migration.version ||
        String(row.name) !== migration.name ||
        String(row.checksum) !== migrationChecksum(migration.sql)) {
      checksumsMatch = false;
      break;
    }
    appliedVersions.push(migration.version);
  }

  const objects = migrationObjects(migrations, appliedVersions);
  const unknownTables = [...tables].filter((table) => !objects.tables.has(table));
  let businessDataEmpty = unknownTables.length === 0;
  if (businessDataEmpty) {
    for (const table of tables) {
      if (EXPECTED_SEED_TABLES.has(table)) continue;
      const count = await client.execute(`SELECT COUNT(*) AS count FROM "${table}"`);
      if (Number(count.rows[0]?.count) !== 0) {
        businessDataEmpty = false;
        break;
      }
    }
  }

  const appliedObjects = migrationObjects(migrations, appliedVersions);
  const schemaComplete = [...appliedObjects.tables].every((table) => tables.has(table)) &&
    [...appliedObjects.indexes].every((index) => indexes.has(index)) &&
    [...indexes].every((index) => appliedObjects.indexes.has(index)) &&
    views.length === 0;
  const foreignKeys = checksumsMatch
    ? await client.execute("PRAGMA foreign_key_check")
    : { rows: [{}] };
  const foreignKeysValid = foreignKeys.rows.length === 0;
  const checks = [
    pass("TURSO_CONNECTION"),
    pass("MIGRATION_LEDGER"),
    checksumsMatch ? pass("MIGRATION_CHECKSUMS") : fail("MIGRATION_CHECKSUMS"),
    businessDataEmpty ? pass("BUSINESS_DATA_EMPTY") : fail("BUSINESS_DATA_EMPTY"),
    schemaComplete && foreignKeysValid ? pass("DATABASE_SCHEMA") : fail("DATABASE_SCHEMA"),
  ];
  return {
    checks,
    appliedVersions,
    ready: checksumsMatch && businessDataEmpty && schemaComplete && foreignKeysValid,
  };
}

function preflightTicket(environment: VercelEnvironment, operationToken: string): string {
  const timestamp = Date.now().toString();
  const nonce = randomBytes(16).toString("base64url");
  const host = new URL(environment.TURSO_DATABASE_URL!).hostname.toLowerCase();
  const payload = `${timestamp}.${nonce}.${host}.${DATABASE_REGION}`;
  const signature = createHmac("sha256", operationToken).update(payload).digest("base64url");
  return Buffer.from(`${timestamp}.${nonce}.${signature}`).toString("base64url");
}

function validatePreflightTicket(
  ticket: string | null,
  environment: VercelEnvironment,
  operationToken: string,
): boolean {
  if (!ticket || ticket.length > 256) return false;
  try {
    const decoded = Buffer.from(ticket, "base64url").toString("utf8");
    const parts = decoded.split(".");
    if (parts.length !== 3 || !/^\d{13}$/.test(parts[0]) ||
        !/^[A-Za-z0-9_-]{20,30}$/.test(parts[1]) ||
        !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return false;
    const issuedAt = Number(parts[0]);
    if (issuedAt > Date.now() || Date.now() - issuedAt > PREFLIGHT_TTL_MS) return false;
    const host = new URL(environment.TURSO_DATABASE_URL!).hostname.toLowerCase();
    const payload = `${parts[0]}.${parts[1]}.${host}.${DATABASE_REGION}`;
    const expected = createHmac("sha256", operationToken).update(payload).digest();
    const actual = Buffer.from(parts[2], "base64url");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

async function verifyExpectedSchema(client: Client, migrations: SqlMigration[]): Promise<boolean> {
  const state = await inspectDatabase(client, migrations);
  if (state.appliedVersions.length !== REQUIRED_MIGRATIONS ||
      !state.checks.every((check) => check.status === "PASS")) return false;
  const objects = migrationObjects(migrations, state.appliedVersions);
  const actual = await client.execute(
    "SELECT name, type FROM sqlite_master WHERE type IN ('table','index','view') AND name NOT LIKE 'sqlite_%'",
  );
  const tables = new Set(actual.rows.filter((row) => row.type === "table").map((row) => String(row.name).toLowerCase()));
  const indexes = new Set(actual.rows.filter((row) => row.type === "index").map((row) => String(row.name).toLowerCase()));
  const views = actual.rows.filter((row) => row.type === "view");
  return views.length === 0 &&
    [...objects.tables].every((table) => tables.has(table)) &&
    [...objects.indexes].every((index) => indexes.has(index));
}

async function runTursoSmoke(environment: VercelEnvironment): Promise<StagingOperationCheck[]> {
  const first = createDatabaseClient(environment);
  const second = createDatabaseClient(environment);
  const table = `crushify_smoke_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  const checks: StagingOperationCheck[] = [];
  try {
    await first.execute(`CREATE TABLE "${table}" (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`);
    created = true;
    const id = randomUUID();
    const original = JSON.stringify({ fixture: "synthetic", phase: "7b" });
    await first.execute({
      sql: `INSERT INTO "${table}" (id, payload) VALUES (?, ?)`,
      args: [id, original],
    });
    const read = await second.execute({
      sql: `SELECT payload FROM "${table}" WHERE id = ?`,
      args: [id],
    });
    const persisted = read.rows.length === 1 && read.rows[0]?.payload === original;
    const updated = await second.execute({
      sql: `UPDATE "${table}" SET payload = ? WHERE id = ?`,
      args: [JSON.stringify({ fixture: "synthetic", updated: true }), id],
    });
    const deleted = await first.execute({
      sql: `DELETE FROM "${table}" WHERE id = ?`,
      args: [id],
    });
    checks.push(
      persisted ? pass("TURSO_CROSS_CONNECTION_READ") : fail("TURSO_CROSS_CONNECTION_READ"),
      Number(updated.rowsAffected) === 1 ? pass("TURSO_SYNTHETIC_UPDATE") : fail("TURSO_SYNTHETIC_UPDATE"),
      Number(deleted.rowsAffected) === 1 ? pass("TURSO_SYNTHETIC_DELETE") : fail("TURSO_SYNTHETIC_DELETE"),
    );
  } catch {
    checks.push(fail("TURSO_SYNTHETIC_ROUND_TRIP"));
  } finally {
    if (created) {
      try {
        await first.execute(`DROP TABLE "${table}"`);
      } catch {
        console.error("Staging synthetic database cleanup failed", { operation: "turso-smoke" });
        checks.push(fail("TURSO_SYNTHETIC_CLEANUP"));
      }
    }
    first.close();
    second.close();
  }
  return checks;
}

async function runCloudinarySmoke(environment: VercelEnvironment): Promise<StagingOperationCheck[]> {
  const storage: Storage = new CloudinaryStorageAdapter({
    cloudName: environment.CLOUDINARY_CLOUD_NAME!,
    apiKey: environment.CLOUDINARY_API_KEY!,
    apiSecret: environment.CLOUDINARY_API_SECRET!,
  });
  const id = randomUUID().replaceAll("-", "");
  const privateKey = `private/${id}-png`;
  const derivativeKey = `published/${id}-png`;
  const bytes = new Uint8Array(Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ));
  const checks: StagingOperationCheck[] = [];
  let uploadSucceeded = false;
  let derivativeSucceeded = false;
  let operationFailed = false;
  try {
    await storage.upload(privateKey, bytes, {
      contentType: "image/png",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      width: 1,
      height: 1,
    });
    uploadSucceeded = true;
    const privateRead = await storage.get(privateKey);
    checks.push(privateRead &&
      privateRead.size === bytes.length &&
      Buffer.from(await privateRead.arrayBuffer()).equals(Buffer.from(bytes))
      ? pass("CLOUDINARY_PRIVATE_UPLOAD_READ")
      : fail("CLOUDINARY_PRIVATE_UPLOAD_READ"));
    const unauthenticatedOriginal = await fetch(
      `https://res.cloudinary.com/${CLOUDINARY_CLOUD}/image/authenticated/${privateKey}`,
      { method: "GET", redirect: "manual" },
    );
    if (unauthenticatedOriginal.body) await unauthenticatedOriginal.body.cancel();
    checks.push([401, 403, 404].includes(unauthenticatedOriginal.status)
      ? pass("CLOUDINARY_ORIGINAL_PRIVATE")
      : fail("CLOUDINARY_ORIGINAL_PRIVATE"));

    await storage.createPublishedDerivative(privateKey, derivativeKey);
    derivativeSucceeded = true;
    const derivative = await storage.getPublishedDerivative(derivativeKey);
    checks.push(derivative &&
      derivative.size === bytes.length &&
      Buffer.from(await derivative.arrayBuffer()).equals(Buffer.from(bytes))
      ? pass("CLOUDINARY_DERIVATIVE_READ")
      : fail("CLOUDINARY_DERIVATIVE_READ"));

    await storage.deletePublishedDerivative(derivativeKey);
    derivativeSucceeded = false;
    await storage.deletePublishedDerivative(derivativeKey);
    checks.push(await storage.getPublishedDerivative(derivativeKey) === null
      ? pass("CLOUDINARY_DERIVATIVE_REVOKED_AND_DELETE_IDEMPOTENT")
      : fail("CLOUDINARY_DERIVATIVE_REVOKED_AND_DELETE_IDEMPOTENT"));
    const originalStillPrivate = await storage.get(privateKey);
    checks.push(originalStillPrivate
      ? pass("CLOUDINARY_ORIGINAL_REMAINS_PRIVATE")
      : fail("CLOUDINARY_ORIGINAL_REMAINS_PRIVATE"));
  } catch {
    operationFailed = true;
    checks.push(fail("CLOUDINARY_SMOKE"));
  } finally {
    if (derivativeSucceeded) {
      try {
        await storage.deletePublishedDerivative(derivativeKey);
      } catch {
        console.error("Staging Cloudinary derivative cleanup failed", { operation: "cloudinary-smoke" });
        checks.push(fail("CLOUDINARY_DERIVATIVE_CLEANUP"));
      }
    }
    if (uploadSucceeded) {
      try {
        await storage.delete(privateKey);
        await storage.delete(privateKey);
        checks.push(await storage.get(privateKey) === null
          ? pass("CLOUDINARY_ORIGINAL_DELETED_IDEMPOTENT")
          : fail("CLOUDINARY_ORIGINAL_DELETED_IDEMPOTENT"));
      } catch {
        console.error("Staging Cloudinary source cleanup failed", { operation: "cloudinary-smoke" });
        checks.push(fail("CLOUDINARY_CLEANUP"));
      }
    }
  }
  if (operationFailed && !checks.some((check) => check.status === "FAIL")) {
    checks.push(fail("CLOUDINARY_SMOKE"));
  }
  return checks;
}

export async function executeStagingOperation(
  environment: VercelEnvironment,
  operation: StagingOperation,
  preflightId: string | null,
): Promise<Omit<StagingOperationResult, "operation_id">> {
  const operationToken = environment.STAGING_OPS_TOKEN!;
  if (operation === "environment-check") {
    return { checks: stagingEnvironmentChecks(environment) };
  }
  if (operation === "turso-preflight" || operation === "status") {
    const client = createDatabaseClient(environment);
    try {
      const migrations = await loadMigrations();
      const state = await inspectDatabase(client, migrations);
      return {
        checks: [
          ...state.checks,
          DATABASE_HOST_PATTERN.test(new URL(environment.TURSO_DATABASE_URL!).hostname)
            ? pass("TURSO_DATABASE_IDENTITY")
            : fail("TURSO_DATABASE_IDENTITY"),
        ],
        ...(operation === "turso-preflight" && state.ready
          ? { preflight_id: preflightTicket(environment, operationToken) }
          : {}),
      };
    } catch {
      return { checks: [fail("TURSO_PREFLIGHT")] };
    } finally {
      client.close();
    }
  }
  if (operation === "turso-migrate") {
    if (!validatePreflightTicket(preflightId, environment, operationToken)) {
      return { checks: [fail("PREFLIGHT_ATTESTATION")] };
    }
    const client = createDatabaseClient(environment);
    try {
      const migrations = await loadMigrations();
      const before = await inspectDatabase(client, migrations);
      if (!before.ready) return { checks: [...before.checks, fail("MIGRATION_NOT_STARTED")] };
      const applied = await applyMigrations(client, migrations);
      const verified = await verifyExpectedSchema(client, migrations);
      const fk = await client.execute("PRAGMA foreign_key_check");
      return {
        checks: [
          pass("MIGRATION_CHECKSUMS"),
          applied.length + before.appliedVersions.length === REQUIRED_MIGRATIONS
            ? pass("MIGRATIONS_0001_0008")
            : fail("MIGRATIONS_0001_0008"),
          verified ? pass("EXPECTED_TABLES_AND_INDEXES") : fail("EXPECTED_TABLES_AND_INDEXES"),
          fk.rows.length === 0 ? pass("FOREIGN_KEY_CHECK") : fail("FOREIGN_KEY_CHECK"),
        ],
      };
    } catch {
      return { checks: [fail("TURSO_MIGRATION")] };
    } finally {
      client.close();
    }
  }
  if (operation === "turso-smoke") {
    const client = createDatabaseClient(environment);
    try {
      const migrations = await loadMigrations();
      if (!await verifyExpectedSchema(client, migrations)) {
        return { checks: [fail("MIGRATIONS_0001_0008"), fail("TURSO_SYNTHETIC_ROUND_TRIP")] };
      }
    } catch {
      return { checks: [fail("TURSO_SCHEMA"), fail("TURSO_SYNTHETIC_ROUND_TRIP")] };
    } finally {
      client.close();
    }
    return { checks: await runTursoSmoke(environment) };
  }
  if (operation === "cloudinary-smoke") {
    return { checks: await runCloudinarySmoke(environment) };
  }
  return { checks: [fail("UNKNOWN_OPERATION")] };
}

function operationResponse(
  status: number,
  body: StagingOperationResult | { operation_id: string; checks: StagingOperationCheck[] },
): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function handleStagingOperationsRequest(
  request: Request,
  environment: VercelEnvironment,
  dependencies: StagingOperationsDependencies = {},
): Promise<Response> {
  const operationId = randomUUID();
  if (request.method !== "POST") {
    return operationResponse(405, { operation_id: operationId, checks: [fail("METHOD_NOT_ALLOWED")] });
  }
  if (request.headers.has("origin") || request.headers.get("sec-fetch-site") === "cross-site") {
    return operationResponse(403, { operation_id: operationId, checks: [fail("BROWSER_REQUEST_DENIED")] });
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return operationResponse(415, { operation_id: operationId, checks: [fail("CONTENT_TYPE")] });
  }
  if (!secureTokenMatch(
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null,
    environment.STAGING_OPS_TOKEN,
  )) {
    return operationResponse(401, { operation_id: operationId, checks: [fail("AUTHORIZATION")] });
  }
  const guardChecks = stagingEnvironmentChecks(environment);
  const projectGuard = guardChecks.find((check) => check.name === "VERCEL_STAGING_PROJECT");
  if (projectGuard?.status !== "PASS") {
    return operationResponse(403, { operation_id: operationId, checks: guardChecks });
  }
  let body: unknown;
  try {
    const bodyText = await request.text();
    if (new TextEncoder().encode(bodyText).byteLength > 4096) {
      return operationResponse(413, { operation_id: operationId, checks: [fail("REQUEST_BODY_TOO_LARGE")] });
    }
    body = JSON.parse(bodyText);
  } catch {
    return operationResponse(400, { operation_id: operationId, checks: [fail("REQUEST_BODY")] });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return operationResponse(400, { operation_id: operationId, checks: [fail("REQUEST_BODY")] });
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) =>
    key !== "operation" && key !== "preflight_id" && key !== "region_confirmation") ||
      typeof record.operation !== "string" ||
      !EXPECTED_OPERATIONS.has(record.operation) ||
      (record.preflight_id !== undefined &&
        (typeof record.preflight_id !== "string" || record.preflight_id.length > 256)) ||
      (record.region_confirmation !== undefined &&
        typeof record.region_confirmation !== "string")) {
    return operationResponse(400, { operation_id: operationId, checks: [fail("OPERATION_NOT_ALLOWED")] });
  }
  const operation = record.operation as StagingOperation;
  if (record.preflight_id !== undefined && operation !== "turso-migrate") {
    return operationResponse(400, {
      operation_id: operationId,
      checks: [fail("OPERATION_NOT_ALLOWED")],
    });
  }
  if (operation === "turso-preflight" && record.region_confirmation !== DATABASE_REGION) {
    return operationResponse(400, {
      operation_id: operationId,
      checks: [fail("TURSO_REGION_OPERATOR_CONFIRMATION")],
    });
  }
  if (operation !== "turso-preflight" && record.region_confirmation !== undefined) {
    return operationResponse(400, {
      operation_id: operationId,
      checks: [fail("OPERATION_NOT_ALLOWED")],
    });
  }
  if (operation !== "environment-check" &&
      guardChecks.some((check) => check.status !== "PASS")) {
    return operationResponse(403, { operation_id: operationId, checks: guardChecks });
  }
  try {
    const result = await (dependencies.runOperation ?? executeStagingOperation)(
      environment,
      operation,
      typeof record.preflight_id === "string" ? record.preflight_id : null,
    );
    const checks = operation === "turso-preflight"
      ? [...result.checks, pass("TURSO_REGION_OPERATOR_CONFIRMED")]
      : result.checks;
    if (checks.some((check) =>
      !/^[A-Z0-9_]{1,60}$/.test(check.name) ||
      (check.status !== "PASS" && check.status !== "FAIL")) ||
      (result.preflight_id !== undefined &&
        (!/^[A-Za-z0-9_-]{1,256}$/.test(result.preflight_id) ||
          operation !== "turso-preflight"))) {
      return operationResponse(503, {
        operation_id: operationId,
        checks: [fail("OPERATION_RESPONSE_INVALID")],
      });
    }
    const success = checks.length > 0 &&
      checks.every((check) => check.status === "PASS");
    return operationResponse(success ? 200 : 409, {
      operation_id: operationId,
      checks,
      ...(success && result.preflight_id ? { preflight_id: result.preflight_id } : {}),
    });
  } catch {
    return operationResponse(503, { operation_id: operationId, checks: [fail("OPERATION_FAILED")] });
  }
}

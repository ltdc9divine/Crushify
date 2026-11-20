import type { SqlMigration } from "../src/database/migrations.ts";
import {
  createStagingOperationDiagnostic,
  isSafeStagingOperationErrorCode,
  stagingOperationStages,
  type StagingOperationStage,
} from "./staging-diagnostics.ts";

export const preflightReportOperation = "read-only-preflight";
export const preflightSchemaComparisonScope = "object-names-only";

export interface PreflightSuccessReport {
  status: "PASS";
  operation: typeof preflightReportOperation;
  migration_ledger: {
    exists: boolean;
    total_count: number;
    applied_count: number;
    pending_count: number;
    applied_filenames: string[];
    pending_filenames: string[];
  };
  schema: {
    status: "PASS";
    checked_object_count: number;
    comparison_scope: typeof preflightSchemaComparisonScope;
  };
  foreign_keys: {
    executed: boolean;
    status: "PASS" | "NOT_RUN";
    violation_count: 0 | null;
  };
}

export interface PreflightFailureReport {
  status: "FAIL";
  stage: StagingOperationStage;
  error_code: string | null;
}

export type PreflightReport = PreflightSuccessReport | PreflightFailureReport;

function invalidReport(): never {
  throw new Error("Invalid sanitized preflight report");
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === keys.length &&
    actual.every((key, index) => key === expected[index]);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0;
}

function validateFilenames(filenames: readonly string[]): string[] {
  const normalized = [...filenames];
  if (normalized.length === 0 || normalized.some((filename, index) => {
    if (typeof filename !== "string") return true;
    const match = filename.match(/^(\d{4})_[a-z0-9_-]+\.sql$/i);
    return !match || Number(match[1]) !== index + 1;
  })) {
    return invalidReport();
  }
  return normalized;
}

export function createPreflightSuccessReport(input: {
  migrations: readonly Pick<SqlMigration, "version" | "name">[];
  ledgerExists: boolean;
  appliedCount: number;
  foreignKeyCheckExecuted: boolean;
  foreignKeyViolationCount: number | null;
  schemaCheckedObjectCount: number;
}): PreflightSuccessReport {
  const filenames = validateFilenames(input.migrations.map(({ version, name }) =>
    `${String(version).padStart(4, "0")}_${name}.sql`));
  if (input.migrations.some((migration, index) => migration.version !== index + 1) ||
      typeof input.ledgerExists !== "boolean" ||
      !isCount(input.appliedCount) ||
      input.appliedCount > filenames.length ||
      input.ledgerExists !== (input.appliedCount > 0) ||
      input.foreignKeyCheckExecuted !== input.ledgerExists ||
      input.foreignKeyViolationCount !== (input.ledgerExists ? 0 : null) ||
      !isCount(input.schemaCheckedObjectCount) ||
      (!input.ledgerExists && input.schemaCheckedObjectCount !== 0)) {
    return invalidReport();
  }

  const report: PreflightSuccessReport = {
    status: "PASS",
    operation: preflightReportOperation,
    migration_ledger: {
      exists: input.ledgerExists,
      total_count: filenames.length,
      applied_count: input.appliedCount,
      pending_count: filenames.length - input.appliedCount,
      applied_filenames: filenames.slice(0, input.appliedCount),
      pending_filenames: filenames.slice(input.appliedCount),
    },
    schema: {
      status: "PASS",
      checked_object_count: input.schemaCheckedObjectCount,
      comparison_scope: preflightSchemaComparisonScope,
    },
    foreign_keys: {
      executed: input.foreignKeyCheckExecuted,
      status: input.foreignKeyCheckExecuted ? "PASS" : "NOT_RUN",
      violation_count: input.foreignKeyViolationCount,
    },
  };
  return parsePreflightReport(JSON.stringify(report), filenames) as PreflightSuccessReport;
}

export function createPreflightFailureReport(
  stage: StagingOperationStage,
  error: unknown,
): PreflightFailureReport {
  const diagnostic = createStagingOperationDiagnostic(stage, error);
  return {
    status: "FAIL",
    stage: diagnostic.stage,
    error_code: diagnostic.error_code ?? null,
  };
}

export function parsePreflightReport(
  text: string,
  expectedFilenames: readonly string[],
): PreflightReport {
  const filenames = validateFilenames(expectedFilenames);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalidReport();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidReport();
  }
  const report = value as Record<string, unknown>;

  if (report.status === "FAIL") {
    if (!hasExactKeys(report, ["status", "stage", "error_code"]) ||
        typeof report.stage !== "string" ||
        !stagingOperationStages.includes(report.stage as StagingOperationStage) ||
        (report.error_code !== null &&
          !isSafeStagingOperationErrorCode(report.error_code))) {
      return invalidReport();
    }
    return {
      status: "FAIL",
      stage: report.stage as StagingOperationStage,
      error_code: report.error_code as string | null,
    };
  }

  if (!hasExactKeys(report, [
    "status",
    "operation",
    "migration_ledger",
    "schema",
    "foreign_keys",
  ]) ||
      report.status !== "PASS" ||
      report.operation !== preflightReportOperation ||
      !report.migration_ledger ||
      typeof report.migration_ledger !== "object" ||
      Array.isArray(report.migration_ledger) ||
      !report.schema ||
      typeof report.schema !== "object" ||
      Array.isArray(report.schema) ||
      !report.foreign_keys ||
      typeof report.foreign_keys !== "object" ||
      Array.isArray(report.foreign_keys)) {
    return invalidReport();
  }

  const ledger = report.migration_ledger as Record<string, unknown>;
  const schema = report.schema as Record<string, unknown>;
  const foreignKeys = report.foreign_keys as Record<string, unknown>;
  if (!hasExactKeys(ledger, [
    "exists",
    "total_count",
    "applied_count",
    "pending_count",
    "applied_filenames",
    "pending_filenames",
  ]) ||
      !hasExactKeys(schema, ["status", "checked_object_count", "comparison_scope"]) ||
      !hasExactKeys(foreignKeys, ["executed", "status", "violation_count"]) ||
      typeof ledger.exists !== "boolean" ||
      ledger.total_count !== filenames.length ||
      !isCount(ledger.applied_count) ||
      !isCount(ledger.pending_count) ||
      ledger.applied_count + ledger.pending_count !== filenames.length ||
      !Array.isArray(ledger.applied_filenames) ||
      !Array.isArray(ledger.pending_filenames) ||
      !ledger.applied_filenames.every((filename) => typeof filename === "string") ||
      !ledger.pending_filenames.every((filename) => typeof filename === "string") ||
      JSON.stringify([...ledger.applied_filenames, ...ledger.pending_filenames]) !==
        JSON.stringify([
          ...filenames.slice(0, ledger.applied_count),
          ...filenames.slice(ledger.applied_count),
        ]) ||
      ledger.applied_filenames.length !== ledger.applied_count ||
      ledger.pending_filenames.length !== ledger.pending_count ||
      ledger.exists !== (ledger.applied_count > 0) ||
      schema.status !== "PASS" ||
      !isCount(schema.checked_object_count) ||
      schema.comparison_scope !== preflightSchemaComparisonScope ||
      foreignKeys.executed !== ledger.exists ||
      foreignKeys.status !== (ledger.exists ? "PASS" : "NOT_RUN") ||
      foreignKeys.violation_count !== (ledger.exists ? 0 : null) ||
      (!ledger.exists && schema.checked_object_count !== 0)) {
    return invalidReport();
  }
  return report as unknown as PreflightSuccessReport;
}

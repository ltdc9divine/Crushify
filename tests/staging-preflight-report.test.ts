import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPreflightFailureReport,
  createPreflightSuccessReport,
  parsePreflightReport,
} from "../scripts/staging-preflight-report.ts";

const migrations = [
  { version: 1, name: "initial_schema" },
  { version: 2, name: "auth_previews_and_uploads" },
  { version: 3, name: "local_test_payments" },
];
const filenames = migrations.map(({ version, name }) =>
  `${String(version).padStart(4, "0")}_${name}.sql`);

describe("sanitized staging preflight reports", () => {
  it("reports applied and pending migrations from an existing ledger", () => {
    const report = createPreflightSuccessReport({
      migrations,
      ledgerExists: true,
      appliedCount: 2,
      foreignKeyCheckExecuted: true,
      foreignKeyViolationCount: 0,
      schemaCheckedObjectCount: 17,
    });

    assert.deepEqual(report.migration_ledger, {
      exists: true,
      total_count: 3,
      applied_count: 2,
      pending_count: 1,
      applied_filenames: filenames.slice(0, 2),
      pending_filenames: filenames.slice(2),
    });
    assert.deepEqual(report.foreign_keys, {
      executed: true,
      status: "PASS",
      violation_count: 0,
    });
  });

  it("reports all local migrations pending and foreign-key check not run without a ledger", () => {
    const report = createPreflightSuccessReport({
      migrations,
      ledgerExists: false,
      appliedCount: 0,
      foreignKeyCheckExecuted: false,
      foreignKeyViolationCount: null,
      schemaCheckedObjectCount: 0,
    });

    assert.equal(report.migration_ledger.exists, false);
    assert.equal(report.migration_ledger.applied_count, 0);
    assert.equal(report.migration_ledger.pending_count, 3);
    assert.deepEqual(report.migration_ledger.pending_filenames, filenames);
    assert.deepEqual(report.foreign_keys, {
      executed: false,
      status: "NOT_RUN",
      violation_count: null,
    });
  });

  it("labels the schema check as object-names-only and rejects fake FK violations", () => {
    const input = {
      migrations,
      ledgerExists: true,
      appliedCount: 1,
      foreignKeyCheckExecuted: true,
      foreignKeyViolationCount: 0,
      schemaCheckedObjectCount: 8,
    };
    const report = createPreflightSuccessReport(input);
    assert.deepEqual(report.schema, {
      status: "PASS",
      checked_object_count: 8,
      comparison_scope: "object-names-only",
    });
    assert.throws(
      () => createPreflightSuccessReport({ ...input, foreignKeyViolationCount: 2 }),
      /Invalid sanitized preflight report/,
    );
  });

  it("rejects filenames that are not in the validated local migration list", () => {
    const report = createPreflightSuccessReport({
      migrations,
      ledgerExists: true,
      appliedCount: 1,
      foreignKeyCheckExecuted: true,
      foreignKeyViolationCount: 0,
      schemaCheckedObjectCount: 8,
    });
    const tampered = {
      ...report,
      migration_ledger: {
        ...report.migration_ledger,
        pending_filenames: ["0002_customer_private_data.sql", filenames[2]],
      },
    };

    assert.throws(
      () => parsePreflightReport(JSON.stringify(tampered), filenames),
      /Invalid sanitized preflight report/,
    );
    assert.throws(
      () => createPreflightSuccessReport({
        migrations: [{ version: 1, name: "private data" }],
        ledgerExists: false,
        appliedCount: 0,
        foreignKeyCheckExecuted: false,
        foreignKeyViolationCount: null,
        schemaCheckedObjectCount: 0,
      }),
      /Invalid sanitized preflight report/,
    );
  });

  it("rejects malformed or unexpected reports without echoing content", () => {
    assert.throws(
      () => parsePreflightReport("{not-json", filenames),
      /Invalid sanitized preflight report/,
    );
    const report = createPreflightSuccessReport({
      migrations,
      ledgerExists: false,
      appliedCount: 0,
      foreignKeyCheckExecuted: false,
      foreignKeyViolationCount: null,
      schemaCheckedObjectCount: 0,
    });
    assert.throws(
      () => parsePreflightReport(
        JSON.stringify({ ...report, database_url: "url-secret" }),
        filenames,
      ),
      /Invalid sanitized preflight report/,
    );
  });

  it("keeps failure reports to sanitized stage and allowlisted error code", () => {
    const error = Object.assign(
      new Error("database-url-secret auth-token-secret"),
      { code: "token-secret" },
    );
    const report = createPreflightFailureReport("read-schema", error);
    const serialized = JSON.stringify(report);

    assert.deepEqual(report, {
      status: "FAIL",
      stage: "read-schema",
      error_code: null,
    });
    assert.equal(serialized.includes("secret"), false);
    assert.deepEqual(
      parsePreflightReport(serialized, filenames),
      report,
    );
  });
});

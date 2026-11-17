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
      assert.deepEqual(await applyMigrations(client, migrations),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
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
        [11, "asset_reference_and_upload_attempts"],
        [12, "lifecycle_retention_and_upload_recovery"],
        [13, "publication_derivative_operations"],
        [14, "derivative_provider_success_reconciliation"],
        [15, "payment_settlement_evidence"],
        [16, "sepay_api_v2_reconciliation"],
        [17, "sepay_api_reconciliation_continuation"],
        [18, "webhook_only_settlement_evidence"],
        [19, "custom_design_requests"],
        [20, "custom_design_admin_review"],
        [21, "admin_activity_audit"],
        [22, "custom_design_customer_replies"],
        [23, "manual_bank_transfer_settlement"],
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
      const derivativeOperationColumns = await client.execute(
        "PRAGMA table_info('publication_derivative_operations')",
      );
      assert.ok(derivativeOperationColumns.rows.some((row) => row.name === "operation_token"));
      assert.ok(derivativeOperationColumns.rows.some((row) => row.name === "cleanup_lease_token"));
      assert.ok(derivativeOperationColumns.rows.some(
        (row) => row.name === "provider_create_succeeded_at",
      ));
      const evidenceIndexes = await client.execute(
        "PRAGMA index_list('payment_settlement_evidence')",
      );
      assert.ok(evidenceIndexes.rows.some((row) =>
        Number(row.unique) === 1 && String(row.name).startsWith("sqlite_autoindex_")
      ));
      assert.ok(evidenceIndexes.rows.some((row) =>
        row.name === "payment_settlement_evidence_payment_status"
      ));
      const apiObservationColumns = await client.execute(
        "PRAGMA table_info('sepay_api_observations')",
      );
      const apiObservationColumnNames = apiObservationColumns.rows.map((row) => row.name);
      assert.ok(apiObservationColumnNames.includes("transaction_uuid"));
      assert.ok(apiObservationColumnNames.includes("payload_hash"));
      assert.ok(apiObservationColumnNames.includes("status"));
      assert.ok(!apiObservationColumnNames.includes("account_number"));
      assert.ok(!apiObservationColumnNames.includes("transaction_content"));
      assert.ok(!apiObservationColumnNames.includes("currency"));
      const reconciliationCursorColumns = await client.execute(
        "PRAGMA table_info('sepay_api_reconciliation_cursors')",
      );
      assert.ok(reconciliationCursorColumns.rows.some((row) => row.name === "lease_token"));
      assert.ok(reconciliationCursorColumns.rows.some((row) => row.name === "scan_completed_at"));
      const requestColumns = await client.execute("PRAGMA table_info('custom_design_requests')");
      assert.ok(requestColumns.rows.some((row) => row.name === "customer_message"));
      assert.ok(requestColumns.rows.some((row) => row.name === "last_admin_event_id"));
      const reviewTriggers = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'custom_design_request_events_immutable_%'",
      );
      assert.equal(reviewTriggers.rows.length, 2);
      const adminActivityTriggers = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'admin_activity_events_immutable_%'",
      );
      assert.equal(adminActivityTriggers.rows.length, 2);
      const customerReplyTable = await client.execute("PRAGMA table_info('custom_design_customer_replies')");
      const customerReplyColumns = customerReplyTable.rows.map((row) => row.name);
      assert.ok(customerReplyColumns.includes("customer_id"));
      assert.ok(customerReplyColumns.includes("idempotency_key"));
      assert.ok(customerReplyColumns.includes("reply_hash"));
      assert.ok(customerReplyColumns.includes("message"));
      const customerReplyTriggers = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'custom_design_customer_replies_%'",
      );
      assert.equal(customerReplyTriggers.rows.length, 3);
      const customRequestTable = await client.execute("PRAGMA table_info('custom_design_requests')");
      assert.ok(customRequestTable.rows.some((row) =>
        row.name === "customer_reply_submission_token"
      ));

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

  it("enforces foreign keys in the transaction that runs a migration", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const migrations: SqlMigration[] = [
      {
        version: 1,
        name: "initial",
        sql: `
          CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            checksum TEXT NOT NULL,
            applied_at TEXT NOT NULL
          );
          CREATE TABLE parents (id TEXT PRIMARY KEY);
          INSERT INTO parents (id) VALUES ('present');
          CREATE TABLE children (
            id TEXT PRIMARY KEY,
            parent_id TEXT NOT NULL REFERENCES parents(id)
          );
        `,
      },
      {
        version: 2,
        name: "foreign_key_probe",
        sql: `
          CREATE TABLE migration_two_partial (id TEXT PRIMARY KEY);
          INSERT INTO migration_two_partial (id) VALUES ('must-rollback');
          INSERT INTO children (id, parent_id) VALUES ('orphan', 'missing');
        `,
      },
    ];

    try {
      await assert.rejects(
        applyMigrations(client, migrations),
        /FOREIGN KEY constraint failed/i,
      );

      const ledger = await client.execute(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      assert.deepEqual(ledger.rows.map((row) => Number(row.version)), [1]);
      const parentCount = await client.execute(
        "SELECT COUNT(*) AS count FROM parents WHERE id = 'present'",
      );
      assert.equal(Number(parentCount.rows[0]?.count), 1);
      const childCount = await client.execute("SELECT COUNT(*) AS count FROM children");
      assert.equal(Number(childCount.rows[0]?.count), 0);
      const failedMigrationTable = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_two_partial'",
      );
      assert.equal(failedMigrationTable.rows.length, 0);
    } finally {
      client.close();
    }
  });

  it("rolls back a failed migration, retains prior commits, and resumes cleanly", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const initial: SqlMigration = {
      version: 1,
      name: "initial",
      sql: `
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE committed_state (id TEXT PRIMARY KEY);
        INSERT INTO committed_state (id) VALUES ('version-one');
      `,
    };
    const failing: SqlMigration = {
      version: 2,
      name: "injected_failure",
      sql: `
        CREATE TABLE migration_two_partial (id TEXT PRIMARY KEY);
        INSERT INTO migration_two_partial (id) VALUES ('must-rollback');
        INSERT INTO table_that_does_not_exist (id) VALUES ('fail');
      `,
    };

    try {
      await assert.rejects(
        applyMigrations(client, [initial, failing]),
        /no such table/i,
      );

      const ledgerAfterFailure = await client.execute(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      assert.deepEqual(ledgerAfterFailure.rows.map((row) => Number(row.version)), [1]);
      const committedState = await client.execute(
        "SELECT id FROM committed_state WHERE id = 'version-one'",
      );
      assert.equal(committedState.rows.length, 1);
      const failedMigrationTable = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_two_partial'",
      );
      assert.equal(failedMigrationTable.rows.length, 0);

      const repaired: SqlMigration[] = [
        initial,
        {
          version: 2,
          name: "injected_failure",
          sql: `
            CREATE TABLE migration_two_partial (id TEXT PRIMARY KEY);
            INSERT INTO migration_two_partial (id) VALUES ('recovered');
          `,
        },
        {
          version: 3,
          name: "after_recovery",
          sql: "CREATE TABLE migration_three_complete (id TEXT PRIMARY KEY);",
        },
      ];
      assert.deepEqual(await applyMigrations(client, repaired), [2, 3]);

      const finalLedger = await client.execute(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      assert.deepEqual(finalLedger.rows.map((row) => Number(row.version)), [1, 2, 3]);
      const recoveredRow = await client.execute(
        "SELECT id FROM migration_two_partial WHERE id = 'recovered'",
      );
      assert.equal(recoveredRow.rows.length, 1);
      const completeTable = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_three_complete'",
      );
      assert.equal(completeTable.rows.length, 1);
    } finally {
      client.close();
    }
  });

  it("upgrades the 0011 schema with retention and upload reconciliation safeguards", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    try {
      const migrations = await loadMigrations();
      assert.deepEqual(
        await applyMigrations(client, migrations.filter((migration) => migration.version <= 11)),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      );
      const before = await client.execute("PRAGMA table_info('asset_upload_attempts')");
      assert.ok(!before.rows.some((row) => row.name === "reconciliation_state"));

      assert.deepEqual(await applyMigrations(client, migrations),
        [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
      const after = await client.execute("PRAGMA table_info('asset_upload_attempts')");
      assert.ok(after.rows.some((row) => row.name === "reconciliation_state"));
      const indexes = await client.execute("PRAGMA index_list('asset_upload_attempts')");
      assert.ok(indexes.rows.some((row) => row.name === "upload_attempts_reconciliation"));
      assert.deepEqual(await client.execute("PRAGMA foreign_key_check").then((result) => result.rows), []);
    } finally {
      client.close();
    }
  });

  it("marks only READY derivative operations as confirmed provider successes", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    try {
      const migrations = await loadMigrations();
      assert.deepEqual(
        await applyMigrations(client, migrations.filter((migration) => migration.version <= 13)),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
      );
      const updatedAt = "2026-01-01T00:00:00.000Z";
      const future = "2099-01-01T00:00:00.000Z";
      for (const [id, status, lease] of [
        ["ready", "READY", future],
        ["creating", "CREATING", future],
        ["cleaned-uncertain", "CLEANED", future],
        ["cleaned-expired-lease", "CLEANED", updatedAt],
      ]) {
        await client.execute({
          sql: `INSERT INTO publication_derivative_operations (
            id, publication_asset_id, publication_id, derivative_key, status, operation_token,
            operation_lease_expires_at, next_cleanup_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            id, `asset-${id}`, `publication-${id}`, `published/${id}.png`, status,
            `token-${id}`, lease, future, updatedAt, updatedAt,
          ],
        });
      }

      assert.deepEqual(await applyMigrations(
        client, migrations,
      ), [14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
      assert.deepEqual((await client.execute(
        `SELECT id, provider_create_succeeded_at, next_cleanup_at
         FROM publication_derivative_operations ORDER BY id`,
      )).rows, [
        {
          id: "cleaned-expired-lease",
          provider_create_succeeded_at: null,
          next_cleanup_at: future,
        },
        {
          id: "cleaned-uncertain",
          provider_create_succeeded_at: null,
          next_cleanup_at: future,
        },
        {
          id: "creating",
          provider_create_succeeded_at: null,
          next_cleanup_at: future,
        },
        {
          id: "ready",
          provider_create_succeeded_at: updatedAt,
          next_cleanup_at: future,
        },
      ]);
      assert.deepEqual(
        await applyMigrations(client, migrations),
        [],
      );
    } finally {
      client.close();
    }
  });

  it("backfills only complete, consistent legacy settlement evidence", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const timestamp = "2026-11-15T12:00:00.000Z";
    try {
      const migrations = await loadMigrations();
      assert.deepEqual(await applyMigrations(
        client,
        migrations.filter((migration) => migration.version <= 14),
      ), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
      await client.execute({
        sql: `INSERT INTO customers (
          id, email, email_normalized, status, created_at, updated_at
        ) VALUES ('evidence-customer', 'evidence@example.test',
          'evidence@example.test', 'ACTIVE', ?, ?)`,
        args: [timestamp, timestamp],
      });

      const cases = [
        { id: "valid", status: "PAID", paidAt: timestamp, total: 1000, amount: 1000, orderCurrency: "VND", paymentCurrency: "VND", review: 0, event: "PROCESSED" },
        { id: "missing-id", status: "PAID", paidAt: timestamp, total: 1000, amount: 1000, orderCurrency: "VND", paymentCurrency: "VND", review: 0, event: null },
        { id: "amount-mismatch", status: "PAID", paidAt: timestamp, total: 1200, amount: 1000, orderCurrency: "VND", paymentCurrency: "VND", review: 0, event: "PROCESSED" },
        { id: "currency-mismatch", status: "PAID", paidAt: timestamp, total: 1000, amount: 1000, orderCurrency: "USD", paymentCurrency: "VND", review: 0, event: "PROCESSED" },
        { id: "state-mismatch", status: "AWAITING_PAYMENT", paidAt: null, total: 1000, amount: 1000, orderCurrency: "VND", paymentCurrency: "VND", review: 0, event: "PROCESSED" },
        { id: "manual-review", status: "PAID", paidAt: timestamp, total: 1000, amount: 1000, orderCurrency: "VND", paymentCurrency: "VND", review: 1, event: "MANUAL_REVIEW" },
      ] as const;
      for (const candidate of cases) {
        const orderId = `order-${candidate.id}`;
        const paymentId = `payment-${candidate.id}`;
        const transactionId = candidate.id === "missing-id" ? null : `transaction-${candidate.id}`;
        await client.execute({
          sql: `INSERT INTO orders (
            id, customer_id, order_type, status, currency, subtotal_minor,
            discount_minor, total_minor, idempotency_key, created_at, updated_at,
            paid_at, order_reference, payment_review_required
          ) VALUES (?, 'evidence-customer', 'SELF_SERVICE', ?, ?, ?, 0, ?,
            ?, ?, ?, ?, ?, ?)`,
          args: [
            orderId, candidate.status, candidate.orderCurrency,
            candidate.total, candidate.total, orderId,
            timestamp, timestamp, candidate.paidAt, `reference-${candidate.id}`, candidate.review,
          ],
        });
        await client.execute({
          sql: `INSERT INTO payments (
            id, order_id, provider, provider_payment_id, status, amount_minor, currency,
            idempotency_key, created_at, updated_at, succeeded_at, payment_reference, review_required
          ) VALUES (?, ?, 'SEPAY', ?, 'SUCCEEDED', ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            paymentId, orderId, transactionId, candidate.amount,
            candidate.paymentCurrency, paymentId, timestamp, timestamp, timestamp,
            `payment-reference-${candidate.id}`, candidate.review,
          ],
        });
        if (candidate.event) {
          await client.execute({
            sql: `INSERT INTO payment_webhook_events (
              id, provider, event_id, payload_hash, received_at, processed_at, outcome,
              raw_payload, review_reason, provider_transaction_id,
              order_reference, expected_amount_minor, actual_amount_minor
            ) VALUES (?, 'SEPAY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
              `event-${candidate.id}`, transactionId, "a".repeat(64), timestamp, timestamp,
              candidate.event, JSON.stringify({ id: transactionId }),
              candidate.event === "PROCESSED" ? null : "Manual review required",
              transactionId, `reference-${candidate.id}`, candidate.amount, candidate.amount,
            ],
          });
        }
      }

      assert.deepEqual(await applyMigrations(client, migrations), [15, 16, 17, 18, 19, 20, 21, 22, 23]);
      const evidence = await client.execute(
        `SELECT payment_id, evidence_source, source_transaction_id, amount_minor,
                currency, verified_at, status
         FROM payment_settlement_evidence`,
      );
      assert.deepEqual(evidence.rows, [{
        payment_id: "payment-valid",
        evidence_source: "SEPAY_WEBHOOK",
        source_transaction_id: "transaction-valid",
        amount_minor: 1000,
        currency: "VND",
        verified_at: timestamp,
        status: "VERIFIED",
      }]);

      const unchanged = await client.execute(
        `SELECT o.id, o.status AS order_status, p.status AS payment_status
         FROM orders o JOIN payments p ON p.order_id = o.id ORDER BY o.id`,
      );
      assert.ok(unchanged.rows.every((row) =>
        row.payment_status === "SUCCEEDED" &&
        row.order_status === cases.find((candidate) => `order-${candidate.id}` === row.id)?.status
      ));

      await assert.rejects(client.execute({
        sql: `INSERT INTO payment_settlement_evidence (
          id, payment_id, provider, evidence_source, source_transaction_id,
          amount_minor, currency, verified_at, payload_hash, status, created_at
        ) VALUES ('api-observation', 'payment-valid', 'SEPAY', 'SEPAY_API_V2',
          'transaction-valid', 1000, 'VND', ?, ?, 'VERIFIED', ?)`,
        args: [timestamp, "b".repeat(64), timestamp],
      }));
      await assert.rejects(client.execute({
        sql: `INSERT INTO payment_settlement_evidence (
          id, payment_id, provider, evidence_source, source_transaction_id,
          amount_minor, currency, verified_at, payload_hash, status, created_at
        ) VALUES ('api-observation-conflict', 'payment-valid', 'SEPAY', 'SEPAY_API_V2',
          'cross-source-transaction', 1000, 'VND', ?, ?, 'VERIFIED', ?)`,
        args: [timestamp, "e".repeat(64), timestamp],
      }));
      await client.execute({
        sql: `INSERT INTO sepay_api_observations (
          transaction_uuid, bank_account_id, transaction_date, transfer_type,
          amount_in, amount_out, payload_hash, scan_type, status, reason_code,
          payment_id, first_observed_at, last_observed_at
        ) VALUES ('12345678-1234-4234-8234-123456789abc',
          'f9e8d7c6-b5a4-3210-fedc-ba0987654321', ?, 'in', 1000, 0,
          ?, 'DATE_WINDOW', 'MANUAL_REVIEW', 'TEST_ONLY', 'payment-valid', ?, ?)`,
        args: [timestamp, "b".repeat(64), timestamp, timestamp],
      });
      await assert.rejects(client.execute({
        sql: `INSERT INTO payment_settlement_evidence (
          id, payment_id, provider, evidence_source, source_transaction_id,
          amount_minor, currency, verified_at, payload_hash, status, created_at
        ) VALUES ('webhook-cross-payment', 'payment-missing-id', 'SEPAY', 'SEPAY_WEBHOOK',
          'transaction-valid', 1000, 'VND', ?, ?, 'VERIFIED', ?)` ,
        args: [timestamp, "f".repeat(64), timestamp],
      }));
      await client.execute({
        sql: `INSERT INTO payment_settlement_evidence (
          id, payment_id, provider, evidence_source, source_transaction_id,
          amount_minor, currency, verified_at, payload_hash, status, created_at
        ) VALUES ('webhook-update-source', 'payment-valid', 'SEPAY', 'SEPAY_WEBHOOK',
          'update-source-transaction', 1000, 'VND', ?, ?, 'VERIFIED', ?)`,
        args: [timestamp, "1".repeat(64), timestamp],
      });
      await assert.rejects(client.execute(
        `UPDATE payment_settlement_evidence SET evidence_source = 'SEPAY_API_V2'
         WHERE id = 'webhook-update-source'`,
      ));
      await assert.rejects(client.execute(
        "UPDATE payment_settlement_evidence SET provider = 'OTHER' WHERE id = 'webhook-update-source'",
      ));
      await assert.rejects(client.execute({
        sql: `INSERT INTO payment_settlement_evidence (
          id, payment_id, provider, evidence_source, source_transaction_id,
          amount_minor, currency, verified_at, payload_hash, status, created_at
        ) VALUES ('duplicate-source', 'payment-missing-id', 'SEPAY', 'SEPAY_WEBHOOK',
          'transaction-valid', 1000, 'VND', ?, ?, 'VERIFIED', ?)`,
        args: [timestamp, "c".repeat(64), timestamp],
      }));
      await assert.rejects(client.execute({
        sql: `INSERT INTO payment_settlement_evidence (
          id, payment_id, provider, evidence_source, source_transaction_id,
          amount_minor, currency, verified_at, payload_hash, created_at
        ) VALUES ('empty-source', 'payment-valid', 'SEPAY', 'SEPAY_WEBHOOK',
          '   ', 1000, 'VND', ?, ?, ?)`,
        args: [timestamp, "d".repeat(64), timestamp],
      }));
      await assert.rejects(client.execute(
        "DELETE FROM payments WHERE id = 'payment-valid'",
      ));
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

      assert.deepEqual(await applyMigrations(client, migrations),
        [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
      const attempts = await client.execute(
        "SELECT reconciliation_state FROM asset_upload_attempts ORDER BY session_id",
      );
      assert.deepEqual(attempts.rows, [
        { reconciliation_state: "ACTIVE" },
        { reconciliation_state: "ACTIVE" },
      ]);
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

      assert.deepEqual(await applyMigrations(client, migrations),
        [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
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

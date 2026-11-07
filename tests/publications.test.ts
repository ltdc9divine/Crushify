import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createClient, type Client } from "@libsql/client";
import { TursoDatabaseAdapter } from "../src/database/turso.ts";
import { applyMigrations, type SqlMigration } from "../src/database/migrations.ts";
import { handleApiRequest } from "../src/index.ts";
import { runPublicationLifecycle } from "../src/publications.ts";
import type { Storage, StorageObject } from "../src/storage.ts";

const NOW = new Date("2099-01-31T12:00:00.000Z");
const IMAGE = new Uint8Array([1, 2, 3]);

async function loadMigrations(): Promise<SqlMigration[]> {
  const directory = join(process.cwd(), "migrations");
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
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

function createStorage(failures: { derivative: number; source: number }): Storage {
  const objects = new Map<string, Uint8Array>();
  const asObject = (key: string): StorageObject | null => {
    const bytes = objects.get(key);
    if (!bytes) return null;
    return {
      size: bytes.byteLength,
      contentType: "image/png",
      body: new Response(bytes).body,
      arrayBuffer: async () => bytes.slice().buffer,
    };
  };
  return {
    async upload(key, bytes) { objects.set(key, new Uint8Array(bytes)); },
    async get(key) { return asObject(key); },
    async delete(key) {
      if (failures.source > 0) {
        failures.source--;
        throw new Error("Injected source cleanup failure");
      }
      objects.delete(key);
    },
    async privateAssetUrl() { return null; },
    async createPublishedDerivative(source, derivative) {
      const bytes = objects.get(source);
      if (!bytes) throw new Error("Source asset is missing");
      objects.set(derivative, new Uint8Array(bytes));
    },
    async getPublishedDerivative(key) { return asObject(key); },
    async deletePublishedDerivative(key) {
      if (failures.derivative > 0) {
        failures.derivative--;
        throw new Error("Injected derivative cleanup failure");
      }
      objects.delete(key);
    },
  };
}

async function createFixture(
  client: Client,
  options: {
    status?: "PUBLISHED" | "EXPIRED";
    expiresAt: string | null;
    retentionUntil?: string | null;
    lifetime?: boolean;
    withAsset?: boolean;
    extraOrderStatus?: "AWAITING_PAYMENT" | "PAID";
  },
) {
  const id = () => randomUUID();
  const customerId = id();
  const designId = id();
  const orderId = id();
  const publicationId = id();
  const publicationAssetId = id();
  const assetId = id();
  const slug = `g${id().replaceAll("-", "")}`;
  const now = NOW.toISOString();
  const template = await client.execute(
    "SELECT default_data_json FROM template_versions WHERE template_id = 'our-universe' AND schema_version = 1",
  );
  const data = String(template.rows[0]?.default_data_json);
  const lifetime = options.lifetime ?? false;
  const planId = lifetime ? "lifetime" : "1-month";
  await client.batch([
    {
      sql: `INSERT INTO customers (id, email, email_normalized, status, created_at, updated_at)
            VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
      args: [customerId, `${customerId}@example.test`, `${customerId}@example.test`, now, now],
    },
    {
      sql: `INSERT INTO designs (
              id, customer_id, template_id, schema_version, data_json, revision, status, created_at, updated_at
            ) VALUES (?, ?, 'our-universe', 1, ?, 1, 'DRAFT', ?, ?)`,
      args: [designId, customerId, data, now, now],
    },
    {
      sql: `INSERT INTO design_revisions (design_id, revision, data_json, created_at)
            VALUES (?, 1, ?, ?)`,
      args: [designId, data, now],
    },
    {
      sql: `INSERT INTO orders (
              id, customer_id, order_type, status, currency, subtotal_minor, discount_minor, total_minor,
              design_id, idempotency_key, created_at, updated_at, paid_at, expires_at, order_reference,
              design_revision, request_hash, payment_review_required
            ) VALUES (?, ?, 'SELF_SERVICE', 'FULFILLED', 'VND', 1000, 0, 1000, ?, ?, ?, ?, ?, NULL, ?, 1, ?, 0)`,
      args: [orderId, customerId, designId, id(), now, now, now, `CRF${id()}`, "a".repeat(64)],
    },
    {
      sql: `INSERT INTO order_items (
              id, order_id, item_type, reference_id, description_snapshot, quantity, unit_amount_minor,
              line_total_minor, metadata_json, created_at
            ) VALUES (?, ?, 'TEMPLATE_LICENSE', 'our-universe', 'Our Universe', 1, 1000, 1000, ?, ?)`,
      args: [id(), orderId, '{"schema_version":1}', now],
    },
    {
      sql: `INSERT INTO order_items (
              id, order_id, item_type, reference_id, description_snapshot, quantity, unit_amount_minor,
              line_total_minor, metadata_json, created_at
            ) VALUES (?, ?, 'ADD_ON', ?, 'Storage', 1, 0, 0, ?, ?)`,
      args: [id(), orderId, planId, JSON.stringify({
        kind: "STORAGE_PLAN",
        storage_plan_id: planId,
        title: lifetime ? "Lifetime" : "1 month",
        duration_months: lifetime ? null : 1,
        lifetime,
      }), now],
    },
    {
      sql: `INSERT INTO payments (
              id, order_id, provider, provider_payment_id, status, amount_minor, currency,
              idempotency_key, created_at, updated_at, succeeded_at, payment_reference, review_required
            ) VALUES (?, ?, 'SEPAY', ?, 'SUCCEEDED', 1000, 'VND', ?, ?, ?, ?, ?, 0)`,
      args: [id(), orderId, id(), id(), now, now, now, `CRP${id()}`],
    },
    {
      sql: `INSERT INTO payment_webhook_events (
              id, provider, event_id, payload_hash, received_at, processed_at, outcome, raw_payload
            ) SELECT ?, 'SEPAY', provider_payment_id, ?, ?, ?, 'PROCESSED', '{}'
              FROM payments WHERE order_id = ?`,
      args: [id(), "b".repeat(64), now, now, orderId],
    },
    {
      sql: `INSERT INTO publications (
              id, design_id, order_id, published_revision, template_id, schema_version, renderer_version,
              slug, slug_hash, snapshot_json, status, lifecycle_revision, activated_at, original_expires_at,
              expires_at, expired_at, retention_delete_after_at, published_at, created_at, updated_at
            ) VALUES (?, ?, ?, 1, 'our-universe', 1, '1.0.0', ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        publicationId, designId, orderId, slug,
        createHash("sha256").update(slug).digest("hex"), JSON.stringify({ data }),
        options.status ?? "PUBLISHED", now, now, options.expiresAt, options.status === "EXPIRED" ? now : null,
        options.retentionUntil ?? null, now, now, now,
      ],
    },
    {
      sql: `INSERT INTO storage_entitlements (
              id, publication_id, order_id, storage_plan_id, duration_months, activated_at, starts_at,
              previous_expires_at, expires_at, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      args: [
        id(), publicationId, orderId, planId, lifetime ? null : 1, now, now, options.expiresAt,
        lifetime ? "LIFETIME" : options.status === "EXPIRED" ? "EXPIRED" : "ACTIVE", now,
      ],
    },
  ]);
  let extraOrderId: string | undefined;
  if (options.extraOrderStatus) {
    extraOrderId = id();
    await client.execute({
      sql: `INSERT INTO orders (
              id, customer_id, order_type, status, currency, subtotal_minor, discount_minor, total_minor,
              design_id, idempotency_key, created_at, updated_at, paid_at, expires_at, order_reference,
              design_revision, request_hash, payment_review_required
            ) VALUES (?, ?, 'SELF_SERVICE', ?, 'VND', 1000, 0, 1000, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0)`,
      args: [
        extraOrderId, customerId, options.extraOrderStatus, designId, id(), now, now,
        options.extraOrderStatus === "PAID" ? now : null,
        options.extraOrderStatus === "AWAITING_PAYMENT" ? "2099-02-02T00:00:00.000Z" : null,
        `CRF${id().replaceAll("-", "").slice(0, 16).toUpperCase()}`, "c".repeat(64),
      ],
    });
  }
  if (options.withAsset) {
    const sourceKey = `private/${assetId}.png`;
    const derivativeKey = `published/${assetId}.png`;
    await client.execute({
      sql: `INSERT INTO assets (
              id, customer_id, design_id, object_key, visibility, status, media_type, byte_size,
              sha256, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'PRIVATE', 'READY', 'image/png', ?, ?, ?, ?)`,
      args: [assetId, customerId, designId, sourceKey, IMAGE.length, "d".repeat(64), now, now],
    });
    await client.execute({
      sql: `INSERT INTO publication_assets (
              id, publication_id, asset_id, customer_id, consent_version, consented_at,
              derivative_key, derivative_status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'public-image-v1', ?, ?, 'READY', ?, ?)`,
      args: [publicationAssetId, publicationId, assetId, customerId, now, derivativeKey, now, now],
    });
    return {
      customerId, designId, orderId, publicationId, publicationAssetId, assetId, slug,
      sourceKey, derivativeKey, extraOrderId,
    };
  }
  return { customerId, designId, orderId, publicationId, slug, extraOrderId };
}

describe("publication expiration lifecycle", () => {
  it("expires exact-boundary rows in bounded batches and leaves future and lifetime rows active", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createStorage({ derivative: 0, source: 0 });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const expired = await Promise.all([
        createFixture(client, { expiresAt: "2099-01-31T11:59:59.999Z" }),
        createFixture(client, { expiresAt: NOW.toISOString() }),
        createFixture(client, { expiresAt: "2099-01-31T11:00:00.000Z" }),
      ]);
      const future = await createFixture(client, { expiresAt: "2099-01-31T12:00:00.001Z" });
      const lifetime = await createFixture(client, { expiresAt: null, lifetime: true });
      const env = {
        DB: adapter,
        STORAGE: storage,
        DATA_RETENTION_DAYS: "30",
      } as Parameters<typeof runPublicationLifecycle>[0];

      const firstBatch = await runPublicationLifecycle(env, { limit: 2, now: NOW });
      assert.equal(firstBatch.expired, 2);
      for (const fixture of [expired[0], expired[2]]) {
        const row = await client.execute({
          sql: "SELECT status, expires_at, retention_delete_after_at FROM publications WHERE id = ?",
          args: [fixture.publicationId],
        });
        assert.equal(row.rows[0]?.status, "EXPIRED");
        assert.equal(row.rows[0]?.retention_delete_after_at, "2099-03-02T12:00:00.000Z");
        const denied = await handleApiRequest(
          new Request(`https://crushify.test/api/v1/publications/${fixture.slug}`),
          env,
        );
        assert.equal(denied.status, 410);
      }

      const secondBatch = await runPublicationLifecycle(env, { limit: 2, now: NOW });
      assert.equal(secondBatch.expired, 1);
      const exactBoundary = await client.execute({
        sql: "SELECT status FROM publications WHERE id = ?",
        args: [expired[1].publicationId],
      });
      assert.equal(exactBoundary.rows[0]?.status, "EXPIRED");
      const repeated = await runPublicationLifecycle(env, { limit: 2, now: NOW });
      assert.equal(repeated.expired, 0);
      const unchanged = await client.execute({
        sql: `SELECT id, status FROM publications WHERE id IN (?, ?)`,
        args: [future.publicationId, lifetime.publicationId],
      });
      assert.deepEqual(unchanged.rows.map((row) => row.status), ["PUBLISHED", "PUBLISHED"]);
      const lifetimeEntitlement = await client.execute({
        sql: "SELECT status, expires_at FROM storage_entitlements WHERE publication_id = ?",
        args: [lifetime.publicationId],
      });
      assert.equal(lifetimeEntitlement.rows[0]?.status, "LIFETIME");
      assert.equal(lifetimeEntitlement.rows[0]?.expires_at, null);
    } finally {
      client.close();
    }
  });

  it("retains source assets until retention and retries derivative/source cleanup failures safely", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const failures = { derivative: 1, source: 1 };
    const storage = createStorage(failures);
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "EXPIRED",
        expiresAt: "2099-01-01T00:00:00.000Z",
        retentionUntil: "2099-01-31T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture) || !("derivativeKey" in fixture)) {
        assert.fail("Expected asset fixture");
      }
      await storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      await storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);
      const env = {
        DB: adapter,
        STORAGE: storage,
        DATA_RETENTION_DAYS: "30",
      } as Parameters<typeof runPublicationLifecycle>[0];

      const beforeRetention = await runPublicationLifecycle(env, {
        limit: 10,
        now: new Date("2099-01-30T23:59:59.999Z"),
      });
      assert.equal(beforeRetention.erased, 0);
      const preserved = await client.execute({
        sql: "SELECT status FROM assets WHERE id = ?",
        args: [fixture.assetId],
      });
      assert.equal(preserved.rows[0]?.status, "READY");
      assert.ok(await storage.get(fixture.sourceKey));

      const derivativeFailure = await runPublicationLifecycle(env, {
        limit: 10,
        now: new Date("2099-02-01T00:00:00.000Z"),
      });
      assert.equal(derivativeFailure.retryable, 1);
      const sourceFailure = await runPublicationLifecycle(env, {
        limit: 10,
        now: new Date("2099-02-01T00:00:00.000Z"),
      });
      assert.equal(sourceFailure.retryable, 1);
      const completed = await runPublicationLifecycle(env, {
        limit: 10,
        now: new Date("2099-02-01T00:00:00.000Z"),
      });
      assert.equal(completed.erased, 1);
      const erased = await client.execute({
        sql: `SELECT a.status AS asset_status, pa.derivative_status, pa.derivative_key,
                     p.snapshot_json, p.retention_delete_after_at
              FROM assets a
              JOIN publication_assets pa ON pa.asset_id = a.id
              JOIN publications p ON p.id = pa.publication_id
              WHERE a.id = ?`,
        args: [fixture.assetId],
      });
      assert.equal(erased.rows[0]?.asset_status, "DELETED");
      assert.equal(erased.rows[0]?.derivative_status, "DELETED");
      assert.equal(erased.rows[0]?.derivative_key, null);
      assert.equal(erased.rows[0]?.snapshot_json, "{}");
      assert.equal(erased.rows[0]?.retention_delete_after_at, null);
    } finally {
      client.close();
    }
  });

  it("defers retention cleanup while the design has a pending or paid order", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createStorage({ derivative: 0, source: 0 });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "EXPIRED",
        expiresAt: "2099-01-01T00:00:00.000Z",
        retentionUntil: "2099-01-31T00:00:00.000Z",
        withAsset: true,
        extraOrderStatus: "AWAITING_PAYMENT",
      });
      if (!("sourceKey" in fixture) || !("extraOrderId" in fixture) || !fixture.extraOrderId) {
        assert.fail("Expected order and asset fixtures");
      }
      await storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      await storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);
      const env = {
        DB: adapter,
        STORAGE: storage,
        DATA_RETENTION_DAYS: "30",
      } as Parameters<typeof runPublicationLifecycle>[0];
      const afterPayment = new Date("2099-02-01T00:00:00.000Z");

      const pending = await runPublicationLifecycle(env, { limit: 10, now: afterPayment });
      assert.equal(pending.erased, 0);
      assert.equal(pending.retryable, 0);
      assert.ok(await storage.get(fixture.sourceKey));
      const unchanged = await client.execute({
        sql: `SELECT d.status AS design_status, a.status AS asset_status
              FROM designs d JOIN assets a ON a.design_id = d.id WHERE d.id = ?`,
        args: [fixture.designId],
      });
      assert.deepEqual(unchanged.rows[0], { design_status: "DRAFT", asset_status: "READY" });

      await client.execute({
        sql: "UPDATE orders SET status = 'PAID', paid_at = ? WHERE id = ?",
        args: [afterPayment.toISOString(), fixture.extraOrderId],
      });
      const paid = await runPublicationLifecycle(env, { limit: 10, now: afterPayment });
      assert.equal(paid.erased, 0);
      assert.equal(paid.retryable, 0);

      await client.execute({
        sql: "UPDATE orders SET status = 'CANCELLED' WHERE id = ?",
        args: [fixture.extraOrderId],
      });
      const completed = await runPublicationLifecycle(env, { limit: 10, now: afterPayment });
      assert.equal(completed.erased, 1);
      const archived = await client.execute(
        "SELECT status FROM designs WHERE id = ?",
        [fixture.designId],
      );
      assert.equal(archived.rows[0]?.status, "ARCHIVED");
      assert.equal(await storage.get(fixture.sourceKey), null);
    } finally {
      client.close();
    }
  });
});

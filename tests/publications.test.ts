import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createClient, type Client } from "@libsql/client";
import qrcode from "qrcode-generator";
import type { Database, DatabaseStatement } from "../src/database.ts";
import { TursoDatabaseAdapter } from "../src/database/turso.ts";
import { applyMigrations, type SqlMigration } from "../src/database/migrations.ts";
import { handleApiRequest } from "../src/index.ts";
import { reconcileUploadAttemptCleanup } from "../src/assets.ts";
import { createVercelApiHandler } from "../src/platform/vercel.ts";
import {
  cleanupAssets,
  handleFulfillmentForOrder,
  recoverPendingFulfillments,
  reconcilePublicationDerivativeCleanup,
  runPublicationLifecycle,
} from "../src/publications.ts";
import { runScheduledPublicationLifecycle } from "../src/scheduler.ts";
import type { Storage, StorageObject } from "../src/storage.ts";

const NOW = new Date("2099-01-31T12:00:00.000Z");
const IMAGE = new Uint8Array([1, 2, 3]);
const UPLOAD_PNG = new Uint8Array(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/r9sAAAAASUVORK5CYII=",
  "base64",
));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

class PausableDatabase implements Database {
  private readonly inner: Database;
  private batchGate: {
    entered: ReturnType<typeof deferred>;
    released: ReturnType<typeof deferred>;
  } | null = null;
  private runGate: {
    query: string;
    entered: ReturnType<typeof deferred>;
    released: ReturnType<typeof deferred>;
  } | null = null;

  constructor(inner: Database) {
    this.inner = inner;
  }

  prepare(query: string): DatabaseStatement {
    if (!this.runGate || !query.includes(this.runGate.query)) {
      return this.inner.prepare(query);
    }
    return this.wrapStatement(query, this.inner.prepare(query));
  }

  private wrapStatement(query: string, statement: DatabaseStatement): DatabaseStatement {
    return {
      bind: (...values) => this.wrapStatement(query, statement.bind(...values)),
      first: (columnName) => statement.first(columnName),
      all: () => statement.all(),
      run: async () => {
        const gate = this.runGate;
        if (gate && query.includes(gate.query)) {
          this.runGate = null;
          gate.entered.resolve();
          await gate.released.promise;
        }
        return statement.run();
      },
    };
  }

  pauseNextBatch() {
    const entered = deferred();
    const released = deferred();
    this.batchGate = { entered, released };
    return { entered: entered.promise, release: released.resolve };
  }

  pauseNextRun(query: string) {
    const entered = deferred();
    const released = deferred();
    this.runGate = { query, entered, released };
    return { entered: entered.promise, release: released.resolve };
  }

  async batch(statements: DatabaseStatement[]) {
    const gate = this.batchGate;
    if (gate) {
      this.batchGate = null;
      gate.entered.resolve();
      await gate.released.promise;
    }
    return this.inner.batch(statements);
  }
}

function createRaceStorage(options: {
  beforeUpload?: () => Promise<void>;
  afterUpload?: () => Promise<void>;
  afterGet?: () => Promise<void>;
  beforeDelete?: (key: string) => Promise<void>;
  beforeDerivative?: (key: string) => Promise<void>;
  afterDerivative?: (key: string) => Promise<void>;
  beforeDerivativeGet?: (key: string) => Promise<void>;
  derivativeGetFailures?: number;
  beforeDerivativeDelete?: (key: string) => Promise<void>;
  afterDerivativeDelete?: (key: string) => Promise<void>;
  sourceDeleteFailures?: number;
  derivativeDeleteFailures?: number;
} = {}): { storage: Storage; objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  let sourceDeleteFailures = options.sourceDeleteFailures ?? 0;
  let derivativeGetFailures = options.derivativeGetFailures ?? 0;
  let derivativeDeleteFailures = options.derivativeDeleteFailures ?? 0;
  const asObject = async (key: string): Promise<StorageObject | null> => {
    const bytes = objects.get(key);
    if (!bytes) return null;
    const snapshot = new Uint8Array(bytes);
    await options.afterGet?.();
    return {
      size: snapshot.byteLength,
      contentType: "image/png",
      body: new Response(snapshot).body,
      arrayBuffer: async () => snapshot.slice().buffer,
    };
  };
  const storage: Storage = {
    async upload(key, bytes) {
      await options.beforeUpload?.();
      objects.set(key, new Uint8Array(bytes));
      await options.afterUpload?.();
    },
    get: asObject,
    async delete(key) {
      await options.beforeDelete?.(key);
      if (sourceDeleteFailures > 0) {
        sourceDeleteFailures--;
        throw new Error("Injected upload cleanup failure");
      }
      objects.delete(key);
    },
    async privateAssetUrl() { return null; },
    async createPublishedDerivative(source, derivative) {
      await options.beforeDerivative?.(derivative);
      const bytes = objects.get(source);
      if (!bytes) throw new Error("Source asset is missing");
      objects.set(derivative, new Uint8Array(bytes));
      await options.afterDerivative?.(derivative);
    },
    async getPublishedDerivative(key) {
      await options.beforeDerivativeGet?.(key);
      if (derivativeGetFailures > 0) {
        derivativeGetFailures--;
        throw new Error("Injected derivative lookup failure");
      }
      return asObject(key);
    },
    async deletePublishedDerivative(key) {
      await options.beforeDerivativeDelete?.(key);
      if (derivativeDeleteFailures > 0) {
        derivativeDeleteFailures--;
        throw new Error("Injected derivative cleanup failure");
      }
      objects.delete(key);
      await options.afterDerivativeDelete?.(key);
    },
  };
  return { storage, objects };
}

async function assetRequest(
  env: Parameters<typeof handleApiRequest>[1],
  session: { token: string; csrf: string },
  path: string,
  options: { method: string; body?: BodyInit | null; headers?: HeadersInit },
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("Cookie", `crushify_session=${session.token}; crushify_csrf=${session.csrf}`);
  headers.set("Origin", "https://crushify.test");
  headers.set("X-CSRF-Token", session.csrf);
  return handleApiRequest(
    new Request(`https://crushify.test/api/v1${path}`, {
      method: options.method,
      headers,
      body: options.body,
    }),
    env,
  );
}

async function createUploadGrant(
  env: Parameters<typeof handleApiRequest>[1],
  session: { token: string; csrf: string },
  designId: string,
) {
  const response = await assetRequest(env, session, "/assets/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ design_id: designId, media_type: "image/png", size: UPLOAD_PNG.length }),
  });
  const body = await response.json() as { asset_id: string; upload_url: string; upload_token: string };
  return { response, body };
}

async function saveDesignWithAsset(
  env: Parameters<typeof handleApiRequest>[1],
  session: { token: string; csrf: string },
  client: Client,
  designId: string,
  assetId: string,
): Promise<Response> {
  const row = await client.execute(
    "SELECT default_data_json FROM template_versions WHERE template_id = 'our-universe' AND schema_version = 1",
  );
  const data = JSON.parse(String(row.rows[0]?.default_data_json)) as Record<string, unknown>;
  data.photos = [{ asset_id: assetId, caption: "A memory" }];
  return assetRequest(env, session, `/designs/${designId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schema_version: 1, expected_revision: 1, data }),
  });
}

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

function createStorage(
  failures: { derivative: number; source: number },
  deletions?: { derivative: string[]; source: string[] },
): Storage {
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
      deletions?.source.push(key);
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
      deletions?.derivative.push(key);
      if (failures.derivative > 0) {
        failures.derivative--;
        throw new Error("Injected derivative cleanup failure");
      }
      objects.delete(key);
    },
  };
}

async function createSession(client: Client, customerId: string) {
  const token = randomUUID();
  const csrf = randomUUID();
  const now = new Date().toISOString();
  await client.execute({
    sql: `INSERT INTO customer_sessions (
            id, customer_id, token_hash, csrf_token_hash, expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      randomUUID(),
      customerId,
      createHash("sha256").update(token).digest("hex"),
      createHash("sha256").update(csrf).digest("hex"),
      "2100-01-01T00:00:00.000Z",
      now,
    ],
  });
  return { token, csrf };
}

async function createFixture(
  client: Client,
  options: {
    status?: "PUBLISHED" | "UNPUBLISHED" | "EXPIRED" | "REVOKED";
    expiresAt: string | null;
    retentionUntil?: string | null;
    lifetime?: boolean;
    withAsset?: boolean;
    extraOrderStatus?: "AWAITING_PAYMENT" | "PAID";
    customerId?: string;
  },
) {
  const id = () => randomUUID();
  const customerId = options.customerId ?? id();
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
  const evidenceSchema = await client.execute(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'payment_settlement_evidence'",
  );
  const settlementEvidenceStatements = evidenceSchema.rows.length === 1
    ? [{
      sql: `INSERT INTO payment_settlement_evidence (
              id, payment_id, provider, evidence_source, source_transaction_id,
              amount_minor, currency, verified_at, payload_hash, status, created_at
            )
            SELECT ?, p.id, p.provider, 'SEPAY_WEBHOOK', p.provider_payment_id,
              p.amount_minor, p.currency, e.processed_at, e.payload_hash, 'VERIFIED', e.processed_at
            FROM payments p JOIN payment_webhook_events e
              ON e.provider = p.provider AND e.event_id = p.provider_payment_id
            WHERE p.order_id = ?`,
      args: [id(), orderId],
    }]
    : [];
  if (!options.customerId) {
    await client.execute({
      sql: `INSERT INTO customers (id, email, email_normalized, status, created_at, updated_at)
            VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
      args: [customerId, `${customerId}@example.test`, `${customerId}@example.test`, now, now],
    });
  }
  await client.batch([
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
              id, provider, event_id, payload_hash, received_at, processed_at, outcome,
              raw_payload, provider_transaction_id, actual_amount_minor
            ) SELECT ?, 'SEPAY', provider_payment_id, ?, ?, ?, 'PROCESSED', '{}',
                     provider_payment_id, amount_minor
              FROM payments WHERE order_id = ?`,
      args: [id(), "b".repeat(64), now, now, orderId],
    },
    ...settlementEvidenceStatements,
    {
      sql: `INSERT INTO publications (
              id, design_id, order_id, published_revision, template_id, schema_version, renderer_version,
              slug, slug_hash, snapshot_json, status, lifecycle_revision, activated_at, original_expires_at,
              expires_at, expired_at, retention_delete_after_at, published_at, created_at, updated_at
            ) VALUES (?, ?, ?, 1, 'our-universe', 1, '1.0.0', ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        publicationId, designId, orderId, slug,
        createHash("sha256").update(slug).digest("hex"), JSON.stringify({ data: JSON.parse(data) }),
        options.status ?? "PUBLISHED", now, now, options.expiresAt, options.status === "REVOKED" ? now : null,
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
        lifetime ? "LIFETIME" : options.status === "EXPIRED" ? "EXPIRED" :
          options.status === "REVOKED" ? "REVOKED" : "ACTIVE", now,
      ],
    },
  ]);
  await client.execute({
    sql: `INSERT INTO order_design_snapshots (
            order_id, design_id, design_revision, template_id, schema_version,
            data_json, content_sha256, created_at
          ) VALUES (?, ?, 1, 'our-universe', 1, ?, ?, ?)`,
    args: [
      orderId, designId, data,
      createHash("sha256").update(data).digest("hex"), now,
    ],
  });
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
    const derivativeOperations = await client.execute(
      `SELECT 1 FROM sqlite_master
       WHERE type = 'table' AND name = 'publication_derivative_operations'`,
    );
    if (derivativeOperations.rows.length === 1) {
      await client.execute({
        sql: `INSERT INTO publication_derivative_operations (
                id, publication_asset_id, publication_id, derivative_key, status, operation_token,
                operation_lease_expires_at, next_cleanup_at, provider_create_succeeded_at,
                created_at, updated_at
              ) VALUES (?, ?, ?, ?, 'READY', ?, ?, ?, ?, ?, ?)`,
        args: [
          `fixture-derivative-${publicationAssetId}`, publicationAssetId, publicationId, derivativeKey,
          `fixture-derivative-token-${publicationAssetId}`,
          new Date(Date.parse(now) + 15 * 60_000).toISOString(),
          new Date(Date.parse(now) + 60 * 60_000).toISOString(), now, now, now,
        ],
      });
    }
    return {
      customerId, designId, orderId, publicationId, publicationAssetId, assetId, slug,
      sourceKey, derivativeKey, extraOrderId,
    };
  }
  return { customerId, designId, orderId, publicationId, slug, extraOrderId };
}

async function createDraftFixture(client: Client, withAsset: true): Promise<{
  customerId: string;
  designId: string;
  assetId: string;
  sourceKey: string;
}>;
async function createDraftFixture(client: Client, withAsset?: false): Promise<{
  customerId: string;
  designId: string;
  assetId: string;
}>;
async function createDraftFixture(client: Client, withAsset = false): Promise<{
  customerId: string;
  designId: string;
  assetId: string;
  sourceKey?: string;
}> {
  const id = () => randomUUID();
  const customerId = id();
  const designId = id();
  const assetId = id();
  const now = NOW.toISOString();
  const template = await client.execute(
    "SELECT default_data_json FROM template_versions WHERE template_id = 'our-universe' AND schema_version = 1",
  );
  const data = String(template.rows[0]?.default_data_json);
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
  ]);
  if (withAsset) {
    await client.execute({
      sql: `INSERT INTO assets (
              id, customer_id, design_id, object_key, visibility, status, media_type, byte_size,
              sha256, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'PRIVATE', 'READY', 'image/png', ?, ?, ?, ?)`,
      args: [assetId, customerId, designId, `private/${assetId}.png`, IMAGE.length, "e".repeat(64), now, now],
    });
    return { customerId, designId, assetId, sourceKey: `private/${assetId}.png` };
  }
  return { customerId, designId, assetId };
}

async function createOrderSnapshot(
  client: Client,
  fixture: { customerId: string; designId: string },
  options: { paid: boolean; assetId?: string },
) {
  const id = () => randomUUID();
  const orderId = id();
  const paymentId = id();
  const transactionId = id();
  const orderReference = `CRF${id().replaceAll("-", "").slice(0, 16).toUpperCase()}`;
  const paymentReference = `CRP${id().replaceAll("-", "").slice(0, 16).toUpperCase()}`;
  const now = NOW.toISOString();
  const expiresAt = "2100-01-01T00:00:00.000Z";
  const designResult = await client.execute({
    sql: "SELECT revision, template_id, schema_version, data_json FROM designs WHERE id = ?",
    args: [fixture.designId],
  });
  const design = designResult.rows[0];
  if (!design) assert.fail("Expected order design fixture");
  const dataJson = String(design.data_json);
  const revision = Number(design.revision);
  await client.batch([
    {
      sql: `INSERT INTO orders (
              id, customer_id, order_type, status, currency, subtotal_minor, discount_minor, total_minor,
              design_id, idempotency_key, created_at, updated_at, paid_at, expires_at, order_reference,
              design_revision, request_hash, payment_review_required
            ) VALUES (?, ?, 'SELF_SERVICE', ?, 'VND', 1000, 0, 1000, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      args: [
        orderId, fixture.customerId, options.paid ? "PAID" : "AWAITING_PAYMENT",
        fixture.designId, id(), now, now, options.paid ? now : null,
        options.paid ? null : expiresAt, orderReference, revision,
        createHash("sha256").update(dataJson).digest("hex"),
      ],
    },
    {
      sql: `INSERT INTO order_items (
              id, order_id, item_type, reference_id, description_snapshot, quantity, unit_amount_minor,
              line_total_minor, metadata_json, created_at
            ) VALUES (?, ?, 'TEMPLATE_LICENSE', ?, 'Template license', 1, 1000, 1000, ?, ?)`,
      args: [id(), orderId, String(design.template_id), JSON.stringify({
        schema_version: Number(design.schema_version),
      }), now],
    },
    {
      sql: `INSERT INTO order_items (
              id, order_id, item_type, reference_id, description_snapshot, quantity, unit_amount_minor,
              line_total_minor, metadata_json, created_at
            ) VALUES (?, ?, 'ADD_ON', '1-month', 'Storage', 1, 0, 0, ?, ?)`,
      args: [id(), orderId, JSON.stringify({
        kind: "STORAGE_PLAN",
        storage_plan_id: "1-month",
        title: "1 month",
        duration_months: 1,
        lifetime: false,
        asset_consents: options.assetId
          ? [{ asset_id: options.assetId, consent_version: "public-image-v1" }]
          : [],
      }), now],
    },
    {
      sql: `INSERT INTO payments (
              id, order_id, provider, provider_payment_id, status, amount_minor, currency,
              idempotency_key, created_at, updated_at, succeeded_at, payment_reference, review_required
            ) VALUES (?, ?, 'SEPAY', ?, ?, 1000, 'VND', ?, ?, ?, ?, ?, 0)`,
      args: [
        paymentId, orderId, options.paid ? transactionId : null,
        options.paid ? "SUCCEEDED" : "PENDING", id(), now, now,
        options.paid ? now : null, paymentReference,
      ],
    },
  ]);
  await client.execute({
    sql: `INSERT INTO order_design_snapshots (
            order_id, design_id, design_revision, template_id, schema_version,
            data_json, content_sha256, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      orderId, fixture.designId, revision, String(design.template_id),
      Number(design.schema_version), dataJson,
      createHash("sha256").update(dataJson).digest("hex"), now,
    ],
  });
  if (options.assetId) {
    await client.execute({
      sql: `INSERT INTO order_asset_refs (order_id, asset_id, created_at)
            VALUES (?, ?, ?)`,
      args: [orderId, options.assetId, now],
    });
  }
  if (options.paid) {
    await client.batch([
      {
        sql: `INSERT INTO payment_webhook_events (
                id, provider, event_id, payload_hash, received_at, processed_at,
                outcome, raw_payload, provider_transaction_id, actual_amount_minor
              ) VALUES (?, 'SEPAY', ?, ?, ?, ?, 'PROCESSED', '{}', ?, 1000)`,
        args: [id(), transactionId, "f".repeat(64), now, now, transactionId],
      },
      {
        sql: `INSERT INTO payment_settlement_evidence (
                id, payment_id, provider, evidence_source, source_transaction_id,
                amount_minor, currency, verified_at, payload_hash, status, created_at
              )
              SELECT ?, id, provider, 'SEPAY_WEBHOOK', provider_payment_id,
                amount_minor, currency, ?, ?, 'VERIFIED', ?
              FROM payments WHERE id = ?`,
        args: [id(), now, "f".repeat(64), now, paymentId],
      },
      {
        sql: `INSERT INTO fulfillment_jobs (id, order_id, status, next_attempt_at, created_at, updated_at)
              VALUES (?, ?, 'PENDING', ?, ?, ?)`,
        args: [id(), orderId, now, now, now],
      },
    ]);
  }
  return { orderId, orderReference, paymentReference, transactionId, dataJson };
}

async function insertUploadAttemptFixture(
  client: Client,
  assetId: string,
  options: {
    status?: "UPLOADING" | "ATTACHED" | "CLEANUP_PENDING" | "CLEANED";
    leaseExpiresAt?: string;
    nextCleanupAt?: string;
  } = {},
) {
  const asset = await client.execute(
    `SELECT asset.object_key, session.id AS session_id
     FROM assets asset JOIN asset_upload_sessions session ON session.asset_id = asset.id
     WHERE asset.id = ?`,
    [assetId],
  );
  const row = asset.rows[0];
  if (!row) assert.fail("Expected upload attempt fixture");
  const id = randomUUID();
  const leaseToken = randomUUID();
  const now = new Date().toISOString();
  const leaseExpiresAt = options.leaseExpiresAt ?? new Date(Date.now() + 15 * 60_000).toISOString();
  const status = options.status ?? "CLEANUP_PENDING";
  if (status === "UPLOADING") {
    await client.execute({
      sql: `UPDATE asset_upload_sessions
            SET status = 'UPLOADING', used_at = ?, lease_token = ?, lease_expires_at = ?
            WHERE id = ?`,
      args: [now, leaseToken, leaseExpiresAt, String(row.session_id)],
    });
  }
  await client.execute({
    sql: `INSERT INTO asset_upload_attempts (
            id, session_id, asset_id, lease_token, object_key, status, lease_expires_at,
            next_cleanup_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, String(row.session_id), assetId, leaseToken, String(row.object_key), status,
      leaseExpiresAt, options.nextCleanupAt ?? now, now, now,
    ],
  });
  return { id, leaseToken, objectKey: String(row.object_key) };
}

async function insertDueCleanupAttempt(client: Client, assetId: string) {
  const asset = await client.execute(
    "SELECT customer_id FROM assets WHERE id = ?",
    [assetId],
  );
  const customerId = String(asset.rows[0]?.customer_id ?? "");
  if (!customerId) assert.fail("Expected cleanup asset fixture");
  const now = new Date();
  const timestamp = now.toISOString();
  await client.execute({
    sql: `INSERT INTO asset_upload_sessions (
            id, asset_id, customer_id, token_hash, expires_at, used_at, created_at, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'COMPLETE')`,
    args: [
      randomUUID(), assetId, customerId, createHash("sha256").update(randomUUID()).digest("hex"),
      timestamp, timestamp, timestamp,
    ],
  });
  return insertUploadAttemptFixture(client, assetId, {
    status: "CLEANUP_PENDING",
    leaseExpiresAt: new Date(now.getTime() - 60_000).toISOString(),
    nextCleanupAt: new Date(now.getTime() - 60_000).toISOString(),
  });
}

function deletionContext(
  adapter: Database,
  storage: Storage,
  session?: { token: string; csrf: string },
) {
  const env = {
    DB: adapter,
    STORAGE: storage,
    APP_ORIGIN: "https://crushify.test",
    ENVIRONMENT: "local",
    LOCAL_TEST_MODE: "true",
  } as Parameters<typeof handleApiRequest>[1];
  const headers: Record<string, string> = {
    Origin: "https://crushify.test",
  };
  if (session) {
    headers.Cookie = `crushify_session=${session.token}; crushify_csrf=${session.csrf}`;
    headers["X-CSRF-Token"] = session.csrf;
  }
  return {
    env,
    deleteDesign(designId: string, extraHeaders: Record<string, string> = {}) {
      return handleApiRequest(
        new Request(`https://crushify.test/api/v1/designs/${designId}`, {
          method: "DELETE",
          headers: { ...headers, ...extraHeaders },
        }),
        env,
      );
    },
  };
}

describe("published website QR codes", () => {
  it("encodes only the canonical URL and denies unavailable or non-owned publications", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const env = {
      DB: adapter,
      ENVIRONMENT: "local",
      LOCAL_TEST_MODE: "true",
      APP_ORIGIN: "https://crushify.test",
    } as Parameters<typeof handleApiRequest>[1];
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const published = await createFixture(client, { expiresAt: null });
      const ownerSession = await createSession(client, published.customerId);
      const qrResponse = await assetRequest(
        env, ownerSession, `/publications/${published.publicationId}/qr.svg`, { method: "GET" },
      );
      assert.equal(qrResponse.status, 200);
      assert.match(qrResponse.headers.get("content-type") ?? "", /^image\/svg\+xml/);
      assert.equal(qrResponse.headers.get("cache-control"), "private, no-store");
      const expectedCode = qrcode(0, "H");
      expectedCode.addData(`https://crushify.test/p/${published.slug}`);
      expectedCode.make();
      assert.equal(
        await qrResponse.text(),
        expectedCode.createSvgTag({ cellSize: 8, margin: 4, scalable: true }),
      );

      const unpublished = await createFixture(client, {
        status: "UNPUBLISHED",
        expiresAt: null,
      });
      const unpublishedSession = await createSession(client, unpublished.customerId);
      const unpublishedQr = await assetRequest(
        env, unpublishedSession, `/publications/${unpublished.publicationId}/qr.svg`, { method: "GET" },
      );
      assert.equal(unpublishedQr.status, 404);

      const stranger = await createFixture(client, { expiresAt: null });
      const strangerSession = await createSession(client, stranger.customerId);
      const crossCustomerQr = await assetRequest(
        env, strangerSession, `/publications/${published.publicationId}/qr.svg`, { method: "GET" },
      );
      assert.equal(crossCustomerQr.status, 404);

      await client.execute(
        `UPDATE payment_settlement_evidence SET status = 'REVOKED'
         WHERE payment_id = (SELECT id FROM payments WHERE order_id = ?)`,
        [published.orderId],
      );
      const invalidEvidenceQr = await assetRequest(
        env, ownerSession, `/publications/${published.publicationId}/qr.svg`, { method: "GET" },
      );
      assert.equal(invalidEvidenceQr.status, 404);

      const unauthenticatedQr = await handleApiRequest(
        new Request(`https://crushify.test/api/v1/publications/${published.publicationId}/qr.svg`),
        env,
      );
      assert.equal(unauthenticatedQr.status, 401);
    } finally {
      client.close();
    }
  });
});

describe("publication expiration lifecycle", () => {
  it("blocks fulfillment recovery and public reads when settlement evidence is missing or invalid", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createStorage({ derivative: 0, source: 0 });
    const env = {
      DB: adapter,
      STORAGE: storage,
      ENVIRONMENT: "local",
      LOCAL_TEST_MODE: "true",
      PAYMENT_MODE: "mock",
      APP_ORIGIN: "https://crushify.test",
    } as Parameters<typeof handleFulfillmentForOrder>[0];
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const published = await createFixture(client, { expiresAt: null });

      for (const invalidation of [
        "missing",
        "revoked",
        "mismatched",
        "wrong-payment",
        "contradictory",
      ] as const) {
        const fixture = await createDraftFixture(client);
        const order = await createOrderSnapshot(client, fixture, { paid: true });
        if (invalidation === "missing") {
          await client.execute(
            `DELETE FROM payment_settlement_evidence
             WHERE payment_id = (SELECT id FROM payments WHERE order_id = ?)`,
            [order.orderId],
          );
        } else if (invalidation === "revoked") {
          await client.execute(
            `UPDATE payment_settlement_evidence SET status = 'REVOKED'
             WHERE payment_id = (SELECT id FROM payments WHERE order_id = ?)`,
            [order.orderId],
          );
        } else if (invalidation === "mismatched") {
          await client.execute(
            `UPDATE payment_settlement_evidence SET amount_minor = amount_minor + 1
             WHERE payment_id = (SELECT id FROM payments WHERE order_id = ?)`,
            [order.orderId],
          );
        } else if (invalidation === "contradictory") {
          await client.execute(
            `UPDATE payment_webhook_events SET review_reason = 'Conflicting event'
             WHERE provider = 'SEPAY'
               AND provider_transaction_id = ?`,
            [order.transactionId],
          );
        } else {
          await client.execute(
            `UPDATE payment_settlement_evidence
             SET payment_id = (SELECT id FROM payments WHERE order_id = ?)
             WHERE payment_id = (SELECT id FROM payments WHERE order_id = ?)`,
            [published.orderId, order.orderId],
          );
        }

        const direct = await handleFulfillmentForOrder(env, order.orderId, NOW);
        assert.equal(direct.completed, false, `${invalidation}: direct fulfillment is blocked`);
        const recovery = await recoverPendingFulfillments(env, 10, NOW);
        assert.equal(recovery.attempted, 0, `${invalidation}: scheduler recovery is blocked`);
        const session = await createSession(client, fixture.customerId);
        const statusResponse = await assetRequest(
          env,
          session,
          `/orders/${order.orderId}/status`,
          { method: "GET" },
        );
        const status = await statusResponse.json() as {
          status: string;
          payment: { status: string };
        };
        assert.equal(status.status, "MANUAL_REVIEW", `${invalidation}: unverified payment is reported blocked`);
        assert.equal(status.payment.status, "MANUAL_REVIEW");
        const state = await client.execute(
          `SELECT o.status AS order_status, job.status AS job_status
           FROM orders o JOIN fulfillment_jobs job ON job.order_id = o.id WHERE o.id = ?`,
          [order.orderId],
        );
        assert.deepEqual(state.rows[0], { order_status: "PAID", job_status: "PENDING" });
      }

      await client.execute(
        `UPDATE payment_settlement_evidence SET status = 'REVOKED'
         WHERE payment_id = (SELECT id FROM payments WHERE order_id = ?)`,
        [published.orderId],
      );
      const publicRead = await handleApiRequest(
        new Request(`https://crushify.test/api/v1/publications/${published.slug}`),
        env,
      );
      assert.equal(publicRead.status, 404, "revoked evidence denies an existing public page");

      const pairedFixture = await createDraftFixture(client);
      const pairedOrder = await createOrderSnapshot(client, pairedFixture, { paid: true });
      await client.execute(
        `INSERT INTO sepay_api_observations (
           transaction_uuid, bank_account_id, transaction_date, transfer_type,
           amount_in, amount_out, payload_hash, scan_type, status, reason_code,
           payment_id, first_observed_at, last_observed_at
         )
         SELECT ?, 'f9e8d7c6-b5a4-3210-fedc-ba0987654321', ?, 'in',
                amount_minor, 0, ?, 'DATE_WINDOW', 'MANUAL_REVIEW',
                'TEST_ONLY', id, ?, ?
         FROM payments WHERE order_id = ?`,
        [randomUUID(), NOW, "a".repeat(64), NOW, NOW, pairedOrder.orderId],
      );
      const pairedEvidenceFulfillment = await handleFulfillmentForOrder(env, pairedOrder.orderId, NOW);
      assert.equal(pairedEvidenceFulfillment.completed, true,
        "a valid webhook remains authoritative when an API observation is also recorded");

      const apiFixture = await createDraftFixture(client);
      const apiOrder = await createOrderSnapshot(client, apiFixture, { paid: true });
      await client.execute(
        `INSERT INTO sepay_api_observations (
           transaction_uuid, bank_account_id, transaction_date, transfer_type,
           amount_in, amount_out, payload_hash, scan_type, status, reason_code,
           payment_id, first_observed_at, last_observed_at
         )
         SELECT ?, 'f9e8d7c6-b5a4-3210-fedc-ba0987654321', ?, 'in',
                amount_minor, 0, ?, 'DATE_WINDOW', 'MANUAL_REVIEW',
                'TEST_ONLY', id, ?, ?
         FROM payments WHERE order_id = ?`,
        [randomUUID(), NOW, "a".repeat(64), NOW, NOW, apiOrder.orderId],
      );
      await client.execute(
        `DELETE FROM payment_settlement_evidence
         WHERE payment_id = (SELECT id FROM payments WHERE order_id = ?)`,
        [apiOrder.orderId],
      );
      await client.execute(
        "UPDATE payments SET provider_payment_id = NULL WHERE order_id = ?",
        [apiOrder.orderId],
      );
      await client.execute(
        `DELETE FROM payment_webhook_events
         WHERE provider = 'SEPAY' AND provider_transaction_id = ?`,
        [apiOrder.transactionId],
      );
      const apiOnlyFulfillment = await handleFulfillmentForOrder(env, apiOrder.orderId, NOW);
      assert.equal(apiOnlyFulfillment.completed, false,
        "an API v2 observation cannot authorize fulfillment without webhook evidence");
      const apiOnlyRecovery = await recoverPendingFulfillments(env, 10, NOW);
      assert.equal(apiOnlyRecovery.attempted, 0,
        "recovery cannot authorize API-only evidence");
      const apiOnlyArtifacts = await client.execute(
        `SELECT o.status AS order_status, job.status AS job_status,
                (SELECT COUNT(*) FROM publications WHERE order_id = o.id) AS publications
         FROM orders o JOIN fulfillment_jobs job ON job.order_id = o.id
         WHERE o.id = ?`,
        [apiOrder.orderId],
      );
      assert.deepEqual(apiOnlyArtifacts.rows[0], {
        order_status: "PAID",
        job_status: "PENDING",
        publications: 0,
      });
    } finally {
      client.close();
    }
  });

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
      const retainedLifetime = await createFixture(client, {
        expiresAt: null,
        lifetime: true,
        status: "EXPIRED",
        retentionUntil: new Date(NOW.getTime() - 1).toISOString(),
      });
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
      const retained = await client.execute({
        sql: `SELECT p.status, p.snapshot_json, p.retention_delete_after_at, e.status AS entitlement_status
              FROM publications p
              JOIN storage_entitlements e ON e.publication_id = p.id
              WHERE p.id = ?`,
        args: [retainedLifetime.publicationId],
      });
      assert.equal(retained.rows[0]?.status, "EXPIRED");
      assert.equal(retained.rows[0]?.entitlement_status, "LIFETIME");
      assert.notEqual(retained.rows[0]?.snapshot_json, "{}",
        "retention cleanup must not erase a lifetime entitlement");
      assert.equal(retained.rows[0]?.retention_delete_after_at,
        new Date(NOW.getTime() - 1).toISOString());
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

  it("runs the authenticated Production Vercel Cron route against synthetic expiry and cleanup records", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const failures = { derivative: 1, source: 1 };
    const storage = createStorage(failures);
    const now = new Date();
    const expiredAt = new Date(now.getTime() - 60_000).toISOString();
    const retentionUntil = new Date(now.getTime() - 1_000).toISOString();
    const env = {
      DB: adapter,
      STORAGE: storage,
      DATA_RETENTION_DAYS: "30",
    } as Parameters<typeof runPublicationLifecycle>[0];
    let connections = 0;
    const secret = "local-synthetic-cron-secret-with-sufficient-length";
    const handler = createVercelApiHandler({
      DATABASE_PROVIDER: "turso",
      TURSO_DATABASE_URL: "libsql://crushify-production-test-org.turso.io",
      TURSO_AUTH_TOKEN: "synthetic-token",
      STORAGE_PROVIDER: "cloudinary",
      CLOUDINARY_CLOUD_NAME: "crushify-production-test",
      CLOUDINARY_API_KEY: "synthetic-api-key",
      CLOUDINARY_API_SECRET: "synthetic-api-secret",
      ENVIRONMENT: "production",
      VERCEL_ENV: "production",
      APP_ORIGIN: "https://crushify.test",
      CRON_SECRET: secret,
      DATA_RETENTION_DAYS: "30",
    }, {
      async connectDatabase() {
        connections++;
        return { database: adapter, close: () => undefined };
      },
      createCloudinaryStorage: () => storage,
    });

    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const expiring = await createFixture(client, { expiresAt: expiredAt });
      const active = await createFixture(client, {
        expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
      });
      const retrying = await createFixture(client, {
        status: "EXPIRED",
        expiresAt: expiredAt,
        retentionUntil,
        withAsset: true,
      });
      const fulfillmentDesign = await createDraftFixture(client);
      const fulfillmentOrder = await createOrderSnapshot(client, fulfillmentDesign, { paid: true });
      await client.execute(
        "UPDATE fulfillment_jobs SET next_attempt_at = ? WHERE order_id = ?",
        [now.toISOString(), fulfillmentOrder.orderId],
      );
      const cleanupDesign = await createDraftFixture(client, true);
      const cleanupAttempt = await insertDueCleanupAttempt(client, cleanupDesign.assetId);
      if (!("sourceKey" in retrying) || !("derivativeKey" in retrying)) {
        assert.fail("Expected cleanup asset fixture");
      }
      await storage.upload(retrying.sourceKey, IMAGE, { contentType: "image/png" });
      await storage.createPublishedDerivative(retrying.sourceKey, retrying.derivativeKey);

      const unauthorized = await handler(
        new Request("https://crushify.test/api/cron/publication-lifecycle"),
      );
      assert.equal(unauthorized.status, 401);
      const invalid = await handler(new Request(
        "https://crushify.test/api/cron/publication-lifecycle",
        { headers: { Authorization: "Bearer invalid-local-test-value" } },
      ));
      assert.equal(invalid.status, 401);
      assert.equal(connections, 0);
      assert.equal((await client.execute(
        "SELECT status FROM fulfillment_jobs WHERE order_id = ?",
        [fulfillmentOrder.orderId],
      )).rows[0]?.status, "PENDING", "unauthenticated Cron requests cannot claim fulfillment");

      const firstResponse = await handler(new Request(
        "https://crushify.test/api/cron/publication-lifecycle",
        { headers: { Authorization: `Bearer ${secret}` } },
      ));
      assert.equal(firstResponse.status, 202,
        "maintenance reports partial work rather than a success-shaped response");
      const firstResult = await firstResponse.json() as {
        acquired: boolean;
        failed: boolean;
        pending: boolean;
        expired: number;
        erased: number;
        retryable: number;
        operations: {
          fulfillmentRecovery: { status: string; result?: { attempted: number; completed: number } };
          publicationLifecycle: { status: string };
          uploadCleanup: { status: string; result?: { preserved: number } };
          publicationDerivativeCleanup: {
            status: string;
            result?: {
              status: string;
              processed: number;
              cleaned: number;
              pending: number;
              deferred: number;
              retryable: number;
              manualReview: number;
              hasMore: boolean;
            };
          };
        };
      };
      assert.equal(firstResult.acquired, true);
      assert.equal(firstResult.failed, false);
      assert.equal(firstResult.pending, true);
      assert.deepEqual(
        { expired: firstResult.expired, erased: firstResult.erased, retryable: firstResult.retryable },
        { expired: 1, erased: 0, retryable: 1 },
      );
      assert.equal(firstResult.operations.fulfillmentRecovery.status, "completed");
      assert.deepEqual(
        {
          attempted: firstResult.operations.fulfillmentRecovery.result?.attempted,
          completed: firstResult.operations.fulfillmentRecovery.result?.completed,
        },
        { attempted: 1, completed: 1 },
      );
      assert.equal(firstResult.operations.publicationLifecycle.status, "completed");
      assert.equal(firstResult.operations.uploadCleanup.status, "completed");
      assert.equal(firstResult.operations.uploadCleanup.result?.preserved, 1);
      assert.equal(firstResult.operations.publicationDerivativeCleanup.status, "completed");
      assert.deepEqual(firstResult.operations.publicationDerivativeCleanup.result, {
        status: "deferred",
        processed: 0,
        cleaned: 0,
        pending: 0,
        deferred: 1,
        retryable: 0,
        manualReview: 0,
        hasMore: false,
      });
      assert.equal(connections, 1);
      assert.equal((await client.execute(
        "SELECT status FROM fulfillment_jobs WHERE order_id = ?",
        [fulfillmentOrder.orderId],
      )).rows[0]?.status, "COMPLETED");
      assert.equal((await client.execute(
        "SELECT status FROM orders WHERE id = ?",
        [fulfillmentOrder.orderId],
      )).rows[0]?.status, "FULFILLED");
      assert.equal((await client.execute(
        "SELECT status FROM asset_upload_attempts WHERE id = ?",
        [cleanupAttempt.id],
      )).rows[0]?.status, "ATTACHED");
      const firstStates = await client.execute({
        sql: `SELECT id, status FROM publications WHERE id IN (?, ?, ?)`,
        args: [expiring.publicationId, active.publicationId, retrying.publicationId],
      });
      const firstById = new Map(firstStates.rows.map((row) => [String(row.id), String(row.status)]));
      assert.equal(firstById.get(expiring.publicationId), "EXPIRED");
      assert.equal(firstById.get(active.publicationId), "PUBLISHED");
      assert.equal(firstById.get(retrying.publicationId), "EXPIRED");
      assert.equal((await handleApiRequest(
        new Request(`https://crushify.test/api/v1/publications/${expiring.slug}`),
        env,
      )).status, 410);
      const activeResponse = await handleApiRequest(
        new Request(`https://crushify.test/api/v1/publications/${active.slug}`),
        env,
      );
      assert.equal(activeResponse.status, 200, await activeResponse.clone().text());

      await client.execute(
        `UPDATE publication_derivative_operations
         SET next_cleanup_at = '2000-01-01T00:00:00.000Z'
         WHERE publication_id = ? AND status = 'CLEANUP_PENDING'`,
        [retrying.publicationId],
      );
      const sourceRetry = await handler(new Request(
        "https://crushify.test/api/cron/publication-lifecycle",
        { headers: { Authorization: `Bearer ${secret}` } },
      ));
      assert.equal(sourceRetry.status, 202);
      const sourceRetryResult = await sourceRetry.json() as typeof firstResult;
      assert.equal(sourceRetryResult.acquired, true);
      assert.equal(sourceRetryResult.failed, false);
      assert.equal(sourceRetryResult.pending, true);
      assert.deepEqual(
        {
          expired: sourceRetryResult.expired,
          erased: sourceRetryResult.erased,
          retryable: sourceRetryResult.retryable,
        },
        { expired: 0, erased: 0, retryable: 1 },
      );
      assert.deepEqual(sourceRetryResult.operations.fulfillmentRecovery.result, {
        attempted: 0, completed: 0, retryable: 0, manualReview: 0,
      });

      const completed = await handler(new Request(
        "https://crushify.test/api/cron/publication-lifecycle",
        { headers: { Authorization: `Bearer ${secret}` } },
      ));
      assert.equal(completed.status, 200,
        "known provider success and verified cleanup leave no future tombstone work");
      const completedResult = await completed.json() as typeof firstResult;
      assert.equal(completedResult.acquired, true);
      assert.equal(completedResult.failed, false);
      assert.equal(completedResult.pending, false);
      assert.deepEqual(
        {
          expired: completedResult.expired,
          erased: completedResult.erased,
          retryable: completedResult.retryable,
        },
        { expired: 0, erased: 1, retryable: 0 },
      );
      const erasedAsset = await client.execute({
        sql: "SELECT status FROM assets WHERE design_id = ?",
        args: [retrying.designId],
      });
      assert.equal(erasedAsset.rows[0]?.status, "DELETED");
      const repeated = await handler(new Request(
        "https://crushify.test/api/cron/publication-lifecycle",
        { headers: { Authorization: `Bearer ${secret}` } },
      ));
      assert.equal(repeated.status, 200);
      const repeatedResult = await repeated.json() as typeof firstResult;
      assert.equal(repeatedResult.acquired, true);
      assert.equal(repeatedResult.failed, false);
      assert.deepEqual(
        {
          expired: repeatedResult.expired,
          erased: repeatedResult.erased,
          retryable: repeatedResult.retryable,
        },
        { expired: 0, erased: 0, retryable: 0 },
      );
      assert.deepEqual(repeatedResult.operations.fulfillmentRecovery.result, {
        attempted: 0, completed: 0, retryable: 0, manualReview: 0,
      });
    } finally {
      client.close();
    }
  });

  it("continues publication and upload cleanup when Cron fulfillment recovery fails", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createStorage({ derivative: 0, source: 0 });
    const secret = "local-synthetic-cron-secret-with-sufficient-length";
    const handler = createVercelApiHandler({
      DATABASE_PROVIDER: "turso",
      TURSO_DATABASE_URL: "libsql://crushify-production-test-org.turso.io",
      TURSO_AUTH_TOKEN: "synthetic-token",
      STORAGE_PROVIDER: "cloudinary",
      CLOUDINARY_CLOUD_NAME: "crushify-production-test",
      CLOUDINARY_API_KEY: "synthetic-api-key",
      CLOUDINARY_API_SECRET: "synthetic-api-secret",
      ENVIRONMENT: "production",
      VERCEL_ENV: "production",
      VERCEL_PROJECT_PRODUCTION_URL: "crushify.test",
      CRON_SECRET: secret,
      DATA_RETENTION_DAYS: "30",
    }, {
      async connectDatabase() {
        return { database: adapter, close: () => undefined };
      },
      createCloudinaryStorage: () => storage,
    });

    try {
      await applyMigrations(client, await loadMigrations());
      const now = new Date();
      const expired = await createFixture(client, {
        expiresAt: new Date(now.getTime() - 60_000).toISOString(),
      });
      const paidDraft = await createDraftFixture(client);
      const paidOrder = await createOrderSnapshot(client, paidDraft, { paid: true });
      await client.execute(
        "UPDATE fulfillment_jobs SET next_attempt_at = ? WHERE order_id = ?",
        [now.toISOString(), paidOrder.orderId],
      );
      const cleanupDraft = await createDraftFixture(client, true);
      const cleanupAttempt = await insertDueCleanupAttempt(client, cleanupDraft.assetId);
      await client.execute(`CREATE TRIGGER reject_fulfillment_claim
        BEFORE UPDATE OF status ON fulfillment_jobs
        WHEN NEW.status = 'PROCESSING'
        BEGIN SELECT RAISE(ABORT, 'injected recovery claim failure'); END`);

      const failedRun = await handler(new Request(
        "https://crushify.test/api/cron/publication-lifecycle",
        { headers: { Authorization: `Bearer ${secret}` } },
      ));
      assert.equal(failedRun.status, 503);
      const failureResult = await failedRun.json() as {
        failed: boolean;
        operations: {
          fulfillmentRecovery: { status: string; error_code?: string };
          publicationLifecycle: { status: string; result?: { expired: number } };
          uploadCleanup: { status: string; result?: { preserved: number } };
        };
      };
      assert.equal(failureResult.failed, true);
      assert.deepEqual(failureResult.operations.fulfillmentRecovery, {
        status: "failed",
        error_code: "DATABASE_ERROR",
      });
      assert.equal(failureResult.operations.publicationLifecycle.status, "completed");
      assert.equal(failureResult.operations.publicationLifecycle.result?.expired, 1);
      assert.equal(failureResult.operations.uploadCleanup.status, "completed");
      assert.equal(failureResult.operations.uploadCleanup.result?.preserved, 1);
      assert.equal((await client.execute(
        "SELECT status FROM publications WHERE id = ?",
        [expired.publicationId],
      )).rows[0]?.status, "EXPIRED");
      assert.equal((await client.execute(
        "SELECT status FROM fulfillment_jobs WHERE order_id = ?",
        [paidOrder.orderId],
      )).rows[0]?.status, "PENDING");
      assert.equal((await client.execute(
        "SELECT status FROM asset_upload_attempts WHERE id = ?",
        [cleanupAttempt.id],
      )).rows[0]?.status, "ATTACHED");

      await client.execute("DROP TRIGGER reject_fulfillment_claim");
      const retry = await handler(new Request(
        "https://crushify.test/api/cron/publication-lifecycle",
        { headers: { Authorization: `Bearer ${secret}` } },
      ));
      assert.equal(retry.status, 200);
      assert.equal((await client.execute(
        "SELECT status FROM fulfillment_jobs WHERE order_id = ?",
        [paidOrder.orderId],
      )).rows[0]?.status, "COMPLETED");
      assert.equal((await client.execute(
        "SELECT status FROM orders WHERE id = ?",
        [paidOrder.orderId],
      )).rows[0]?.status, "FULFILLED");
    } finally {
      client.close();
    }
  });

  it("bounds scheduled fulfillment batches and preserves idempotent retry behavior", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createStorage({ derivative: 0, source: 0 });
    try {
      await applyMigrations(client, await loadMigrations());
      const firstDesign = await createDraftFixture(client);
      const secondDesign = await createDraftFixture(client);
      const firstOrder = await createOrderSnapshot(client, firstDesign, { paid: true });
      const secondOrder = await createOrderSnapshot(client, secondDesign, { paid: true });
      const env = {
        DB: adapter,
        STORAGE: storage,
        ENVIRONMENT: "production",
      } as Parameters<typeof runScheduledPublicationLifecycle>[0];

      await assert.rejects(
        runScheduledPublicationLifecycle(env, { now: NOW, limit: 101 }),
        /batch size must be between 1 and 100/,
      );
      const firstRun = await runScheduledPublicationLifecycle(env, { now: NOW, limit: 1 });
      assert.equal(firstRun.failed, false);
      assert.deepEqual(firstRun.operations?.fulfillmentRecovery, {
        status: "completed",
        result: { attempted: 1, completed: 1, retryable: 0, manualReview: 0 },
      });
      const afterFirst = await client.execute(
        "SELECT status, COUNT(*) AS count FROM fulfillment_jobs GROUP BY status",
      );
      assert.equal(afterFirst.rows.reduce((sum, row) => sum + Number(row.count), 0), 2);
      assert.deepEqual(
        afterFirst.rows.map((row) => [row.status, Number(row.count)]).sort(),
        [["COMPLETED", 1], ["PENDING", 1]],
      );

      const secondRun = await runScheduledPublicationLifecycle(env, {
        now: new Date(NOW.getTime() + 1),
        limit: 1,
      });
      assert.equal(secondRun.failed, false);
      assert.deepEqual(secondRun.operations?.fulfillmentRecovery, {
        status: "completed",
        result: { attempted: 1, completed: 1, retryable: 0, manualReview: 0 },
      });
      const repeated = await runScheduledPublicationLifecycle(env, {
        now: new Date(NOW.getTime() + 2),
        limit: 1,
      });
      assert.deepEqual(repeated.operations?.fulfillmentRecovery, {
        status: "completed",
        result: { attempted: 0, completed: 0, retryable: 0, manualReview: 0 },
      });
      for (const order of [firstOrder, secondOrder]) {
        assert.equal((await client.execute(
          "SELECT status FROM fulfillment_jobs WHERE order_id = ?",
          [order.orderId],
        )).rows[0]?.status, "COMPLETED");
        assert.equal((await client.execute(
          "SELECT COUNT(*) AS count FROM storage_entitlements WHERE order_id = ?",
          [order.orderId],
        )).rows[0]?.count, 1);
        assert.equal((await client.execute(
          "SELECT COUNT(*) AS count FROM publications WHERE order_id = ?",
          [order.orderId],
        )).rows[0]?.count, 1);
      }
    } finally {
      client.close();
    }
  });

  it("blocks Preview lifecycle without durable storage and preserves isolated lifecycle behavior", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createStorage({ derivative: 0, source: 0 });
    const now = new Date();
    const expiredAt = new Date(now.getTime() - 60_000).toISOString();
    const activeUntil = new Date(now.getTime() + 86_400_000).toISOString();
    const secret = "a".repeat(64);
    const cronSecret = "b".repeat(64);
    let connections = 0;
    let storageCreations = 0;
    let emailCalls = 0;
    let outboundCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      outboundCalls++;
      return new Response(null, { status: 500 });
    };
    const handler = createVercelApiHandler({
      DATABASE_PROVIDER: "turso",
      TURSO_STAGING_DATABASE_URL: "libsql://crushify-staging-test-org.turso.io",
      TURSO_STAGING_AUTH_TOKEN: "synthetic-staging-token",
      STORAGE_PROVIDER: "mock",
      ENVIRONMENT: "staging",
      VERCEL_ENV: "preview",
      APP_ORIGIN: "https://crushify-staging.vercel.app",
      VERCEL_URL: "crushify-staging.vercel.app",
      CRON_SECRET: cronSecret,
      STAGING_LIFECYCLE_SECRET: secret,
      DATA_RETENTION_DAYS: "30",
    }, {
      async connectDatabase() {
        connections++;
        return { database: adapter, close: () => undefined };
      },
      createMockStorage() {
        storageCreations++;
        return storage;
      },
      async localTestEmailSink() {
        emailCalls++;
      },
    });
    const trigger = () => handler(new Request(
      "https://crushify-staging.vercel.app/api/ops/staging/publication-lifecycle",
      { method: "POST", headers: { Authorization: `Bearer ${secret}` } },
    ));

    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const expired = await createFixture(client, {
        expiresAt: expiredAt,
        extraOrderStatus: "AWAITING_PAYMENT",
      });
      const active = await createFixture(client, { expiresAt: activeUntil });
      assert.ok(expired.extraOrderId);
      const paymentsBefore = await client.execute(
        "SELECT id, provider, status FROM payments ORDER BY id",
      );
      const ordersBefore = await client.execute(
        "SELECT id, status, paid_at FROM orders ORDER BY id",
      );
      const publicationCountBefore = await client.execute(
        "SELECT COUNT(*) AS count FROM publications",
      );

      await client.execute(`CREATE TRIGGER reject_lifecycle_expiry
        BEFORE UPDATE OF status ON publications
        WHEN NEW.status = 'EXPIRED'
        BEGIN SELECT RAISE(ABORT, 'injected lifecycle failure'); END`);
      const failed = await trigger();
      assert.equal(failed.status, 503);
      assert.equal(
        (await failed.json() as { error: { code: string } }).error.code,
        "STORAGE_UNAVAILABLE",
      );
      assert.equal(connections, 0);
      assert.equal(storageCreations, 0);
      const unchanged = await client.execute({
        sql: "SELECT status, expired_at FROM publications WHERE id = ?",
        args: [expired.publicationId],
      });
      assert.deepEqual(unchanged.rows[0], { status: "PUBLISHED", expired_at: null });

      const lifecycleEnv = {
        DB: adapter,
        STORAGE: storage,
        ENVIRONMENT: "staging",
        DATA_RETENTION_DAYS: "30",
      } as Parameters<typeof runScheduledPublicationLifecycle>[0];
      const failedMaintenance = await runScheduledPublicationLifecycle(lifecycleEnv, { limit: 10 });
      assert.equal(failedMaintenance.failed, true);
      assert.equal(failedMaintenance.operations?.publicationLifecycle.status, "failed");
      assert.equal(failedMaintenance.operations?.uploadCleanup.status, "completed");
      assert.deepEqual(failedMaintenance.operations?.fulfillmentRecovery, {
        status: "skipped",
        reason: "runtime_policy",
      });
      await client.execute("DROP TRIGGER reject_lifecycle_expiry");

      const summary = await runScheduledPublicationLifecycle(lifecycleEnv, { limit: 10 });
      assert.equal(summary.acquired, true);
      assert.equal(summary.failed, false);
      assert.deepEqual(
        { expired: summary.expired, erased: summary.erased, retryable: summary.retryable },
        { expired: 1, erased: 0, retryable: 0 },
      );
      assert.equal(summary.operations?.publicationLifecycle.status, "completed");
      assert.equal(summary.operations?.uploadCleanup.status, "completed");

      const repeated = await runScheduledPublicationLifecycle(lifecycleEnv, { limit: 10 });
      assert.equal(repeated.acquired, true);
      assert.equal(repeated.failed, false);
      assert.deepEqual(
        { expired: repeated.expired, erased: repeated.erased, retryable: repeated.retryable },
        { expired: 0, erased: 0, retryable: 0 },
      );
      assert.equal(connections, 0);
      assert.equal(storageCreations, 0);

      const expiredState = await client.execute({
        sql: "SELECT status, retention_delete_after_at FROM publications WHERE id = ?",
        args: [expired.publicationId],
      });
      assert.equal(expiredState.rows[0]?.status, "EXPIRED");
      assert.ok(Date.parse(String(expiredState.rows[0]?.retention_delete_after_at)) > Date.now());
      const pendingOrder = await client.execute({
        sql: "SELECT status, paid_at FROM orders WHERE id = ?",
        args: [expired.extraOrderId],
      });
      assert.deepEqual(pendingOrder.rows[0], { status: "AWAITING_PAYMENT", paid_at: null });
      const unpaidPublication = await client.execute({
        sql: "SELECT id FROM publications WHERE order_id = ?",
        args: [expired.extraOrderId],
      });
      assert.equal(unpaidPublication.rows.length, 0);
      const paymentsAfter = await client.execute(
        "SELECT id, provider, status FROM payments ORDER BY id",
      );
      assert.deepEqual(paymentsAfter.rows, paymentsBefore.rows);
      const ordersAfter = await client.execute(
        "SELECT id, status, paid_at FROM orders ORDER BY id",
      );
      assert.deepEqual(ordersAfter.rows, ordersBefore.rows);
      const publicationCountAfter = await client.execute(
        "SELECT COUNT(*) AS count FROM publications",
      );
      assert.deepEqual(publicationCountAfter.rows, publicationCountBefore.rows);
      assert.equal((await client.execute(
        "SELECT COUNT(*) AS count FROM scheduled_task_runs WHERE status = 'FAILED'",
      )).rows[0]?.count, 1);

      const publicEnv = {
        DB: adapter,
        STORAGE: storage,
        DATA_RETENTION_DAYS: "30",
      } as Parameters<typeof runPublicationLifecycle>[0];
      assert.equal((await handleApiRequest(
        new Request(`https://crushify-staging.vercel.app/api/v1/publications/${expired.slug}`),
        publicEnv,
      )).status, 410);
      assert.equal((await handleApiRequest(
        new Request(`https://crushify-staging.vercel.app/api/v1/publications/${active.slug}`),
        publicEnv,
      )).status, 200);
      assert.equal(emailCalls, 0);
      assert.equal(outboundCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
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
        now: new Date(),
      });
      assert.equal(beforeRetention.erased, 0);
      const preserved = await client.execute({
        sql: "SELECT status FROM assets WHERE id = ?",
        args: [fixture.assetId],
      });
      assert.equal(preserved.rows[0]?.status, "READY");
      assert.ok(await storage.get(fixture.sourceKey));

      await client.execute(
        "UPDATE publications SET retention_delete_after_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
        [fixture.publicationId],
      );
      const cleanupNow = new Date();
      const derivativeFailure = await runPublicationLifecycle(env, {
        limit: 10,
        now: cleanupNow,
      });
      assert.equal(derivativeFailure.retryable, 1);
      const session = await createSession(client, fixture.customerId);
      const apiEnv = {
        DB: adapter,
        STORAGE: storage,
        APP_ORIGIN: "https://crushify.test",
        ENVIRONMENT: "local",
        LOCAL_TEST_MODE: "true",
      } as Parameters<typeof handleApiRequest>[1];
      const ownerHeaders = { Cookie: `crushify_session=${session.token}` };
      const listed = await handleApiRequest(
        new Request("https://crushify.test/api/v1/publications", { headers: ownerHeaders }),
        apiEnv,
      );
      assert.equal(listed.status, 200);
      const listedBody = await listed.json() as {
        websites: Array<{ publication_id: string; cleanup_pending: boolean }>;
      };
      const retained = listedBody.websites.find((website) =>
        website.publication_id === fixture.publicationId);
      assert.equal(retained?.cleanup_pending, true,
        "owner dashboard keeps a publication visible after cleanup failure");
      const inspected = await handleApiRequest(
        new Request(`https://crushify.test/api/v1/publications/${fixture.publicationId}`, {
          headers: ownerHeaders,
        }),
        apiEnv,
      );
      assert.equal(inspected.status, 200,
        "owner can inspect a publication while lifecycle cleanup is pending");
      const sourceFailure = await runPublicationLifecycle(env, {
        limit: 10,
        now: new Date(cleanupNow.getTime() + 3 * 60_000),
      });
      assert.equal(sourceFailure.retryable, 1);
      const completed = await runPublicationLifecycle(env, {
        limit: 10,
        now: new Date(cleanupNow.getTime() + 60 * 60_000),
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

  it("does not delete a derivative when republish wins during unpublish cleanup", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const deleteStarted = deferred();
    const releaseDelete = deferred();
    const storage = createRaceStorage({
      beforeDerivativeDelete: async () => {
        deleteStarted.resolve();
        await releaseDelete.promise;
      },
    });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        expiresAt: "2100-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture) || !("derivativeKey" in fixture)) {
        assert.fail("Expected publication derivative fixture");
      }
      const snapshot = await client.execute(
        "SELECT snapshot_json FROM publications WHERE id = ?",
        [fixture.publicationId],
      );
      const publicationData = JSON.parse(String(snapshot.rows[0]?.snapshot_json)) as {
        data: Record<string, unknown>;
      };
      publicationData.data.photos = [{ asset_id: fixture.assetId, caption: "Race" }];
      await client.execute(
        "UPDATE publications SET snapshot_json = ? WHERE id = ?",
        [JSON.stringify(publicationData), fixture.publicationId],
      );
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      await storage.storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);
      const session = await createSession(client, fixture.customerId);
      const env = {
        DB: adapter,
        STORAGE: storage.storage,
        APP_ORIGIN: "https://crushify.test",
        ENVIRONMENT: "local",
        LOCAL_TEST_MODE: "true",
      } as Parameters<typeof handleApiRequest>[1];
      const mutate = (action: string, revision: number) => assetRequest(
        env, session, `/publications/${fixture.publicationId}/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expected_lifecycle_revision: revision }),
        },
      );

      const unpublishing = mutate("unpublish", 1);
      await deleteStarted.promise;
      const republished = await mutate("publish", 2);
      assert.equal(republished.status, 503,
        "republish must wait while cleanup owns the prior derivative");
      releaseDelete.resolve();
      assert.equal((await unpublishing).status, 200);
      const retriedPublish = await mutate("publish", 2);
      assert.equal(retriedPublish.status, 200);

      const state = await client.execute({
        sql: `SELECT p.status, pa.derivative_status, pa.derivative_key
              FROM publications p JOIN publication_assets pa ON pa.publication_id = p.id
              WHERE p.id = ?`,
        args: [fixture.publicationId],
      });
      const newDerivativeKey = String(state.rows[0]?.derivative_key);
      assert.notEqual(newDerivativeKey, fixture.derivativeKey);
      assert.deepEqual(state.rows[0], {
        status: "PUBLISHED",
        derivative_status: "READY",
        derivative_key: newDerivativeKey,
      });
      assert.equal(await storage.storage.getPublishedDerivative(fixture.derivativeKey), null,
        "the retired derivative has been deleted");
      assert.ok(await storage.storage.getPublishedDerivative(
        newDerivativeKey,
      ), "republish creates and attaches a fresh derivative");
    } finally {
      releaseDelete.resolve();
      client.close();
    }
  });

  it("preserves the derivative when republish commits before stale unpublish cleanup resumes", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const database = new PausableDatabase(adapter);
    const cleanupStarted = database.pauseNextRun(
      "UPDATE publication_derivative_operations AS operation",
    );
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        expiresAt: "2100-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture) || !("derivativeKey" in fixture)) {
        assert.fail("Expected publication derivative fixture");
      }
      const snapshot = await client.execute(
        "SELECT snapshot_json FROM publications WHERE id = ?",
        [fixture.publicationId],
      );
      const publicationData = JSON.parse(String(snapshot.rows[0]?.snapshot_json)) as {
        data: Record<string, unknown>;
      };
      publicationData.data.photos = [{ asset_id: fixture.assetId, caption: "Race" }];
      await client.execute(
        "UPDATE publications SET snapshot_json = ? WHERE id = ?",
        [JSON.stringify(publicationData), fixture.publicationId],
      );
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      await storage.storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);
      const session = await createSession(client, fixture.customerId);
      const env = {
        DB: database,
        STORAGE: storage.storage,
        APP_ORIGIN: "https://crushify.test",
        ENVIRONMENT: "local",
        LOCAL_TEST_MODE: "true",
      } as Parameters<typeof handleApiRequest>[1];
      const mutate = (action: string, revision: number) => assetRequest(
        env, session, `/publications/${fixture.publicationId}/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expected_lifecycle_revision: revision }),
        },
      );

      const unpublishing = mutate("unpublish", 1);
      await cleanupStarted.entered;
      const republished = await mutate("publish", 2);
      assert.equal(republished.status, 200,
        "republish commits while the earlier unpublish cleanup has not claimed the key");
      cleanupStarted.release();
      assert.equal((await unpublishing).status, 200);

      const state = await client.execute(
        `SELECT p.status, pa.derivative_status, pa.derivative_key
         FROM publications p JOIN publication_assets pa ON pa.publication_id = p.id
         WHERE p.id = ?`,
        [fixture.publicationId],
      );
      assert.deepEqual(state.rows[0], {
        status: "PUBLISHED",
        derivative_status: "READY",
        derivative_key: fixture.derivativeKey,
      });
      assert.ok(await storage.storage.getPublishedDerivative(fixture.derivativeKey),
        "stale cleanup must preserve the derivative required by the newer publication");
    } finally {
      cleanupStarted.release();
      client.close();
    }
  });

  it("reports future retry backoff as deferred cleanup work", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "EXPIRED",
        expiresAt: "2000-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture) || !("derivativeKey" in fixture)) {
        assert.fail("Expected publication derivative fixture");
      }
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      await storage.storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);
      await client.execute(
        `UPDATE publication_derivative_operations
         SET status = 'CLEANUP_PENDING', next_cleanup_at = ?
         WHERE publication_asset_id = ?`,
        [new Date(NOW.getTime() + 60_000).toISOString(), fixture.publicationAssetId],
      );

      const result = await cleanupAssets({
        DB: adapter,
        STORAGE: storage.storage,
      } as Parameters<typeof handleApiRequest>[1], fixture.publicationId, NOW);
      assert.deepEqual(result, {
        status: "deferred",
        processed: 0,
        cleaned: 0,
        pending: 0,
        deferred: 1,
        retryable: 0,
        manualReview: 0,
        hasMore: false,
      });
      assert.ok(await storage.storage.getPublishedDerivative(fixture.derivativeKey));
      assert.equal((await client.execute(
        "SELECT status FROM publication_derivative_operations WHERE publication_asset_id = ?",
        [fixture.publicationAssetId],
      )).rows[0]?.status, "CLEANUP_PENDING");
    } finally {
      client.close();
    }
  });

  it("reports another worker's active cleanup lease as deferred work", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "EXPIRED",
        expiresAt: "2000-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture) || !("derivativeKey" in fixture)) {
        assert.fail("Expected publication derivative fixture");
      }
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      await storage.storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);
      await client.execute(
        `UPDATE publication_derivative_operations
         SET status = 'CLEANUP_PENDING', next_cleanup_at = ?,
             cleanup_lease_token = 'other-worker', cleanup_lease_expires_at = ?
         WHERE publication_asset_id = ?`,
        [new Date(NOW.getTime() - 60_000).toISOString(),
          new Date(NOW.getTime() + 5 * 60_000).toISOString(), fixture.publicationAssetId],
      );

      const result = await cleanupAssets({
        DB: adapter,
        STORAGE: storage.storage,
      } as Parameters<typeof handleApiRequest>[1], fixture.publicationId, NOW);
      assert.deepEqual(result, {
        status: "deferred",
        processed: 0,
        cleaned: 0,
        pending: 0,
        deferred: 1,
        retryable: 0,
        manualReview: 0,
        hasMore: false,
      });
      assert.ok(await storage.storage.getPublishedDerivative(fixture.derivativeKey));
      assert.equal((await client.execute(
        "SELECT cleanup_lease_token FROM publication_derivative_operations WHERE publication_asset_id = ?",
        [fixture.publicationAssetId],
      )).rows[0]?.cleanup_lease_token, "other-worker");
    } finally {
      client.close();
    }
  });

  it("reports remaining due derivatives when the cleanup batch is bounded", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixtures = await Promise.all([
        createFixture(client, {
          status: "EXPIRED",
          expiresAt: "2000-01-01T00:00:00.000Z",
          withAsset: true,
        }),
        createFixture(client, {
          status: "EXPIRED",
          expiresAt: "2000-01-01T00:00:00.000Z",
          withAsset: true,
        }),
      ]);
      for (const fixture of fixtures) {
        if (!("sourceKey" in fixture) || !("derivativeKey" in fixture)) {
          assert.fail("Expected publication derivative fixture");
        }
        await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
        await storage.storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);
      }

      const result = await reconcilePublicationDerivativeCleanup(
        { DB: adapter, STORAGE: storage.storage } as Parameters<
          typeof reconcilePublicationDerivativeCleanup
        >[0],
        { now: NOW, limit: 1 },
      );
      assert.deepEqual(result, {
        status: "pending",
        processed: 1,
        cleaned: 1,
        pending: 1,
        deferred: 0,
        retryable: 0,
        manualReview: 0,
        hasMore: true,
      });
      const operations = await client.execute(
        `SELECT derivative_key, status FROM publication_derivative_operations
         ORDER BY status, derivative_key`,
      );
      assert.equal(operations.rows.filter((row) => row.status === "CLEANED").length, 1);
      assert.equal(operations.rows.filter((row) => row.status === "CLEANUP_PENDING").length, 1);
      const cleanedKey = String(operations.rows.find((row) => row.status === "CLEANED")?.derivative_key);
      const pendingKey = String(operations.rows.find((row) => row.status === "CLEANUP_PENDING")?.derivative_key);
      assert.equal(await storage.storage.getPublishedDerivative(cleanedKey), null);
      assert.ok(await storage.storage.getPublishedDerivative(pendingKey));
    } finally {
      client.close();
    }
  });

  it("reports provider cleanup failure without claiming completion", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage({ derivativeDeleteFailures: 1 });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "EXPIRED",
        expiresAt: "2000-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture) || !("derivativeKey" in fixture)) {
        assert.fail("Expected publication derivative fixture");
      }
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      await storage.storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);

      const result = await reconcilePublicationDerivativeCleanup(
        { DB: adapter, STORAGE: storage.storage } as Parameters<
          typeof reconcilePublicationDerivativeCleanup
        >[0],
        { now: NOW },
      );
      assert.deepEqual(result, {
        status: "failed",
        processed: 1,
        cleaned: 0,
        pending: 0,
        deferred: 1,
        retryable: 1,
        manualReview: 0,
        hasMore: false,
      });
      assert.ok(await storage.storage.getPublishedDerivative(fixture.derivativeKey));
      assert.equal((await client.execute(
        "SELECT status FROM publication_derivative_operations WHERE publication_asset_id = ?",
        [fixture.publicationAssetId],
      )).rows[0]?.status, "CLEANUP_PENDING");
    } finally {
      client.close();
    }
  });

  it("retries atomic pointer detachment after a one-time database failure", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "EXPIRED",
        expiresAt: "2000-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture) || !("derivativeKey" in fixture)) {
        assert.fail("Expected publication derivative fixture");
      }
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      await storage.storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);
      await client.execute(
        `CREATE TRIGGER fail_derivative_pointer_detach
         BEFORE UPDATE OF derivative_key ON publication_assets
         WHEN OLD.derivative_key IS NOT NULL AND NEW.derivative_key IS NULL
         BEGIN SELECT RAISE(ABORT, 'injected pointer detachment failure'); END`,
      );

      const first = await reconcilePublicationDerivativeCleanup(
        { DB: adapter, STORAGE: storage.storage } as Parameters<
          typeof reconcilePublicationDerivativeCleanup
        >[0],
        { now: NOW },
      );
      assert.equal(first.status, "failed");
      assert.equal(first.retryable, 1);
      assert.equal(await storage.storage.getPublishedDerivative(fixture.derivativeKey), null,
        "provider deletion succeeded before the database finalization failed");
      assert.deepEqual((await client.execute(
        `SELECT status, cleanup_attempts FROM publication_derivative_operations
         WHERE publication_asset_id = ?`,
        [fixture.publicationAssetId],
      )).rows[0], { status: "CLEANUP_PENDING", cleanup_attempts: 1 });
      assert.deepEqual((await client.execute(
        `SELECT derivative_key, derivative_status FROM publication_assets WHERE id = ?`,
        [fixture.publicationAssetId],
      )).rows[0], {
        derivative_key: fixture.derivativeKey,
        derivative_status: "CLEANUP_PENDING",
      });

      await client.execute("DROP TRIGGER fail_derivative_pointer_detach");
      const retry = await reconcilePublicationDerivativeCleanup(
        { DB: new TursoDatabaseAdapter(client), STORAGE: storage.storage },
        { now: new Date(NOW.getTime() + 3 * 60_000) },
      );
      assert.equal(retry.status, "completed");
      assert.equal(retry.cleaned, 1);
      assert.deepEqual((await client.execute(
        `SELECT status FROM publication_derivative_operations WHERE publication_asset_id = ?`,
        [fixture.publicationAssetId],
      )).rows[0], { status: "CLEANED" });
      assert.deepEqual((await client.execute(
        `SELECT derivative_key, derivative_status FROM publication_assets WHERE id = ?`,
        [fixture.publicationAssetId],
      )).rows[0], { derivative_key: null, derivative_status: "DELETED" });
    } finally {
      client.close();
    }
  });

  it("rolls back pointer detachment when journal finalization fails in the same batch", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "EXPIRED",
        expiresAt: "2000-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture) || !("derivativeKey" in fixture)) {
        assert.fail("Expected publication derivative fixture");
      }
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      await storage.storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);
      await client.execute(
        `CREATE TRIGGER fail_derivative_journal_finalization
         BEFORE UPDATE OF status ON publication_derivative_operations
         WHEN OLD.status = 'CLEANUP_PENDING' AND NEW.status = 'CLEANED'
         BEGIN SELECT RAISE(ABORT, 'injected journal finalization failure'); END`,
      );

      const failed = await reconcilePublicationDerivativeCleanup(
        { DB: adapter, STORAGE: storage.storage },
        { now: NOW },
      );
      assert.equal(failed.status, "failed");
      assert.equal(await storage.storage.getPublishedDerivative(fixture.derivativeKey), null);
      assert.deepEqual((await client.execute(
        `SELECT status, cleanup_attempts FROM publication_derivative_operations
         WHERE publication_asset_id = ?`,
        [fixture.publicationAssetId],
      )).rows[0], { status: "CLEANUP_PENDING", cleanup_attempts: 1 });
      assert.deepEqual((await client.execute(
        `SELECT derivative_key, derivative_status FROM publication_assets WHERE id = ?`,
        [fixture.publicationAssetId],
      )).rows[0], {
        derivative_key: fixture.derivativeKey,
        derivative_status: "CLEANUP_PENDING",
      }, "the batch must roll pointer detachment back if journal completion fails");

      await client.execute("DROP TRIGGER fail_derivative_journal_finalization");
      const retry = await reconcilePublicationDerivativeCleanup(
        { DB: adapter, STORAGE: storage.storage },
        { now: new Date(NOW.getTime() + 3 * 60_000) },
      );
      assert.equal(retry.status, "completed");
      assert.deepEqual((await client.execute(
        `SELECT status FROM publication_derivative_operations WHERE publication_asset_id = ?`,
        [fixture.publicationAssetId],
      )).rows[0], { status: "CLEANED" });
      assert.deepEqual((await client.execute(
        `SELECT derivative_key, derivative_status FROM publication_assets WHERE id = ?`,
        [fixture.publicationAssetId],
      )).rows[0], { derivative_key: null, derivative_status: "DELETED" });
    } finally {
      client.close();
    }
  });

  it("recovers cleanup after restart between provider deletion and database finalization", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "EXPIRED",
        expiresAt: "2000-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture) || !("derivativeKey" in fixture)) {
        assert.fail("Expected publication derivative fixture");
      }
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      await storage.storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);
      await client.execute(
        `UPDATE publication_derivative_operations SET status = 'CLEANUP_PENDING',
           next_cleanup_at = ?, cleanup_lease_token = NULL, cleanup_lease_expires_at = NULL
         WHERE publication_asset_id = ?`,
        [NOW.toISOString(), fixture.publicationAssetId],
      );
      await client.execute(
        `UPDATE publication_assets SET derivative_status = 'CLEANUP_PENDING'
         WHERE id = ?`,
        [fixture.publicationAssetId],
      );

      await storage.storage.deletePublishedDerivative(fixture.derivativeKey);
      const restarted = await reconcilePublicationDerivativeCleanup(
        { DB: new TursoDatabaseAdapter(client), STORAGE: storage.storage },
        { now: new Date(NOW.getTime() + 60_000) },
      );
      assert.equal(restarted.status, "completed");
      assert.equal(restarted.cleaned, 1);
      assert.equal(await storage.storage.getPublishedDerivative(fixture.derivativeKey), null);
      assert.deepEqual((await client.execute(
        `SELECT status FROM publication_derivative_operations WHERE publication_asset_id = ?`,
        [fixture.publicationAssetId],
      )).rows[0], { status: "CLEANED" });
      assert.deepEqual((await client.execute(
        `SELECT derivative_key, derivative_status FROM publication_assets WHERE id = ?`,
        [fixture.publicationAssetId],
      )).rows[0], { derivative_key: null, derivative_status: "DELETED" });
    } finally {
      client.close();
    }
  });

  it("fences an overlapping cleanup worker with the active cleanup lease", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const deleteStarted = deferred();
    const releaseDelete = deferred();
    const storage = createRaceStorage({
      beforeDerivativeDelete: async () => {
        deleteStarted.resolve();
        await releaseDelete.promise;
      },
    });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "EXPIRED",
        expiresAt: "2000-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture) || !("derivativeKey" in fixture)) {
        assert.fail("Expected publication derivative fixture");
      }
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      await storage.storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);

      const first = reconcilePublicationDerivativeCleanup(
        { DB: adapter, STORAGE: storage.storage },
        { now: NOW },
      );
      await deleteStarted.promise;
      const overlapping = await reconcilePublicationDerivativeCleanup(
        { DB: adapter, STORAGE: storage.storage },
        { now: NOW },
      );
      assert.equal(overlapping.status, "deferred");
      assert.equal(overlapping.processed, 0);
      assert.equal(overlapping.deferred, 1);
      assert.ok(await storage.storage.getPublishedDerivative(fixture.derivativeKey));

      releaseDelete.resolve();
      const completed = await first;
      assert.equal(completed.status, "completed");
      assert.equal(completed.cleaned, 1);
      assert.equal(await storage.storage.getPublishedDerivative(fixture.derivativeKey), null);
      assert.deepEqual((await client.execute(
        `SELECT status FROM publication_derivative_operations
         WHERE publication_asset_id = ?`,
        [fixture.publicationAssetId],
      )).rows[0], { status: "CLEANED" });
      assert.deepEqual((await client.execute(
        `SELECT derivative_key, derivative_status FROM publication_assets WHERE id = ?`,
        [fixture.publicationAssetId],
      )).rows[0], { derivative_key: null, derivative_status: "DELETED" });
    } finally {
      releaseDelete.resolve();
      client.close();
    }
  });

  it("does not detach a newer active publication pointer when stale cleanup resumes", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const deleteCompleted = deferred();
    const resumeCleanup = deferred();
    const storage = createRaceStorage({
      afterDerivativeDelete: async () => {
        deleteCompleted.resolve();
        await resumeCleanup.promise;
      },
    });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "EXPIRED",
        expiresAt: "2000-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture) || !("derivativeKey" in fixture)) {
        assert.fail("Expected publication derivative fixture");
      }
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      await storage.storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);

      const staleCleanup = reconcilePublicationDerivativeCleanup(
        { DB: adapter, STORAGE: storage.storage },
        { now: NOW },
      );
      await deleteCompleted.promise;

      const newerKey = `published/new-${randomUUID()}.png`;
      await storage.storage.createPublishedDerivative(fixture.sourceKey, newerKey);
      await client.execute(
        `UPDATE publication_assets SET derivative_key = ?, derivative_status = 'READY'
         WHERE id = ?`,
        [newerKey, fixture.publicationAssetId],
      );
      await client.execute(
        `INSERT INTO publication_derivative_operations (
           id, publication_asset_id, publication_id, derivative_key, status, operation_token,
           operation_lease_expires_at, next_cleanup_at, provider_create_succeeded_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'READY', ?, ?, ?, ?, ?, ?)`,
        [
          `new-derivative-${fixture.publicationAssetId}`, fixture.publicationAssetId,
          fixture.publicationId, newerKey, `new-operation-token-${fixture.publicationAssetId}`,
          new Date(NOW.getTime() + 15 * 60_000).toISOString(),
          new Date(NOW.getTime() + 60 * 60_000).toISOString(),
          NOW.toISOString(), NOW.toISOString(), NOW.toISOString(),
        ],
      );
      await client.execute(
        `UPDATE publications SET status = 'PUBLISHED' WHERE id = ?`,
        [fixture.publicationId],
      );

      resumeCleanup.resolve();
      const staleResult = await staleCleanup;
      assert.equal(staleResult.cleaned, 1,
        "the retired derivative can finish cleanup after its pointer was replaced");
      assert.equal(await storage.storage.getPublishedDerivative(fixture.derivativeKey), null);
      assert.ok(await storage.storage.getPublishedDerivative(newerKey));
      assert.deepEqual((await client.execute(
        `SELECT p.status, pa.derivative_key, pa.derivative_status
         FROM publications p JOIN publication_assets pa ON pa.publication_id = p.id
         WHERE pa.id = ?`,
        [fixture.publicationAssetId],
      )).rows[0], {
        status: "PUBLISHED",
        derivative_key: newerKey,
        derivative_status: "READY",
      });
    } finally {
      resumeCleanup.resolve();
      client.close();
    }
  });

  it("keeps a permanently failed pointer detachment in manual review", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "EXPIRED",
        expiresAt: "2000-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture) || !("derivativeKey" in fixture)) {
        assert.fail("Expected publication derivative fixture");
      }
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      await storage.storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);
      await client.execute(
        `UPDATE publication_derivative_operations
         SET status = 'CLEANUP_PENDING', cleanup_attempts = 7, next_cleanup_at = ?
         WHERE publication_asset_id = ?`,
        [NOW.toISOString(), fixture.publicationAssetId],
      );
      await client.execute(
        `CREATE TRIGGER keep_derivative_pointer_attached
         BEFORE UPDATE OF derivative_key ON publication_assets
         WHEN OLD.derivative_key IS NOT NULL AND NEW.derivative_key IS NULL
         BEGIN SELECT RAISE(ABORT, 'persistent pointer detachment failure'); END`,
      );

      const failed = await reconcilePublicationDerivativeCleanup(
        { DB: adapter, STORAGE: storage.storage },
        { now: NOW },
      );
      assert.equal(failed.status, "manual_review");
      assert.equal(failed.manualReview, 1);
      assert.equal(await storage.storage.getPublishedDerivative(fixture.derivativeKey), null);
      assert.deepEqual((await client.execute(
        `SELECT status, cleanup_attempts FROM publication_derivative_operations
         WHERE publication_asset_id = ?`,
        [fixture.publicationAssetId],
      )).rows[0], { status: "MANUAL_REVIEW", cleanup_attempts: 8 });
      assert.deepEqual((await client.execute(
        `SELECT derivative_key, derivative_status FROM publication_assets WHERE id = ?`,
        [fixture.publicationAssetId],
      )).rows[0], {
        derivative_key: fixture.derivativeKey,
        derivative_status: "CLEANUP_PENDING",
      });

      const checked = await reconcilePublicationDerivativeCleanup(
        { DB: adapter, STORAGE: storage.storage },
        { now: new Date(NOW.getTime() + 30 * 24 * 60 * 60_000) },
      );
      assert.equal(checked.status, "manual_review");
      assert.equal(checked.manualReview, 1,
        "provider absence alone must not resolve manual review");
      assert.equal((await client.execute(
        `SELECT status, provider_create_succeeded_at, last_cleanup_error_code
         FROM publication_derivative_operations WHERE publication_asset_id = ?`,
        [fixture.publicationAssetId],
      )).rows[0]?.status, "MANUAL_REVIEW");
    } finally {
      client.close();
    }
  });

  it("keeps an uncertain provider delete visible after the object was removed", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage({
      afterDerivativeDelete: async () => {
        throw new Error("Provider accepted deletion but response timed out");
      },
    });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "EXPIRED",
        expiresAt: "2000-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture) || !("derivativeKey" in fixture)) {
        assert.fail("Expected publication derivative fixture");
      }
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      await storage.storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);

      const result = await reconcilePublicationDerivativeCleanup(
        { DB: adapter, STORAGE: storage.storage } as Parameters<
          typeof reconcilePublicationDerivativeCleanup
        >[0],
        { now: NOW },
      );
      assert.equal(result.status, "failed");
      assert.equal(result.retryable, 1);
      assert.equal(result.deferred, 1);
      assert.equal(result.cleaned, 0,
        "provider uncertainty must not be reported as verified cleanup");
      assert.equal(await storage.storage.getPublishedDerivative(fixture.derivativeKey), null);
      assert.equal((await client.execute(
        `SELECT status FROM publication_derivative_operations
         WHERE publication_asset_id = ?`,
        [fixture.publicationAssetId],
      )).rows[0]?.status, "CLEANUP_PENDING");
    } finally {
      client.close();
    }
  });

  it("avoids redundant tombstone rechecks after confirmed provider cleanup", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "UNPUBLISHED",
        expiresAt: "2100-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture) || !("derivativeKey" in fixture)) {
        assert.fail("Expected publication derivative fixture");
      }
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      await storage.storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);
      const env = {
        DB: adapter,
        STORAGE: storage.storage,
      } as Parameters<typeof handleApiRequest>[1];

      const completed = await cleanupAssets(env, fixture.publicationId, NOW);
      assert.deepEqual(completed, {
        status: "completed",
        processed: 1,
        cleaned: 1,
        pending: 0,
        deferred: 0,
        retryable: 0,
        manualReview: 0,
        hasMore: false,
      });
      assert.equal(await storage.storage.getPublishedDerivative(fixture.derivativeKey), null);
      assert.deepEqual((await client.execute(
        `SELECT status, derivative_key FROM publication_derivative_operations
         WHERE publication_asset_id = ?`,
        [fixture.publicationAssetId],
      )).rows[0], { status: "CLEANED", derivative_key: fixture.derivativeKey });

      const scheduledRecheck = await reconcilePublicationDerivativeCleanup(env, {
        now: NOW,
      });
      assert.equal(scheduledRecheck.status, "completed");
      assert.equal(scheduledRecheck.deferred, 0);
    } finally {
      client.close();
    }
  });

  it("reports completed when the requested publication has no cleanup work", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "UNPUBLISHED",
        expiresAt: "2100-01-01T00:00:00.000Z",
        withAsset: false,
      });

      const result = await cleanupAssets({
        DB: adapter,
        STORAGE: storage.storage,
      } as Parameters<typeof handleApiRequest>[1], fixture.publicationId, NOW);
      assert.deepEqual(result, {
        status: "completed",
        processed: 0,
        cleaned: 0,
        pending: 0,
        deferred: 0,
        retryable: 0,
        manualReview: 0,
        hasMore: false,
      });
    } finally {
      client.close();
    }
  });

  it("reports deferred while an uncertain CLEANED tombstone awaits its next provider recheck", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "UNPUBLISHED",
        expiresAt: "2100-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("derivativeKey" in fixture)) assert.fail("Expected derivative fixture");
      await storage.storage.deletePublishedDerivative(fixture.derivativeKey);
      await client.execute(
        `UPDATE publication_derivative_operations
         SET status = 'CLEANED', provider_create_succeeded_at = NULL,
             operation_lease_expires_at = ?,
             next_cleanup_at = ?, cleanup_lease_token = NULL, cleanup_lease_expires_at = NULL
         WHERE publication_asset_id = ?`,
        [
          new Date(NOW.getTime() - 60_000).toISOString(),
          new Date(NOW.getTime() + 60 * 60_000).toISOString(),
          fixture.publicationAssetId,
        ],
      );
      await client.execute(
        `UPDATE publication_assets SET derivative_key = NULL, derivative_status = 'DELETED'
         WHERE id = ?`,
        [fixture.publicationAssetId],
      );

      const result = await cleanupAssets({
        DB: adapter,
        STORAGE: storage.storage,
      } as Parameters<typeof handleApiRequest>[1], fixture.publicationId, NOW);
      assert.equal(result.status, "deferred");
      assert.equal(result.deferred, 1);
      assert.equal(result.cleaned, 0);
      assert.deepEqual((await client.execute(
        `SELECT status, next_cleanup_at FROM publication_derivative_operations
         WHERE publication_asset_id = ?`,
        [fixture.publicationAssetId],
      )).rows[0], {
        status: "CLEANED",
        next_cleanup_at: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
      });
      assert.equal(await storage.storage.getPublishedDerivative(fixture.derivativeKey), null);
    } finally {
      client.close();
    }
  });

  it("reports deferred cleanup through overlapping scheduler invocations", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const database = new PausableDatabase(adapter);
    const cleanupStarted = database.pauseNextRun(
      "UPDATE publication_derivative_operations AS operation",
    );
    const storage = createRaceStorage();
    const logged: string[] = [];
    const originalInfo = console.info;
    console.info = (message?: unknown) => logged.push(String(message));
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "EXPIRED",
        expiresAt: "2000-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture) || !("derivativeKey" in fixture)) {
        assert.fail("Expected publication derivative fixture");
      }
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      await storage.storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);
      const nextCleanupAt = new Date(NOW.getTime() + 60_000).toISOString();
      await client.execute(
        `UPDATE publications SET retention_delete_after_at = ?
         WHERE id = ?`,
        [NOW.toISOString(), fixture.publicationId],
      );
      await client.execute(
        `UPDATE publication_derivative_operations
         SET status = 'CLEANUP_PENDING', next_cleanup_at = ?
         WHERE publication_asset_id = ?`,
        [nextCleanupAt, fixture.publicationAssetId],
      );
      const env = {
        DB: database,
        STORAGE: storage.storage,
        ENVIRONMENT: "staging",
      } as Parameters<typeof runScheduledPublicationLifecycle>[0];

      const firstRun = runScheduledPublicationLifecycle(env, { now: NOW, limit: 10 });
      await cleanupStarted.entered;
      const overlappingRun = await runScheduledPublicationLifecycle(env, { now: NOW, limit: 10 });
      assert.deepEqual(overlappingRun, { acquired: false });
      cleanupStarted.release();
      const result = await firstRun;
      assert.equal(result.acquired, true);
      assert.equal(result.failed, false);
      assert.equal(result.pending, true);
      assert.equal(
        result.operations?.publicationDerivativeCleanup.status,
        "completed",
      );
      assert.equal(
        result.operations?.publicationDerivativeCleanup.result?.status,
        "deferred",
      );
      assert.ok(logged.some((message) =>
        message.includes('"event":"scheduler.derivative_cleanup_deferred"')));
      assert.ok(await storage.storage.getPublishedDerivative(fixture.derivativeKey));
      assert.equal((await client.execute(
        `SELECT status FROM publication_derivative_operations
         WHERE publication_asset_id = ?`,
        [fixture.publicationAssetId],
      )).rows[0]?.status, "CLEANUP_PENDING");
    } finally {
      cleanupStarted.release();
      console.info = originalInfo;
      client.close();
    }
  });

  it("retains and reconciles a timed-out derivative creation after consent revocation", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const createStarted = deferred();
    const releaseCreate = deferred();
    let lateDerivativeKey = "";
    const storage = createRaceStorage({
      beforeDerivative: async (key) => {
        if (!lateDerivativeKey) lateDerivativeKey = key;
        createStarted.resolve();
        await releaseCreate.promise;
      },
      afterDerivative: async () => {
        throw new Error("Provider accepted derivative but response timed out");
      },
    });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "UNPUBLISHED",
        expiresAt: "2100-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture)) assert.fail("Expected publication source fixture");
      const snapshot = await client.execute(
        "SELECT snapshot_json FROM publications WHERE id = ?",
        [fixture.publicationId],
      );
      const publicationData = JSON.parse(String(snapshot.rows[0]?.snapshot_json)) as {
        data: Record<string, unknown>;
      };
      publicationData.data.photos = [{ asset_id: fixture.assetId, caption: "Race" }];
      await client.execute(
        "UPDATE publications SET snapshot_json = ? WHERE id = ?",
        [JSON.stringify(publicationData), fixture.publicationId],
      );
      await client.execute(
        `UPDATE publication_assets SET derivative_key = NULL, derivative_status = 'PENDING'
         WHERE id = ?`,
        [fixture.publicationAssetId],
      );
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      const session = await createSession(client, fixture.customerId);
      const env = {
        DB: adapter,
        STORAGE: storage.storage,
        APP_ORIGIN: "https://crushify.test",
        ENVIRONMENT: "local",
        LOCAL_TEST_MODE: "true",
      } as Parameters<typeof handleApiRequest>[1];
      const publishing = assetRequest(
        env, session, `/publications/${fixture.publicationId}/publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expected_lifecycle_revision: 1 }),
        },
      );
      await createStarted.promise;
      const consentRevoked = await assetRequest(
        env, session,
        `/publications/${fixture.publicationId}/assets/${fixture.assetId}/consent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      assert.equal(consentRevoked.status, 503,
        "revocation is effective but in-flight provider creation remains deferred");
      const revokeAudit = await client.execute(
        `SELECT metadata_json FROM audit_logs
         WHERE entity_id = ? AND action = 'publication.asset_consent_revoked'`,
        [fixture.publicationId],
      );
      assert.deepEqual(JSON.parse(String(revokeAudit.rows[0]?.metadata_json)), {
        asset_id: fixture.assetId,
        cleanup_status: "manual_review",
      });
      releaseCreate.resolve();
      assert.equal((await publishing).status, 503);

      const state = await client.execute({
        sql: `SELECT pa.revoked_at, pa.derivative_status, pa.derivative_key,
                p.status AS publication_status
              FROM publication_assets pa JOIN publications p ON p.id = pa.publication_id
              WHERE pa.id = ?`,
        args: [fixture.publicationAssetId],
      });
      assert.equal(state.rows[0]?.revoked_at !== null, true);
      assert.equal(state.rows[0]?.derivative_key, null);
      assert.equal(state.rows[0]?.derivative_status, "DELETED");
      const retainedAttempt = await client.execute(
        `SELECT status, provider_create_succeeded_at, last_cleanup_error_code
         FROM publication_derivative_operations
         WHERE derivative_key = ?`,
        [lateDerivativeKey],
      );
      assert.deepEqual(retainedAttempt.rows[0], {
        status: "MANUAL_REVIEW",
        provider_create_succeeded_at: null,
        last_cleanup_error_code: "PROVIDER_CREATE_OUTCOME_UNCONFIRMED",
      }, "uncertain provider creation must remain visible after pointer detachment");
      assert.ok(await storage.storage.getPublishedDerivative(lateDerivativeKey),
        "the test provider created the object after revocation cleanup completed");

      const recoveryTime = new Date(Date.now() + 2 * 60 * 60_000);
      const scheduled = await runScheduledPublicationLifecycle(env, {
        now: recoveryTime,
        limit: 25,
      });
      assert.equal(scheduled.operations.publicationDerivativeCleanup.status, "completed");
      const recovered = scheduled.operations.publicationDerivativeCleanup.result;
      assert.ok(recovered);
      assert.equal(recovered.status, "pending");
      assert.equal(recovered.cleaned, 0,
        "positive lookup queues cleanup for the next bounded reconciliation pass");
      assert.ok(await storage.storage.getPublishedDerivative(lateDerivativeKey));
      const deleted = await reconcilePublicationDerivativeCleanup(env, {
        publicationId: fixture.publicationId,
        now: recoveryTime,
      });
      assert.equal(deleted.status, "completed");
      assert.equal(deleted.cleaned, 1);
      assert.equal(await storage.storage.getPublishedDerivative(lateDerivativeKey), null,
        "scheduled reconciliation deletes the late object by its durable attempt key");
      const repeated = await reconcilePublicationDerivativeCleanup(env, {
        publicationId: fixture.publicationId,
        now: new Date(recoveryTime.getTime() + 2 * 60 * 60_000),
      });
      assert.equal(repeated.status, "completed", "repeated cleanup remains idempotent");
      assert.equal(repeated.cleaned, 0);
      assert.equal(await storage.storage.getPublishedDerivative(lateDerivativeKey), null);
    } finally {
      releaseCreate.resolve();
      client.close();
    }
  });

  it("reconciles a provider success after cleanup has reached manual review", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const createStarted = deferred();
    const releaseCreate = deferred();
    let lateDerivativeKey = "";
    const storage = createRaceStorage({
      beforeDerivative: async (key) => {
        if (!lateDerivativeKey) lateDerivativeKey = key;
        createStarted.resolve();
        await releaseCreate.promise;
      },
      derivativeDeleteFailures: 2,
    });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "UNPUBLISHED",
        expiresAt: "2100-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture)) assert.fail("Expected publication source fixture");
      const snapshot = await client.execute(
        "SELECT snapshot_json FROM publications WHERE id = ?",
        [fixture.publicationId],
      );
      const publicationData = JSON.parse(String(snapshot.rows[0]?.snapshot_json)) as {
        data: Record<string, unknown>;
      };
      publicationData.data.photos = [{ asset_id: fixture.assetId, caption: "Late success" }];
      await client.execute(
        "UPDATE publications SET snapshot_json = ? WHERE id = ?",
        [JSON.stringify(publicationData), fixture.publicationId],
      );
      await client.execute(
        "DELETE FROM publication_derivative_operations WHERE publication_asset_id = ?",
        [fixture.publicationAssetId],
      );
      await client.execute(
        `UPDATE publication_assets SET derivative_key = NULL, derivative_status = 'PENDING'
         WHERE id = ?`,
        [fixture.publicationAssetId],
      );
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      const session = await createSession(client, fixture.customerId);
      const env = {
        DB: adapter,
        STORAGE: storage.storage,
        APP_ORIGIN: "https://crushify.test",
        ENVIRONMENT: "local",
        LOCAL_TEST_MODE: "true",
      } as Parameters<typeof handleApiRequest>[1];
      const publishing = assetRequest(
        env, session, `/publications/${fixture.publicationId}/publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expected_lifecycle_revision: 1 }),
        },
      );
      await createStarted.promise;

      const revoked = await assetRequest(
        env, session,
        `/publications/${fixture.publicationId}/assets/${fixture.assetId}/consent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      assert.equal(revoked.status, 503);
      await client.execute(
        `UPDATE publication_derivative_operations
         SET status = 'CLEANUP_PENDING', cleanup_attempts = 7,
             next_cleanup_at = ?, operation_lease_expires_at = ?
         WHERE derivative_key = ?`,
        [
          new Date(NOW.getTime() - 60_000).toISOString(),
          new Date(NOW.getTime() - 60_000).toISOString(),
          lateDerivativeKey,
        ],
      );
      const exhausted = await reconcilePublicationDerivativeCleanup(
        { DB: adapter, STORAGE: storage.storage },
        { now: NOW },
      );
      assert.equal(exhausted.status, "manual_review");
      assert.equal(exhausted.manualReview, 1);
      assert.equal((await client.execute(
        `SELECT status, cleanup_attempts FROM publication_derivative_operations
         WHERE derivative_key = ?`,
        [lateDerivativeKey],
      )).rows[0]?.status, "MANUAL_REVIEW");
      assert.equal(await storage.storage.getPublishedDerivative(lateDerivativeKey), null);

      releaseCreate.resolve();
      assert.equal((await publishing).status, 409);
      const observedLateSuccess = (await client.execute(
        `SELECT status, provider_create_succeeded_at
         FROM publication_derivative_operations WHERE derivative_key = ?`,
        [lateDerivativeKey],
      )).rows[0];
      assert.equal(observedLateSuccess?.status, "CLEANUP_PENDING");
      assert.ok(observedLateSuccess?.provider_create_succeeded_at);

      const activePublication = await createFixture(client, {
        status: "PUBLISHED",
        expiresAt: "2100-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in activePublication) || !("derivativeKey" in activePublication)) {
        assert.fail("Expected active derivative fixture");
      }
      await storage.storage.upload(activePublication.sourceKey, IMAGE, { contentType: "image/png" });
      await storage.storage.createPublishedDerivative(
        activePublication.sourceKey, activePublication.derivativeKey,
      );

      assert.ok(await storage.storage.getPublishedDerivative(lateDerivativeKey));

      const restartedEnv = { ...env };
      const reconciled = await reconcilePublicationDerivativeCleanup(
        restartedEnv,
        { now: new Date(Date.now() + 60_000), limit: 25 },
      );
      assert.ok(reconciled.cleaned >= 1);
      const operationAfterLateSuccess = await client.execute(
        `SELECT status, provider_create_succeeded_at
         FROM publication_derivative_operations WHERE derivative_key = ?`,
        [lateDerivativeKey],
      );
      assert.equal(operationAfterLateSuccess.rows[0]?.status, "CLEANED");
      assert.ok(operationAfterLateSuccess.rows[0]?.provider_create_succeeded_at);
      assert.equal(await storage.storage.getPublishedDerivative(lateDerivativeKey), null);
      assert.ok(await storage.storage.getPublishedDerivative(activePublication.derivativeKey),
        "late cleanup must not remove a newer publication's distinct derivative");
      assert.deepEqual((await client.execute(
        `SELECT derivative_status, derivative_key FROM publication_assets WHERE id = ?`,
        [activePublication.publicationAssetId],
      )).rows[0], {
        derivative_status: "READY",
        derivative_key: activePublication.derivativeKey,
      });
      assert.equal((await client.execute(
        "SELECT status FROM publications WHERE id = ?",
        [fixture.publicationId],
      )).rows[0]?.status, "UNPUBLISHED");
    } finally {
      releaseCreate.resolve();
      client.close();
    }
  });

  it("fences cleanup finalization when provider success arrives during deletion", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const createStarted = deferred();
    const releaseCreate = deferred();
    const deleteStarted = deferred();
    const releaseDelete = deferred();
    let derivativeKey = "";
    const storage = createRaceStorage({
      beforeDerivative: async (key) => {
        derivativeKey = key;
        createStarted.resolve();
        await releaseCreate.promise;
      },
      beforeDerivativeDelete: async () => {
        deleteStarted.resolve();
        await releaseDelete.promise;
      },
    });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "UNPUBLISHED",
        expiresAt: "2100-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture)) assert.fail("Expected publication source fixture");
      const snapshot = await client.execute(
        "SELECT snapshot_json FROM publications WHERE id = ?",
        [fixture.publicationId],
      );
      const publicationData = JSON.parse(String(snapshot.rows[0]?.snapshot_json)) as {
        data: Record<string, unknown>;
      };
      publicationData.data.photos = [{ asset_id: fixture.assetId, caption: "Cleanup race" }];
      await client.execute(
        "UPDATE publications SET snapshot_json = ? WHERE id = ?",
        [JSON.stringify(publicationData), fixture.publicationId],
      );
      await client.execute(
        "DELETE FROM publication_derivative_operations WHERE publication_asset_id = ?",
        [fixture.publicationAssetId],
      );
      await client.execute(
        `UPDATE publication_assets SET derivative_key = NULL, derivative_status = 'PENDING'
         WHERE id = ?`,
        [fixture.publicationAssetId],
      );
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      const session = await createSession(client, fixture.customerId);
      const env = {
        DB: adapter,
        STORAGE: storage.storage,
        APP_ORIGIN: "https://crushify.test",
        ENVIRONMENT: "local",
        LOCAL_TEST_MODE: "true",
      } as Parameters<typeof handleApiRequest>[1];
      const publishing = assetRequest(
        env, session, `/publications/${fixture.publicationId}/publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expected_lifecycle_revision: 1 }),
        },
      );
      await createStarted.promise;

      const revoking = assetRequest(
        env, session, `/publications/${fixture.publicationId}/assets/${fixture.assetId}/consent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      await deleteStarted.promise;
      releaseCreate.resolve();
      assert.equal((await publishing).status, 409);
      const successMarker = await client.execute(
        `SELECT provider_create_succeeded_at FROM publication_derivative_operations
         WHERE derivative_key = ?`,
        [derivativeKey],
      );
      assert.ok(successMarker.rows[0]?.provider_create_succeeded_at);

      releaseDelete.resolve();
      assert.equal((await revoking).status, 503,
        "the stale cleanup claim must not report a fenced finalization as complete");
      const fenced = await client.execute(
        `SELECT status, provider_create_succeeded_at, cleanup_lease_token
         FROM publication_derivative_operations WHERE derivative_key = ?`,
        [derivativeKey],
      );
      assert.equal(fenced.rows[0]?.status, "CLEANUP_PENDING");
      assert.ok(fenced.rows[0]?.provider_create_succeeded_at);
      assert.ok(fenced.rows[0]?.cleanup_lease_token,
        "the old claim remains fenced until its lease expires");
      assert.equal(await storage.storage.getPublishedDerivative(derivativeKey), null);

      const recoveryTime = new Date(Date.now() + 60_000);
      await client.execute(
        `UPDATE publication_derivative_operations
         SET next_cleanup_at = ?, cleanup_lease_expires_at = ?
         WHERE derivative_key = ?`,
        [
          new Date(recoveryTime.getTime() - 60_000).toISOString(),
          new Date(recoveryTime.getTime() - 60_000).toISOString(),
          derivativeKey,
        ],
      );
      const recovered = await reconcilePublicationDerivativeCleanup(
        { DB: adapter, STORAGE: storage.storage },
        { now: recoveryTime },
      );
      assert.ok(recovered.cleaned >= 1);
      assert.equal((await client.execute(
        `SELECT status FROM publication_derivative_operations WHERE derivative_key = ?`,
        [derivativeKey],
      )).rows[0]?.status, "CLEANED");
      assert.equal(await storage.storage.getPublishedDerivative(derivativeKey), null);
    } finally {
      releaseCreate.resolve();
      releaseDelete.resolve();
      client.close();
    }
  });

  it("counts exhausted derivative cleanup once and leaves it for manual review", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage({ derivativeDeleteFailures: 1 });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "EXPIRED",
        expiresAt: "2000-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture) || !("derivativeKey" in fixture)) {
        assert.fail("Expected publication derivative fixture");
      }
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      await storage.storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);
      await client.execute(
        `UPDATE publication_derivative_operations
         SET status = 'CLEANUP_PENDING', cleanup_attempts = 7,
             next_cleanup_at = '2000-01-01T00:00:00.000Z'
         WHERE publication_asset_id = ?`,
        [fixture.publicationAssetId],
      );

      const exhausted = await reconcilePublicationDerivativeCleanup(
        { DB: adapter, STORAGE: storage.storage } as Parameters<
          typeof reconcilePublicationDerivativeCleanup
        >[0],
        { now: NOW },
      );
      assert.deepEqual(exhausted, {
        status: "manual_review",
        processed: 1,
        cleaned: 0,
        pending: 0,
        deferred: 0,
        retryable: 1,
        manualReview: 1,
        hasMore: false,
      });
      assert.deepEqual(
        (await client.execute(
          `SELECT status, cleanup_attempts FROM publication_derivative_operations
           WHERE publication_asset_id = ?`,
          [fixture.publicationAssetId],
        )).rows[0],
        { status: "MANUAL_REVIEW", cleanup_attempts: 8 },
      );
      assert.ok(await storage.storage.getPublishedDerivative(fixture.derivativeKey));

      const later = await reconcilePublicationDerivativeCleanup(
        { DB: adapter, STORAGE: storage.storage } as Parameters<
          typeof reconcilePublicationDerivativeCleanup
        >[0],
        { now: new Date(NOW.getTime() + 30 * 24 * 60 * 60_000) },
      );
      assert.deepEqual(later, {
        status: "pending",
        processed: 1,
        cleaned: 0,
        pending: 1,
        deferred: 0,
        retryable: 0,
        manualReview: 0,
        hasMore: true,
      });
      assert.equal((await client.execute(
        `SELECT status, cleanup_attempts FROM publication_derivative_operations
         WHERE publication_asset_id = ?`,
        [fixture.publicationAssetId],
      )).rows[0]?.status, "CLEANUP_PENDING",
      "a confirmed provider object reopens bounded cleanup instead of remaining ignored");
      const completed = await reconcilePublicationDerivativeCleanup(
        { DB: adapter, STORAGE: storage.storage },
        { now: new Date(NOW.getTime() + 30 * 24 * 60 * 60_000) },
      );
      assert.equal(completed.status, "completed");
      assert.equal(completed.cleaned, 1);
      assert.equal(await storage.storage.getPublishedDerivative(fixture.derivativeKey), null);
    } finally {
      client.close();
    }
  });

  it("recovers a provider create after restart when manual-review lookup confirms the object", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "EXPIRED",
        expiresAt: "2000-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture) || !("derivativeKey" in fixture)) {
        assert.fail("Expected publication derivative fixture");
      }
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      await storage.storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);
      await client.execute(
        `UPDATE publication_derivative_operations
         SET status = 'MANUAL_REVIEW', cleanup_attempts = 8,
             provider_create_succeeded_at = NULL, next_cleanup_at = ?,
             cleanup_lease_token = NULL, cleanup_lease_expires_at = NULL
         WHERE publication_asset_id = ?`,
        [NOW.toISOString(), fixture.publicationAssetId],
      );
      await client.execute(
        `UPDATE publication_assets SET derivative_status = 'CLEANUP_PENDING'
         WHERE id = ?`,
        [fixture.publicationAssetId],
      );

      const restarted = await reconcilePublicationDerivativeCleanup(
        { DB: new TursoDatabaseAdapter(client), STORAGE: storage.storage },
        { now: NOW, limit: 1 },
      );
      assert.equal(restarted.status, "pending");
      assert.equal(restarted.processed, 1);
      assert.equal(restarted.manualReview, 0);
      assert.ok(await storage.storage.getPublishedDerivative(fixture.derivativeKey),
        "confirmed presence is queued for cleanup rather than deleted by the lookup step");
      assert.deepEqual((await client.execute(
        `SELECT status, provider_create_succeeded_at, cleanup_lease_token
         FROM publication_derivative_operations WHERE publication_asset_id = ?`,
        [fixture.publicationAssetId],
      )).rows[0], {
        status: "CLEANUP_PENDING",
        provider_create_succeeded_at: NOW.toISOString(),
        cleanup_lease_token: null,
      });

      const cleanup = await reconcilePublicationDerivativeCleanup(
        { DB: new TursoDatabaseAdapter(client), STORAGE: storage.storage },
        { now: NOW, limit: 1 },
      );
      assert.equal(cleanup.status, "completed");
      assert.equal(cleanup.cleaned, 1);
      assert.equal(await storage.storage.getPublishedDerivative(fixture.derivativeKey), null);
      assert.deepEqual((await client.execute(
        `SELECT status, derivative_key FROM publication_derivative_operations
         WHERE publication_asset_id = ?`,
        [fixture.publicationAssetId],
      )).rows[0], { status: "CLEANED", derivative_key: fixture.derivativeKey });
    } finally {
      client.close();
    }
  });

  it("keeps an absent manual-review object inconclusive and schedules a bounded recheck", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "EXPIRED",
        expiresAt: "2000-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("derivativeKey" in fixture)) assert.fail("Expected publication derivative fixture");
      await client.execute(
        `UPDATE publication_derivative_operations
         SET status = 'MANUAL_REVIEW', cleanup_attempts = 8,
             provider_create_succeeded_at = NULL, next_cleanup_at = ?
         WHERE publication_asset_id = ?`,
        [NOW.toISOString(), fixture.publicationAssetId],
      );
      await client.execute(
        `UPDATE publication_assets SET derivative_status = 'CLEANUP_PENDING'
         WHERE id = ?`,
        [fixture.publicationAssetId],
      );

      const result = await reconcilePublicationDerivativeCleanup(
        { DB: adapter, STORAGE: storage.storage },
        { now: NOW },
      );
      assert.equal(result.status, "manual_review");
      assert.equal(result.manualReview, 1);
      assert.deepEqual((await client.execute(
        `SELECT status, provider_create_succeeded_at, cleanup_lease_token,
                last_cleanup_error_code, next_cleanup_at
         FROM publication_derivative_operations WHERE publication_asset_id = ?`,
        [fixture.publicationAssetId],
      )).rows[0], {
        status: "MANUAL_REVIEW",
        provider_create_succeeded_at: null,
        cleanup_lease_token: null,
        last_cleanup_error_code: "PROVIDER_LOOKUP_INCONCLUSIVE",
        next_cleanup_at: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
      });
    } finally {
      client.close();
    }
  });

  it("keeps manual review visible when provider lookup fails", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage({ derivativeGetFailures: 1 });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "EXPIRED",
        expiresAt: "2000-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture) || !("derivativeKey" in fixture)) {
        assert.fail("Expected publication derivative fixture");
      }
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      await storage.storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);
      await client.execute(
        `UPDATE publication_derivative_operations
         SET status = 'MANUAL_REVIEW', cleanup_attempts = 8,
             provider_create_succeeded_at = NULL, next_cleanup_at = ?
         WHERE publication_asset_id = ?`,
        [NOW.toISOString(), fixture.publicationAssetId],
      );
      await client.execute(
        `UPDATE publication_assets SET derivative_status = 'CLEANUP_PENDING'
         WHERE id = ?`,
        [fixture.publicationAssetId],
      );

      const result = await reconcilePublicationDerivativeCleanup(
        { DB: adapter, STORAGE: storage.storage },
        { now: NOW },
      );
      assert.equal(result.status, "manual_review");
      assert.equal(result.retryable, 1);
      assert.equal(result.manualReview, 1);
      assert.ok(await storage.storage.getPublishedDerivative(fixture.derivativeKey));
      const state = (await client.execute(
        `SELECT status, provider_create_succeeded_at, cleanup_lease_token,
                last_cleanup_error_code
         FROM publication_derivative_operations WHERE publication_asset_id = ?`,
        [fixture.publicationAssetId],
      )).rows[0];
      assert.equal(state?.status, "MANUAL_REVIEW");
      assert.equal(state?.provider_create_succeeded_at, null);
      assert.equal(state?.cleanup_lease_token, null);
      assert.equal(state?.last_cleanup_error_code, "Error");
    } finally {
      client.close();
    }
  });

  it("prevents concurrent manual-review provider lookups with the cleanup lease", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const lookupStarted = deferred();
    const releaseLookup = deferred();
    let lookupCount = 0;
    const storage = createRaceStorage({
      beforeDerivativeGet: async () => {
        lookupCount++;
        lookupStarted.resolve();
        await releaseLookup.promise;
      },
    });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "EXPIRED",
        expiresAt: "2000-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture) || !("derivativeKey" in fixture)) {
        assert.fail("Expected publication derivative fixture");
      }
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      await storage.storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);
      await client.execute(
        `UPDATE publication_derivative_operations
         SET status = 'MANUAL_REVIEW', cleanup_attempts = 8,
             provider_create_succeeded_at = NULL, next_cleanup_at = ?
         WHERE publication_asset_id = ?`,
        [NOW.toISOString(), fixture.publicationAssetId],
      );

      const first = reconcilePublicationDerivativeCleanup(
        { DB: adapter, STORAGE: storage.storage },
        { now: NOW },
      );
      await lookupStarted.promise;
      const overlapping = await reconcilePublicationDerivativeCleanup(
        { DB: adapter, STORAGE: storage.storage },
        { now: NOW },
      );
      assert.equal(overlapping.status, "manual_review");
      assert.equal(overlapping.processed, 0);
      assert.equal(lookupCount, 1);
      assert.ok((await client.execute(
        `SELECT cleanup_lease_token FROM publication_derivative_operations
         WHERE publication_asset_id = ?`,
        [fixture.publicationAssetId],
      )).rows[0]?.cleanup_lease_token);

      releaseLookup.resolve();
      const recovered = await first;
      assert.equal(recovered.status, "pending");
      assert.equal(recovered.processed, 1);
      assert.equal(lookupCount, 1);
      assert.ok(await storage.storage.getPublishedDerivative(fixture.derivativeKey));
    } finally {
      releaseLookup.resolve();
      client.close();
    }
  });

  it("does not recover a manual-review derivative still referenced by an active publication", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "PUBLISHED",
        expiresAt: "2100-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture) || !("derivativeKey" in fixture)) {
        assert.fail("Expected publication derivative fixture");
      }
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      await storage.storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);
      await client.execute(
        `UPDATE publication_derivative_operations
         SET status = 'MANUAL_REVIEW', cleanup_attempts = 8,
             provider_create_succeeded_at = NULL, next_cleanup_at = ?
         WHERE publication_asset_id = ?`,
        [NOW.toISOString(), fixture.publicationAssetId],
      );

      const result = await reconcilePublicationDerivativeCleanup(
        { DB: adapter, STORAGE: storage.storage },
        { now: NOW },
      );
      assert.equal(result.status, "manual_review");
      assert.equal(result.processed, 0);
      assert.equal(result.manualReview, 1);
      assert.ok(await storage.storage.getPublishedDerivative(fixture.derivativeKey));
      assert.deepEqual((await client.execute(
        `SELECT p.status, pa.derivative_key, pa.derivative_status
         FROM publications p JOIN publication_assets pa ON pa.publication_id = p.id
         WHERE pa.id = ?`,
        [fixture.publicationAssetId],
      )).rows[0], {
        status: "PUBLISHED",
        derivative_key: fixture.derivativeKey,
        derivative_status: "READY",
      });
    } finally {
      client.close();
    }
  });

  it("stops starting manual-review work when the reconciliation time budget expires", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    let lookupCount = 0;
    const storage = createRaceStorage({
      beforeDerivativeGet: async () => {
        lookupCount++;
        if (lookupCount === 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      },
    });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixtures = [
        await createFixture(client, {
          status: "UNPUBLISHED",
          expiresAt: "2100-01-01T00:00:00.000Z",
          withAsset: true,
        }),
        await createFixture(client, {
          status: "UNPUBLISHED",
          expiresAt: "2100-01-01T00:00:00.000Z",
          withAsset: true,
        }),
      ];
      for (const fixture of fixtures) {
        if (!("sourceKey" in fixture) || !("derivativeKey" in fixture)) {
          assert.fail("Expected publication derivative fixture");
        }
        await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
        await storage.storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);
        await client.execute(
          `UPDATE publication_derivative_operations
           SET status = 'MANUAL_REVIEW', cleanup_attempts = 8,
               provider_create_succeeded_at = NULL, next_cleanup_at = ?
           WHERE publication_asset_id = ?`,
          [NOW.toISOString(), fixture.publicationAssetId],
        );
      }

      const result = await reconcilePublicationDerivativeCleanup(
        { DB: adapter, STORAGE: storage.storage },
        { now: NOW, limit: 25, timeBudgetMs: 50 },
      );
      assert.equal(result.processed, 1);
      assert.equal(lookupCount, 1,
        "no additional provider lookup starts after the time budget is exhausted");
      assert.equal(result.manualReview, 1);
      assert.ok(result.hasMore);
    } finally {
      client.close();
    }
  });

  it("bounds scheduled manual-review recovery by the configured batch size", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    let lookupCount = 0;
    const storage = createRaceStorage({
      beforeDerivativeGet: async () => { lookupCount++; },
    });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixtures = [
        await createFixture(client, {
          status: "UNPUBLISHED",
          expiresAt: "2100-01-01T00:00:00.000Z",
          withAsset: true,
        }),
        await createFixture(client, {
          status: "UNPUBLISHED",
          expiresAt: "2100-01-01T00:00:00.000Z",
          withAsset: true,
        }),
      ];
      for (const fixture of fixtures) {
        if (!("sourceKey" in fixture) || !("derivativeKey" in fixture)) {
          assert.fail("Expected publication derivative fixture");
        }
        await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
        await storage.storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);
        await client.execute(
          `UPDATE publication_derivative_operations
           SET status = 'MANUAL_REVIEW', cleanup_attempts = 8,
               provider_create_succeeded_at = NULL, next_cleanup_at = ?
           WHERE publication_asset_id = ?`,
          [NOW.toISOString(), fixture.publicationAssetId],
        );
        await client.execute(
          `UPDATE publication_assets SET derivative_status = 'CLEANUP_PENDING'
           WHERE id = ?`,
          [fixture.publicationAssetId],
        );
      }

      const scheduled = await runScheduledPublicationLifecycle({
        DB: adapter,
        STORAGE: storage.storage,
        ENVIRONMENT: "local",
        LOCAL_TEST_MODE: "true",
      } as Parameters<typeof runScheduledPublicationLifecycle>[0], {
        now: NOW,
        limit: 1,
      });
      const cleanup = scheduled.operations?.publicationDerivativeCleanup;
      assert.equal(scheduled.failed, true,
        "unresolved manual-review work remains an explicit scheduler failure");
      assert.equal(cleanup?.status, "completed");
      assert.equal(cleanup?.result?.status, "manual_review");
      assert.equal(cleanup?.result?.processed, 1);
      assert.equal(cleanup?.result?.manualReview, 1);
      assert.ok(cleanup?.result?.hasMore);
      assert.equal(lookupCount, 1,
        "the scheduled invocation does not exceed its one-operation batch limit");
    } finally {
      client.close();
    }
  });

  it("does not clean a source asset referenced by another active publication", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createStorage({ derivative: 0, source: 0 });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const expired = await createFixture(client, {
        status: "EXPIRED",
        expiresAt: "2099-01-01T00:00:00.000Z",
        retentionUntil: "2099-01-30T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in expired) || !("derivativeKey" in expired)) {
        assert.fail("Expected expired asset fixture");
      }
      const active = await createFixture(client, {
        customerId: expired.customerId,
        expiresAt: "2100-01-01T00:00:00.000Z",
      });
      const activeDerivative = `published/active-${randomUUID()}.png`;
      const now = new Date("2099-02-01T00:00:00.000Z").toISOString();
      await client.execute({
        sql: `INSERT INTO publication_assets (
                id, publication_id, asset_id, customer_id, consent_version, consented_at,
                derivative_key, derivative_status, created_at, updated_at
              ) VALUES (?, ?, ?, ?, 'public-image-v1', ?, ?, 'READY', ?, ?)`,
        args: [
          randomUUID(), active.publicationId, expired.assetId, expired.customerId,
          now, activeDerivative, now, now,
        ],
      });
      await storage.upload(expired.sourceKey, IMAGE, { contentType: "image/png" });
      await storage.createPublishedDerivative(expired.sourceKey, expired.derivativeKey);
      await storage.createPublishedDerivative(expired.sourceKey, activeDerivative);

      const result = await runPublicationLifecycle({
        DB: adapter,
        STORAGE: storage,
        DATA_RETENTION_DAYS: "30",
      } as Parameters<typeof runPublicationLifecycle>[0], {
        limit: 10,
        now: new Date("2099-02-01T00:00:00.000Z"),
      });
      assert.deepEqual(result, { expired: 0, erased: 0, retryable: 1 });

      const state = await client.execute({
        sql: `SELECT a.status AS asset_status, pa.derivative_status, p.status AS active_status
              FROM assets a
              JOIN publication_assets pa ON pa.asset_id = a.id
              JOIN publications p ON p.id = pa.publication_id
              WHERE a.id = ? AND p.id = ?`,
        args: [expired.assetId, active.publicationId],
      });
      assert.deepEqual(state.rows[0], {
        asset_status: "READY",
        derivative_status: "READY",
        active_status: "PUBLISHED",
      });
      assert.ok(await storage.get(expired.sourceKey));
      assert.ok(await storage.getPublishedDerivative(expired.derivativeKey));
      assert.ok(await storage.getPublishedDerivative(activeDerivative));
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
      await client.execute(
        "UPDATE publications SET retention_delete_after_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
        [fixture.publicationId],
      );
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

  it("soft-deletes a paid website, preserves its ledger and source data, and retries derivative cleanup", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const deletionAttempts = { derivative: [] as string[], source: [] as string[] };
    const storage = createStorage({ derivative: 1, source: 0 }, deletionAttempts);
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        expiresAt: "2100-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture) || !("derivativeKey" in fixture)) {
        assert.fail("Expected asset fixture");
      }
      await storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      await storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);
      const session = await createSession(client, fixture.customerId);
      const harness = deletionContext(adapter, storage, session);

      const failed = await harness.deleteDesign(fixture.designId);
      assert.equal(failed.status, 503);
      const pending = await client.execute({
        sql: `SELECT d.status AS design_status, p.status AS publication_status,
                     e.status AS entitlement_status, payment.status AS payment_status,
                     p.snapshot_json
              FROM designs d
              JOIN publications p ON p.design_id = d.id
              JOIN storage_entitlements e ON e.publication_id = p.id
              JOIN orders o ON o.id = p.order_id
              JOIN payments payment ON payment.order_id = o.id
              WHERE d.id = ?`,
        args: [fixture.designId],
      });
      const preservedSnapshot = String(pending.rows[0]?.snapshot_json);
      assert.deepEqual(pending.rows[0], {
        design_status: "DELETION_PENDING",
        publication_status: "UNPUBLISHED",
        entitlement_status: "ACTIVE",
        payment_status: "SUCCEEDED",
        snapshot_json: preservedSnapshot,
      });
      assert.match(preservedSnapshot, /\{"data":/);
      const dashboard = await handleApiRequest(
        new Request("https://crushify.test/api/v1/publications", {
          headers: { Cookie: `crushify_session=${session.token}` },
        }),
        harness.env,
      );
      assert.equal(dashboard.status, 200);
      const dashboardBody = await dashboard.json() as {
        websites: Array<{
          design_id: string;
          design_status: string;
          cleanup_pending: boolean;
          deletion_requested: boolean;
          media_cleanup_pending: boolean;
        }>;
      };
      const pendingDesign = dashboardBody.websites.find((website) =>
        website.design_id === fixture.designId);
      assert.equal(pendingDesign?.design_status, "DELETION_PENDING");
      assert.equal(pendingDesign?.cleanup_pending, true);
      assert.equal(pendingDesign?.deletion_requested, true);
      assert.equal(pendingDesign?.media_cleanup_pending, true);

      await client.execute(
        `UPDATE publication_derivative_operations SET next_cleanup_at = '2000-01-01T00:00:00.000Z'
         WHERE publication_asset_id = ? AND status = 'CLEANUP_PENDING'`,
        [fixture.publicationAssetId],
      );
      const retried = await harness.deleteDesign(fixture.designId);
      assert.equal(retried.status, 202);
      const repeated = await harness.deleteDesign(fixture.designId);
      assert.equal(repeated.status, 202);
      const finalState = await client.execute({
        sql: `SELECT d.status AS design_status, p.status AS publication_status,
                     e.status AS entitlement_status, payment.status AS payment_status,
                     p.snapshot_json, a.status AS asset_status, o.status AS order_status
              FROM designs d
              JOIN publications p ON p.design_id = d.id
              JOIN storage_entitlements e ON e.publication_id = p.id
              JOIN orders o ON o.id = p.order_id
              JOIN payments payment ON payment.order_id = o.id
              JOIN assets a ON a.design_id = d.id
              WHERE d.id = ?`,
        args: [fixture.designId],
      });
      assert.deepEqual(finalState.rows[0], {
        design_status: "DELETION_PENDING",
        publication_status: "UNPUBLISHED",
        entitlement_status: "ACTIVE",
        payment_status: "SUCCEEDED",
        snapshot_json: preservedSnapshot,
        asset_status: "READY",
        order_status: "FULFILLED",
      });
      assert.equal(await storage.get(fixture.sourceKey) !== null, true);
      assert.equal(await storage.getPublishedDerivative(fixture.derivativeKey), null);
      assert.deepEqual(deletionAttempts.source, []);
      assert.equal(deletionAttempts.derivative.length, 2);
      const ledger = await client.execute({
        sql: `SELECT
                (SELECT count(*) FROM orders WHERE design_id = ?) AS orders,
                (SELECT count(*) FROM payments WHERE order_id = ?) AS payments,
                (SELECT status FROM payments WHERE order_id = ?) AS payment_status`,
        args: [fixture.designId, fixture.orderId, fixture.orderId],
      });
      assert.deepEqual(ledger.rows[0], {
        orders: 1,
        payments: 1,
        payment_status: "SUCCEEDED",
      });
    } finally {
      client.close();
    }
  });

  it("rejects unauthenticated, invalid-CSRF, and cross-customer deletion requests", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const customerA = await createDraftFixture(client);
      const customerB = await createDraftFixture(client);
      const sessionA = await createSession(client, customerA.customerId);
      const unauthenticated = deletionContext(adapter, createStorage({ derivative: 0, source: 0 }));
      const denied = await unauthenticated.deleteDesign(customerA.designId);
      assert.equal(denied.status, 401);

      const harness = deletionContext(adapter, createStorage({ derivative: 0, source: 0 }), sessionA);
      const badCsrf = await harness.deleteDesign(customerA.designId, { "X-CSRF-Token": "invalid" });
      assert.equal(badCsrf.status, 403);
      const badOrigin = await harness.deleteDesign(customerA.designId, { Origin: "https://attacker.test" });
      assert.equal(badOrigin.status, 403);
      const foreign = await harness.deleteDesign(customerB.designId);
      assert.equal(foreign.status, 404);
      const state = await client.execute(
        "SELECT id, status FROM designs WHERE id IN (?, ?) ORDER BY id",
        [customerA.designId, customerB.designId],
      );
      assert.equal(state.rows.every((row) => row.status === "DRAFT"), true);
    } finally {
      client.close();
    }
  });

  it("physically deletes an unpaid draft idempotently and keeps cleanup retryable", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const deletionAttempts = { derivative: [] as string[], source: [] as string[] };
    const storage = createStorage({ derivative: 0, source: 1 }, deletionAttempts);
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createDraftFixture(client, true);
      await storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      const session = await createSession(client, fixture.customerId);
      const harness = deletionContext(adapter, storage, session);

      const failed = await harness.deleteDesign(fixture.designId);
      assert.equal(failed.status, 503);
      const pending = await client.execute({
        sql: `SELECT d.status AS design_status, d.data_json, a.status AS asset_status
              FROM designs d JOIN assets a ON a.design_id = d.id WHERE d.id = ?`,
        args: [fixture.designId],
      });
      assert.deepEqual(pending.rows[0], {
        design_status: "DELETION_PENDING",
        data_json: String((await client.execute("SELECT data_json FROM designs WHERE id = ?", [fixture.designId]))
          .rows[0]?.data_json),
        asset_status: "DELETION_PENDING",
      });
      assert.equal(await storage.get(fixture.sourceKey) !== null, true);

      const retried = await harness.deleteDesign(fixture.designId);
      assert.equal(retried.status, 200);
      const repeated = await harness.deleteDesign(fixture.designId);
      assert.equal(repeated.status, 200);
      const archived = await client.execute({
        sql: `SELECT d.status AS design_status, d.data_json, a.status AS asset_status
              FROM designs d JOIN assets a ON a.design_id = d.id WHERE d.id = ?`,
        args: [fixture.designId],
      });
      assert.deepEqual(archived.rows[0], {
        design_status: "ARCHIVED",
        data_json: "{}",
        asset_status: "DELETED",
      });
      assert.equal(await storage.get(fixture.sourceKey), null);
      assert.equal(deletionAttempts.source.length, 2);
    } finally {
      client.close();
    }
  });

  it("retries legacy archived cleanup after reference backfill without losing the source object", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage({ sourceDeleteFailures: 1 });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      const migrations = await loadMigrations();
      assert.deepEqual(
        await applyMigrations(client, migrations.filter((migration) => migration.version <= 10)),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      );
      const customerId = randomUUID();
      const designId = randomUUID();
      const firstAssetId = randomUUID();
      const retainedAssetId = randomUUID();
      const firstKey = `private/${firstAssetId}.png`;
      const retainedKey = `private/${retainedAssetId}.png`;
      const now = new Date().toISOString();
      const historicalData = JSON.stringify({
        photos: [{ asset_id: firstAssetId }, { asset_id: retainedAssetId }],
      });
      await client.batch([
        {
          sql: `INSERT INTO customers (
                  id, email, email_normalized, status, created_at, updated_at
                ) VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
          args: [customerId, `${customerId}@legacy.test`, `${customerId}@legacy.test`, now, now],
        },
        {
          sql: `INSERT INTO designs (
                  id, customer_id, template_id, schema_version, data_json, revision, status,
                  created_at, updated_at
                ) VALUES (?, ?, 'our-universe', 1, ?, 1, 'ARCHIVED', ?, ?)`,
          args: [designId, customerId, historicalData, now, now],
        },
        {
          sql: `INSERT INTO design_revisions (design_id, revision, data_json, created_at)
                VALUES (?, 1, ?, ?)`,
          args: [designId, historicalData, now],
        },
        ...[firstAssetId, retainedAssetId].map((assetId) => ({
          sql: `INSERT INTO assets (
                  id, customer_id, design_id, object_key, visibility, status, media_type,
                  byte_size, sha256, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'PRIVATE', 'READY', 'image/png', ?, ?, ?, ?)`,
          args: [assetId, customerId, designId, `private/${assetId}.png`,
            IMAGE.length, "e".repeat(64), now, now],
        })),
      ]);
      await storage.storage.upload(firstKey, IMAGE, { contentType: "image/png" });
      await storage.storage.upload(retainedKey, IMAGE, { contentType: "image/png" });

      assert.deepEqual(
        await applyMigrations(client, migrations.filter((migration) => migration.version <= 11)),
        [11],
      );
      const retainingPublication = await createFixture(client, {
        status: "EXPIRED",
        expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
        retentionUntil: new Date(Date.now() + 86_400_000).toISOString(),
        customerId,
      });
      const publicationAssetId = randomUUID();
      await client.execute({
        sql: `INSERT INTO publication_assets (
                id, publication_id, asset_id, customer_id, consent_version, consented_at,
                derivative_key, derivative_status, created_at, updated_at
              ) VALUES (?, ?, ?, ?, 'public-image-v1', ?, ?, 'PENDING', ?, ?)`,
        args: [publicationAssetId, retainingPublication.publicationId, retainedAssetId,
          customerId, now, "public/legacy-pending.webp", now, now],
      });
      const backfilled = await client.execute({
        sql: `SELECT asset_id, revision FROM design_asset_refs
              WHERE design_id = ? ORDER BY asset_id`,
        args: [designId],
      });
      assert.deepEqual(backfilled.rows, [
        { asset_id: firstAssetId, revision: 1 },
        { asset_id: retainedAssetId, revision: 1 },
      ].sort((a, b) => a.asset_id.localeCompare(b.asset_id)));
      await client.execute(
        "UPDATE publication_assets SET derivative_status = 'PENDING' WHERE id = ?",
        [publicationAssetId],
      );

      storage.objects.delete(firstKey);
      await assert.rejects(
        client.execute(
          "UPDATE assets SET status = 'DELETION_PENDING' WHERE id = ?",
          [firstAssetId],
        ),
        /referenced asset cannot be deleted/,
        "the historical DB transition failed after the provider object had already been removed",
      );
      assert.equal((await client.execute(
        "SELECT status FROM assets WHERE id = ?",
        [firstAssetId],
      )).rows[0]?.status, "READY");

      assert.deepEqual(await applyMigrations(client, migrations),
        [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
      assert.deepEqual(await applyMigrations(client, migrations), []);
      assert.deepEqual(
        (await client.execute(
          `SELECT status FROM publication_derivative_operations
           WHERE publication_asset_id IN (
             SELECT id FROM publication_assets WHERE publication_id = ?
           )`,
          [retainingPublication.publicationId],
        )).rows,
        [{ status: "CREATING" }],
        "migration 0013 preserves in-flight derivatives for recovery rather than forgetting their keys",
      );
      await assert.rejects(
        client.execute(
          "UPDATE assets SET status = 'DELETION_PENDING' WHERE id = ?",
          [firstAssetId],
        ),
        /referenced asset cannot be deleted/,
        "migration 0012 keeps the backfilled reference protected after upgrade",
      );
      const session = await createSession(client, customerId);
      const harness = deletionContext(adapter, storage.storage, session);
      const beforeSnapshot = (await client.execute(
        "SELECT data_json FROM order_design_snapshots WHERE order_id = ?",
        [retainingPublication.orderId],
      )).rows[0]?.data_json;
      const beforePublication = (await client.execute(
        "SELECT status, snapshot_json FROM publications WHERE id = ?",
        [retainingPublication.publicationId],
      )).rows[0];
      const beforeEntitlement = (await client.execute(
        "SELECT status, expires_at FROM storage_entitlements WHERE order_id = ?",
        [retainingPublication.orderId],
      )).rows[0];
      const protectedRetry = await harness.deleteDesign(designId);
      assert.equal(protectedRetry.status, 409);
      assert.equal(await storage.storage.get(retainedKey) !== null, true);
      assert.equal((await client.execute(
        "SELECT status FROM assets WHERE id = ?",
        [retainedAssetId],
      )).rows[0]?.status, "READY");
      assert.equal((await client.execute(
        "SELECT COUNT(*) AS count FROM design_asset_refs WHERE design_id = ?",
        [designId],
      )).rows[0]?.count, 2);

      await client.execute(
        "UPDATE publications SET retention_delete_after_at = ? WHERE id = ?",
        [new Date(Date.now() - 1_000).toISOString(), retainingPublication.publicationId],
      );
      const failedCleanup = await harness.deleteDesign(designId);
      assert.equal(failedCleanup.status, 503);
      const retryable = await client.execute({
        sql: `SELECT d.status AS design_status, a.status AS asset_status,
                (SELECT COUNT(*) FROM design_asset_refs ref WHERE ref.design_id = d.id) AS design_refs
              FROM designs d JOIN assets a ON a.design_id = d.id WHERE d.id = ?
              ORDER BY a.id`,
        args: [designId],
      });
      assert.equal(retryable.rows.length, 2);
      assert.ok(retryable.rows.every((row) =>
        row.design_status === "ARCHIVED" && row.asset_status === "DELETION_PENDING" &&
        row.design_refs === 0));
      assert.equal(await storage.storage.get(firstKey), null);

      const retainedLedger = await client.execute({
        sql: `SELECT o.status AS order_status, payment.status AS payment_status,
                     snapshot.data_json, entitlement.status AS entitlement_status,
                     entitlement.expires_at
              FROM orders o
              JOIN payments payment ON payment.order_id = o.id
              JOIN order_design_snapshots snapshot ON snapshot.order_id = o.id
              JOIN storage_entitlements entitlement ON entitlement.order_id = o.id
              WHERE o.id = ?`,
        args: [retainingPublication.orderId],
      });
      assert.deepEqual(retainedLedger.rows[0], {
        order_status: "FULFILLED",
        payment_status: "SUCCEEDED",
        data_json: beforeSnapshot,
        entitlement_status: beforeEntitlement?.status,
        expires_at: beforeEntitlement?.expires_at,
      });

      assert.equal((await harness.deleteDesign(designId)).status, 200);
      assert.equal((await harness.deleteDesign(designId)).status, 200);
      assert.equal(await storage.storage.get(firstKey), null);
      assert.equal(await storage.storage.get(retainedKey), null);
      assert.deepEqual((await client.execute(
        "SELECT status, snapshot_json FROM publications WHERE id = ?",
        [retainingPublication.publicationId],
      )).rows[0], beforePublication);
      const cleaned = await client.execute(
        "SELECT id, status FROM assets WHERE design_id = ? ORDER BY id",
        [designId],
      );
      assert.deepEqual(cleaned.rows, [
        { id: firstAssetId, status: "DELETED" },
        { id: retainedAssetId, status: "DELETED" },
      ].sort((a, b) => a.id.localeCompare(b.id)));
    } finally {
      client.close();
    }
  });

  it("preserves source assets referenced by another active publication", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createStorage({ derivative: 0, source: 0 });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const draft = await createDraftFixture(client, true);
      const other = await createFixture(client, {
        customerId: draft.customerId,
        expiresAt: "2100-01-01T00:00:00.000Z",
      });
      const publicationAssetId = randomUUID();
      await client.execute({
        sql: `INSERT INTO publication_assets (
                id, publication_id, asset_id, customer_id, consent_version, consented_at,
                derivative_status, created_at, updated_at
              ) VALUES (?, ?, ?, ?, 'public-image-v1', ?, 'DELETED', ?, ?)`,
        args: [publicationAssetId, other.publicationId, draft.assetId, draft.customerId,
          NOW.toISOString(), NOW.toISOString(), NOW.toISOString()],
      });
      await storage.upload(draft.sourceKey, IMAGE, { contentType: "image/png" });
      const session = await createSession(client, draft.customerId);
      const harness = deletionContext(adapter, storage, session);
      const response = await harness.deleteDesign(draft.designId);
      assert.equal(response.status, 409);
      const state = await client.execute({
        sql: `SELECT d.status AS design_status, a.status AS asset_status
              FROM designs d JOIN assets a ON a.design_id = d.id WHERE d.id = ?`,
        args: [draft.designId],
      });
      assert.deepEqual(state.rows[0], { design_status: "DRAFT", asset_status: "READY" });
      assert.equal(await storage.get(draft.sourceKey) !== null, true);
    } finally {
      client.close();
    }
  });

  it("protects assets for every active or retained publication state", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const cases = [
        { status: "PUBLISHED" as const, expiresAt: "2100-01-01T00:00:00.000Z", retentionUntil: "2000-01-01T00:00:00.000Z" },
        { status: "UNPUBLISHED" as const, expiresAt: "2100-01-01T00:00:00.000Z", retentionUntil: "2000-01-01T00:00:00.000Z" },
        { status: "EXPIRED" as const, expiresAt: "2000-01-01T00:00:00.000Z", retentionUntil: "2099-02-01T00:00:00.000Z" },
        { status: "REVOKED" as const, expiresAt: "2000-01-01T00:00:00.000Z", retentionUntil: "2099-02-01T00:00:00.000Z" },
      ];
      for (const testCase of cases) {
        const fixture = await createFixture(client, { ...testCase, withAsset: true });
        if (!("sourceKey" in fixture)) assert.fail("Expected source asset fixture");
        await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
        const session = await createSession(client, fixture.customerId);
        const harness = deletionContext(adapter, storage.storage, session);

        const response = await assetRequest(
          harness.env, session, `/assets/${fixture.assetId}`, { method: "DELETE" },
        );
        assert.equal(response.status, 409, `${testCase.status} must protect its source`);
        const state = await client.execute({
          sql: `SELECT a.status AS asset_status, p.status AS publication_status
                FROM assets a JOIN publication_assets ref ON ref.asset_id = a.id
                JOIN publications p ON p.id = ref.publication_id
                WHERE a.id = ?`,
          args: [fixture.assetId],
        });
        assert.deepEqual(state.rows[0], {
          asset_status: "READY",
          publication_status: testCase.status,
        });
        assert.ok(await storage.storage.get(fixture.sourceKey));
      }
    } finally {
      client.close();
    }
  });

  it("allows source cleanup only after expired or revoked retention ends", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      for (const status of ["EXPIRED", "REVOKED"] as const) {
        const fixture = await createFixture(client, {
          status,
          expiresAt: "2000-01-01T00:00:00.000Z",
          retentionUntil: "2000-02-01T00:00:00.000Z",
          withAsset: true,
        });
        if (!("sourceKey" in fixture) || !("derivativeKey" in fixture)) {
          assert.fail("Expected retained publication asset fixture");
        }
        await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
        await storage.storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);
        const session = await createSession(client, fixture.customerId);
        const harness = deletionContext(adapter, storage.storage, session);

        assert.equal((await assetRequest(
          harness.env, session, `/assets/${fixture.assetId}`, { method: "DELETE" },
        )).status, 200, `${status} no longer protects beyond its deadline`);
        assert.equal((await assetRequest(
          harness.env, session, `/assets/${fixture.assetId}`, { method: "DELETE" },
        )).status, 200, "repeated deletion is idempotent");
        assert.equal(await storage.storage.get(fixture.sourceKey), null);

        const lifecycle = await runPublicationLifecycle({
          DB: adapter,
          STORAGE: storage.storage,
          DATA_RETENTION_DAYS: "30",
        } as Parameters<typeof runPublicationLifecycle>[0], {
          limit: 10,
          now: new Date("2100-01-01T00:00:00.000Z"),
        });
        assert.equal(lifecycle.erased, 1);
        const erased = await client.execute({
          sql: `SELECT a.status AS asset_status, p.snapshot_json, p.retention_delete_after_at
                FROM assets a JOIN publication_assets ref ON ref.asset_id = a.id
                JOIN publications p ON p.id = ref.publication_id WHERE a.id = ?`,
          args: [fixture.assetId],
        });
        assert.deepEqual(erased.rows[0], {
          asset_status: "DELETED",
          snapshot_json: "{}",
          retention_delete_after_at: null,
        });
      }
    } finally {
      client.close();
    }
  });

  it("serializes retained publication reference creation against asset deletion", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const database = new PausableDatabase(adapter);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "REVOKED",
        expiresAt: "2000-01-01T00:00:00.000Z",
        retentionUntil: "2000-02-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture)) assert.fail("Expected source asset fixture");
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      await client.execute("DELETE FROM publication_assets WHERE id = ?", [fixture.publicationAssetId]);
      const session = await createSession(client, fixture.customerId);
      const harness = deletionContext(database, storage.storage, session);
      const gate = database.pauseNextBatch();
      const deletion = assetRequest(
        harness.env, session, `/assets/${fixture.assetId}`, { method: "DELETE" },
      );
      await gate.entered;

      const now = NOW.toISOString();
      await client.execute({
        sql: `INSERT INTO publication_assets (
                id, publication_id, asset_id, customer_id, consent_version, consented_at,
                derivative_status, created_at, updated_at
              ) VALUES (?, ?, ?, ?, 'public-image-v1', ?, 'PENDING', ?, ?)`,
        args: [randomUUID(), fixture.publicationId, fixture.assetId,
          fixture.customerId, now, now, now],
      });
      await client.execute(
        "UPDATE publications SET status = 'UNPUBLISHED', updated_at = ? WHERE id = ?",
        [now, fixture.publicationId],
      );
      gate.release();

      assert.notEqual((await deletion).status, 200);
      const state = await client.execute({
        sql: `SELECT a.status AS asset_status, p.status AS publication_status,
                COUNT(ref.id) AS references_count
              FROM assets a JOIN publications p ON p.id = ?
              LEFT JOIN publication_assets ref ON ref.asset_id = a.id AND ref.publication_id = p.id
              WHERE a.id = ? GROUP BY a.id`,
        args: [fixture.publicationId, fixture.assetId],
      });
      assert.deepEqual(state.rows[0], {
        asset_status: "READY",
        publication_status: "UNPUBLISHED",
        references_count: 1,
      });
      assert.ok(await storage.storage.get(fixture.sourceKey));
    } finally {
      client.close();
    }
  });

  it("rejects retained publication references after asset deletion has committed", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "REVOKED",
        expiresAt: "2000-01-01T00:00:00.000Z",
        retentionUntil: "2000-02-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture)) assert.fail("Expected source asset fixture");
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      await client.execute("DELETE FROM publication_assets WHERE id = ?", [fixture.publicationAssetId]);
      const session = await createSession(client, fixture.customerId);
      const harness = deletionContext(adapter, storage.storage, session);

      assert.equal((await assetRequest(
        harness.env, session, `/assets/${fixture.assetId}`, { method: "DELETE" },
      )).status, 200);
      await assert.rejects(client.execute({
        sql: `INSERT INTO publication_assets (
                id, publication_id, asset_id, customer_id, consent_version, consented_at,
                derivative_status, created_at, updated_at
              ) VALUES (?, ?, ?, ?, 'public-image-v1', ?, 'PENDING', ?, ?)`,
        args: [
          randomUUID(), fixture.publicationId, fixture.assetId, fixture.customerId,
          NOW.toISOString(), NOW.toISOString(), NOW.toISOString(),
        ],
      }));
      assert.equal((await client.execute(
        "SELECT status FROM assets WHERE id = ?",
        [fixture.assetId],
      )).rows[0]?.status, "DELETED");
      assert.equal(await storage.storage.get(fixture.sourceKey), null);
    } finally {
      client.close();
    }
  });

  it("blocks deletion while payment or fulfillment is in progress", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        expiresAt: "2100-01-01T00:00:00.000Z",
        extraOrderStatus: "AWAITING_PAYMENT",
      });
      assert.ok(fixture.extraOrderId);
      await client.execute(
        "UPDATE orders SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
        [fixture.extraOrderId],
      );
      const session = await createSession(client, fixture.customerId);
      const harness = deletionContext(adapter, createStorage({ derivative: 0, source: 0 }), session);
      const response = await harness.deleteDesign(fixture.designId);
      assert.equal(response.status, 409);
      const state = await client.execute(
        "SELECT status FROM designs WHERE id = ?",
        [fixture.designId],
      );
      assert.equal(state.rows[0]?.status, "DRAFT");

      await client.execute({
        sql: `INSERT INTO fulfillment_jobs (
                id, order_id, status, attempts, created_at, updated_at
              ) VALUES (?, ?, 'PROCESSING', 1, ?, ?)`,
        args: [randomUUID(), fixture.orderId, NOW.toISOString(), NOW.toISOString()],
      });
      const fulfillmentRace = await harness.deleteDesign(fixture.designId);
      assert.equal(fulfillmentRace.status, 409);
      const unchanged = await client.execute(
        "SELECT status FROM designs WHERE id = ?",
        [fixture.designId],
      );
      assert.equal(unchanged.rows[0]?.status, "DRAFT");
    } finally {
      client.close();
    }
  });

  it("preserves settled fulfillment when payment races with design deletion", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const database = new PausableDatabase(adapter);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createDraftFixture(client);
      const order = await createOrderSnapshot(client, fixture, { paid: false });
      const session = await createSession(client, fixture.customerId);
      const harness = deletionContext(database, storage.storage, session);
      const gate = database.pauseNextBatch();
      const deletion = harness.deleteDesign(fixture.designId);
      await gate.entered;

      const secret = "local-webhook-test-secret";
      const timestamp = String(Math.floor(Date.now() / 1000));
      const payload = JSON.stringify({
        id: order.transactionId,
        accountNumber: "1234567890",
        code: order.paymentReference,
        transferType: "in",
        transferAmount: 1000,
      });
      const signature = createHmac("sha256", secret)
        .update(`${timestamp}.${payload}`)
        .digest("hex");
      const paymentEnv = {
        ...harness.env,
        PAYMENT_MODE: "mock",
        SEPAY_WEBHOOK_SECRET: secret,
        SEPAY_BANK_ACCOUNT: "1234567890",
      } as Parameters<typeof handleApiRequest>[1];
      const webhook = await handleApiRequest(
        new Request("https://crushify.test/api/v1/payments/sepay/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-SePay-Timestamp": timestamp,
            "X-SePay-Signature": `sha256=${signature}`,
          },
          body: payload,
        }),
        paymentEnv,
      );
      assert.equal(webhook.status, 200);
      gate.release();
      assert.notEqual((await deletion).status, 409);

      const duplicateWebhook = await handleApiRequest(
        new Request("https://crushify.test/api/v1/payments/sepay/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-SePay-Timestamp": timestamp,
            "X-SePay-Signature": `sha256=${signature}`,
          },
          body: payload,
        }),
        paymentEnv,
      );
      assert.equal(duplicateWebhook.status, 200);
      const state = await client.execute({
        sql: `SELECT o.status AS order_status, f.status AS fulfillment_status,
                p.status AS publication_status, s.data_json, s.content_sha256
              FROM orders o JOIN fulfillment_jobs f ON f.order_id = o.id
              JOIN publications p ON p.order_id = o.id
              JOIN order_design_snapshots s ON s.order_id = o.id
              WHERE o.id = ?`,
        args: [order.orderId],
      });
      assert.equal(state.rows.length, 1);
      assert.equal(state.rows[0]?.order_status, "FULFILLED");
      assert.equal(state.rows[0]?.fulfillment_status, "COMPLETED");
      assert.equal(state.rows[0]?.publication_status, "UNPUBLISHED");
      assert.equal(state.rows[0]?.data_json, order.dataJson);
      assert.equal(
        state.rows[0]?.content_sha256,
        createHash("sha256").update(order.dataJson).digest("hex"),
      );
    } finally {
      client.close();
    }
  });

  it("blocks deletion during paid fulfillment and fulfills the immutable snapshot", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createDraftFixture(client, true);
      const session = await createSession(client, fixture.customerId);
      const env = deletionContext(adapter, storage.storage, session).env;
      assert.equal((await saveDesignWithAsset(
        env, session, client, fixture.designId, fixture.assetId,
      )).status, 200);
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      const order = await createOrderSnapshot(client, fixture, {
        paid: true,
        assetId: fixture.assetId,
      });
      const harness = deletionContext(adapter, storage.storage, session);

      assert.equal((await harness.deleteDesign(fixture.designId)).status, 409);
      assert.ok(await storage.storage.get(fixture.sourceKey));
      const result = await handleFulfillmentForOrder({
        ...env,
        PAYMENT_MODE: "mock",
      } as Parameters<typeof handleFulfillmentForOrder>[0], order.orderId, NOW);
      assert.equal(result.completed, true);

      const published = await client.execute({
        sql: `SELECT o.status AS order_status, p.status AS publication_status,
                s.data_json, pa.asset_id, a.status AS asset_status
              FROM orders o JOIN publications p ON p.order_id = o.id
              JOIN order_design_snapshots s ON s.order_id = o.id
              JOIN publication_assets pa ON pa.publication_id = p.id
              JOIN assets a ON a.id = pa.asset_id
              WHERE o.id = ?`,
        args: [order.orderId],
      });
      assert.equal(published.rows[0]?.order_status, "FULFILLED");
      assert.equal(published.rows[0]?.publication_status, "PUBLISHED");
      assert.equal(published.rows[0]?.data_json, order.dataJson);
      assert.equal(published.rows[0]?.asset_id, fixture.assetId);
      assert.equal(published.rows[0]?.asset_status, "READY");
      assert.ok(await storage.storage.get(fixture.sourceKey));
    } finally {
      client.close();
    }
  });

  it("serializes design deletion against an in-flight fulfillment claim", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const gate = deferred();
    const entered = deferred();
    const storage = createRaceStorage({
      beforeDerivative: async () => {
        entered.resolve();
        await gate.promise;
      },
    });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createDraftFixture(client, true);
      const session = await createSession(client, fixture.customerId);
      const env = deletionContext(adapter, storage.storage, session).env;
      assert.equal((await saveDesignWithAsset(
        env, session, client, fixture.designId, fixture.assetId,
      )).status, 200);
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      const order = await createOrderSnapshot(client, fixture, {
        paid: true,
        assetId: fixture.assetId,
      });
      const fulfillment = handleFulfillmentForOrder(
        { ...env, PAYMENT_MODE: "mock" } as Parameters<typeof handleFulfillmentForOrder>[0],
        order.orderId,
        NOW,
      );
      await entered.promise;

      assert.equal((await deletionContext(adapter, storage.storage, session)
        .deleteDesign(fixture.designId)).status, 409);
      gate.resolve();
      assert.equal((await fulfillment).completed, true);
      assert.ok(await storage.storage.get(fixture.sourceKey));
    } finally {
      gate.resolve();
      client.close();
    }
  });

  it("retains paid content through failure, deletion request, retry, and post-fulfillment deletion", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createDraftFixture(client);
      const order = await createOrderSnapshot(client, fixture, { paid: true });
      const session = await createSession(client, fixture.customerId);
      const harness = deletionContext(adapter, storage.storage, session);
      const env = { ...harness.env, PAYMENT_MODE: "mock" } as Parameters<
        typeof handleFulfillmentForOrder
      >[1];
      await client.execute(`CREATE TRIGGER fail_first_publication
        BEFORE INSERT ON publications
        BEGIN SELECT RAISE(ABORT, 'controlled fulfillment failure'); END`);

      const failed = await handleFulfillmentForOrder(env, order.orderId, NOW);
      assert.equal(failed.completed, false);
      assert.equal(failed.retryable, true);
      assert.equal((await harness.deleteDesign(fixture.designId)).status, 409);
      await client.execute("DROP TRIGGER fail_first_publication");
      await client.execute(
        "UPDATE fulfillment_jobs SET next_attempt_at = ? WHERE order_id = ?",
        [NOW.toISOString(), order.orderId],
      );

      const retried = await handleFulfillmentForOrder(env, order.orderId, NOW);
      assert.equal(retried.completed, true);
      const beforeDeletion = await client.execute(
        "SELECT data_json FROM order_design_snapshots WHERE order_id = ?",
        [order.orderId],
      );
      assert.equal(beforeDeletion.rows[0]?.data_json, order.dataJson);
      assert.notEqual((await harness.deleteDesign(fixture.designId)).status, 409);

      const afterDeletion = await client.execute({
        sql: `SELECT o.status AS order_status, s.data_json, p.status AS publication_status
              FROM orders o JOIN order_design_snapshots s ON s.order_id = o.id
              JOIN publications p ON p.order_id = o.id WHERE o.id = ?`,
        args: [order.orderId],
      });
      assert.equal(afterDeletion.rows[0]?.order_status, "FULFILLED");
      assert.equal(afterDeletion.rows[0]?.data_json, order.dataJson);
      assert.ok(["PUBLISHED", "UNPUBLISHED", "REVOKED"].includes(
        String(afterDeletion.rows[0]?.publication_status),
      ));
    } finally {
      client.close();
    }
  });

  it("retains paid snapshot assets when deleting a revoked published design", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        status: "REVOKED",
        expiresAt: "2100-01-01T00:00:00.000Z",
        withAsset: true,
      });
      if (!("sourceKey" in fixture) || !("derivativeKey" in fixture)) {
        assert.fail("Expected paid publication asset fixture");
      }
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      await storage.storage.createPublishedDerivative(fixture.sourceKey, fixture.derivativeKey);
      await client.execute({
        sql: `INSERT INTO order_asset_refs (order_id, asset_id, created_at) VALUES (?, ?, ?)`,
        args: [fixture.orderId, fixture.assetId, NOW.toISOString()],
      });
      const session = await createSession(client, fixture.customerId);
      const response = await deletionContext(adapter, storage.storage, session)
        .deleteDesign(fixture.designId);

      assert.equal(response.status, 202);
      const protectedState = await client.execute({
        sql: `SELECT d.status AS design_status, a.status AS asset_status,
                o.status AS order_status, p.status AS publication_status
              FROM designs d JOIN assets a ON a.design_id = d.id
              JOIN orders o ON o.design_id = d.id
              JOIN publications p ON p.design_id = d.id
              WHERE d.id = ?`,
        args: [fixture.designId],
      });
      assert.deepEqual(protectedState.rows[0], {
        design_status: "DELETION_PENDING",
        asset_status: "READY",
        order_status: "FULFILLED",
        publication_status: "REVOKED",
      });
      assert.ok(await storage.storage.get(fixture.sourceKey));
    } finally {
      client.close();
    }
  });

  it("does not begin design deletion while an order is pending payment", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createFixture(client, {
        expiresAt: "2100-01-01T00:00:00.000Z",
        extraOrderStatus: "AWAITING_PAYMENT",
      });
      const session = await createSession(client, fixture.customerId);
      const response = await handleApiRequest(
        new Request(`https://crushify.test/api/v1/designs/${fixture.designId}`, {
          method: "DELETE",
          headers: {
            Cookie: `crushify_session=${session.token}; crushify_csrf=${session.csrf}`,
            Origin: "https://crushify.test",
            "X-CSRF-Token": session.csrf,
          },
        }),
        {
          DB: adapter,
          STORAGE: createStorage({ derivative: 0, source: 0 }),
          APP_ORIGIN: "https://crushify.test",
          ENVIRONMENT: "local",
          LOCAL_TEST_MODE: "true",
        } as Parameters<typeof handleApiRequest>[1],
      );
      assert.equal(response.status, 409);
      const state = await client.execute({
        sql: `SELECT d.status AS design_status, p.status AS publication_status
              FROM designs d JOIN publications p ON p.design_id = d.id WHERE d.id = ?`,
        args: [fixture.designId],
      });
      assert.deepEqual(state.rows[0], {
        design_status: "DRAFT",
        publication_status: "PUBLISHED",
      });
    } finally {
      client.close();
    }
  });

  it("expires soft-unpublished hosting at its persisted boundary and preserves lifetime hosting", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createStorage({ derivative: 0, source: 0 });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const finite = await createFixture(client, { expiresAt: NOW.toISOString() });
      const lifetime = await createFixture(client, { expiresAt: null, lifetime: true });
      const finiteSession = await createSession(client, finite.customerId);
      const lifetimeSession = await createSession(client, lifetime.customerId);
      const finiteDelete = deletionContext(adapter, storage, finiteSession);
      const lifetimeDelete = deletionContext(adapter, storage, lifetimeSession);
      assert.equal((await finiteDelete.deleteDesign(finite.designId)).status, 202);
      assert.equal((await lifetimeDelete.deleteDesign(lifetime.designId)).status, 202);

      const lifecycle = await runPublicationLifecycle({
        DB: adapter,
        STORAGE: storage,
        DATA_RETENTION_DAYS: "30",
      } as Parameters<typeof runPublicationLifecycle>[0], { now: NOW });
      assert.equal(lifecycle.expired, 1);
      const rows = await client.execute({
        sql: `SELECT p.design_id, p.status AS publication_status, p.expires_at,
                     e.status AS entitlement_status
              FROM publications p
              JOIN storage_entitlements e ON e.publication_id = p.id
              WHERE p.id IN (?, ?) ORDER BY p.design_id`,
        args: [finite.publicationId, lifetime.publicationId],
      });
      const finiteRow = rows.rows.find((row) => row.design_id === finite.designId);
      const lifetimeRow = rows.rows.find((row) => row.design_id === lifetime.designId);
      assert.deepEqual(finiteRow, {
        design_id: finite.designId,
        publication_status: "EXPIRED",
        expires_at: NOW.toISOString(),
        entitlement_status: "EXPIRED",
      });
      assert.deepEqual(lifetimeRow, {
        design_id: lifetime.designId,
        publication_status: "UNPUBLISHED",
        expires_at: null,
        entitlement_status: "LIFETIME",
      });
    } finally {
      client.close();
    }
  });

});

describe("checkout revision snapshot integrity", () => {
  it("creates an immutable checkout snapshot and pins every referenced asset", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createDraftFixture(client, true);
      const now = NOW.toISOString();
      await client.batch([
        {
          sql: `INSERT INTO template_prices (
            id, template_id, schema_version, currency, amount_minor, is_active, created_at, updated_at
          ) VALUES (?, 'our-universe', 1, 'VND', 1000, 1, ?, ?)`,
          args: [randomUUID(), now, now],
        },
        {
          sql: `INSERT INTO storage_plan_prices (
            id, storage_plan_id, currency, amount_minor, is_active, created_at, updated_at
          ) VALUES (?, '1-month', 'VND', 1000, 1, ?, ?)`,
          args: [randomUUID(), now, now],
        },
      ]);
      const session = await createSession(client, fixture.customerId);
      const env = {
        DB: adapter,
        STORAGE: storage.storage,
        ENVIRONMENT: "local",
        LOCAL_TEST_MODE: "true",
        LOCAL_TEST_CATALOG_OVERRIDE: "true",
        LOCAL_TEST_PRICING_POLICY: "true",
        PAYMENT_MODE: "mock",
        APP_ORIGIN: "https://crushify.test",
      } as Parameters<typeof handleApiRequest>[1];
      assert.equal((await saveDesignWithAsset(
        env, session, client, fixture.designId, fixture.assetId,
      )).status, 200);
      const checkout = await assetRequest(env, session, "/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({
          design_id: fixture.designId,
          storage_plan_id: "1-month",
          asset_consents: [],
        }),
      });
      assert.equal(checkout.status, 201, await checkout.clone().text());
      const order = await checkout.json() as { order_id: string; design_revision: number };
      assert.equal(order.design_revision, 2);

      const snapshot = await client.execute(
        `SELECT snapshot.design_revision, snapshot.data_json, snapshot.content_sha256,
           (SELECT COUNT(*) FROM order_asset_refs ref WHERE ref.order_id = snapshot.order_id) AS asset_pins
         FROM order_design_snapshots snapshot WHERE snapshot.order_id = ?`,
        [order.order_id],
      );
      assert.equal(snapshot.rows[0]?.design_revision, 2);
      assert.equal(snapshot.rows[0]?.asset_pins, 1);
      assert.equal(
        createHash("sha256").update(String(snapshot.rows[0]?.data_json)).digest("hex"),
        snapshot.rows[0]?.content_sha256,
      );

      const current = await client.execute(
        "SELECT data_json FROM designs WHERE id = ?",
        [fixture.designId],
      );
      const currentData = JSON.parse(String(current.rows[0]?.data_json)) as Record<string, unknown>;
      currentData.photos = [];
      const edited = await assetRequest(env, session, `/designs/${fixture.designId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schema_version: 1, expected_revision: 2, data: currentData }),
      });
      assert.equal(edited.status, 200);
      const deletion = await assetRequest(
        env, session, `/assets/${fixture.assetId}`, { method: "DELETE" },
      );
      assert.equal(deletion.status, 409);

      const immutable = await client.execute(
        "SELECT data_json FROM order_design_snapshots WHERE order_id = ?",
        [order.order_id],
      );
      assert.ok(JSON.parse(String(immutable.rows[0]?.data_json)).photos.some(
        (photo: { asset_id: string }) => photo.asset_id === fixture.assetId,
      ));
      await assert.rejects(client.execute(
        "UPDATE order_design_snapshots SET data_json = '{}' WHERE order_id = ?",
        [order.order_id],
      ));
    } finally {
      client.close();
    }
  });

  it("fulfills the checked-out revision after a pending-order edit and recovers idempotently", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createDraftFixture(client);
      const orderId = randomUUID();
      const paymentId = randomUUID();
      const providerPaymentId = randomUUID();
      const now = NOW.toISOString();
      const original = await client.execute(
        "SELECT data_json FROM designs WHERE id = ?",
        [fixture.designId],
      );
      const originalData = String(original.rows[0]?.data_json);
      const snapshotHash = createHash("sha256").update(originalData).digest("hex");
      await client.batch([
        {
          sql: `INSERT INTO orders (
            id, customer_id, order_type, status, currency, subtotal_minor,
            discount_minor, total_minor, design_id, idempotency_key,
            created_at, updated_at, expires_at, order_reference, design_revision,
            request_hash, payment_review_required
          ) VALUES (?, ?, 'SELF_SERVICE', 'AWAITING_PAYMENT', 'VND', 1000, 0,
            1000, ?, ?, ?, ?, '2100-01-01T00:00:00.000Z', ?, 1, ?, 0)`,
          args: [orderId, fixture.customerId, fixture.designId, randomUUID(), now, now,
            `CRF${randomUUID().replaceAll("-", "").slice(0, 16)}`, "a".repeat(64)],
        },
        {
          sql: `INSERT INTO order_items (
            id, order_id, item_type, reference_id, description_snapshot, quantity,
            unit_amount_minor, line_total_minor, metadata_json, created_at
          ) VALUES (?, ?, 'TEMPLATE_LICENSE', 'our-universe', 'Our Universe', 1,
            1000, 1000, ?, ?)`,
          args: [randomUUID(), orderId, '{"schema_version":1}', now],
        },
        {
          sql: `INSERT INTO order_items (
            id, order_id, item_type, reference_id, description_snapshot, quantity,
            unit_amount_minor, line_total_minor, metadata_json, created_at
          ) VALUES (?, ?, 'ADD_ON', '1-month', '1 month', 1, 0, 0, ?, ?)`,
          args: [randomUUID(), orderId, JSON.stringify({
            kind: "STORAGE_PLAN",
            storage_plan_id: "1-month",
            title: "1 month",
            duration_months: 1,
            lifetime: false,
            pricing_snapshot: { total_minor: 1000 },
            asset_consents: [],
          }), now],
        },
        {
          sql: `INSERT INTO payments (
            id, order_id, provider, status, amount_minor, currency,
            idempotency_key, created_at, updated_at, payment_reference, review_required
          ) VALUES (?, ?, 'SEPAY', 'PENDING', 1000, 'VND', ?, ?, ?, ?, 0)`,
          args: [paymentId, orderId, `order:${orderId}`, now, now, `CRP${randomUUID()}`],
        },
        {
          sql: `INSERT INTO order_design_snapshots (
            order_id, design_id, design_revision, template_id, schema_version,
            data_json, content_sha256, created_at
          ) VALUES (?, ?, 1, 'our-universe', 1, ?, ?, ?)`,
          args: [orderId, fixture.designId, originalData, snapshotHash, now],
        },
        {
          sql: `INSERT INTO fulfillment_jobs (
            id, order_id, status, attempts, created_at, updated_at
          ) VALUES (?, ?, 'PENDING', 0, ?, ?)`,
          args: [randomUUID(), orderId, now, now],
        },
      ]);

      const editedData = JSON.parse(originalData) as Record<string, unknown>;
      editedData.headline = "Edited while checkout was pending";
      const editedJson = JSON.stringify(editedData);
      await client.batch([
        {
          sql: `UPDATE designs SET data_json = ?, revision = 2, updated_at = ?
                WHERE id = ? AND revision = 1 AND status = 'DRAFT'`,
          args: [editedJson, now, fixture.designId],
        },
        {
          sql: `INSERT INTO design_revisions (design_id, revision, data_json, created_at)
                VALUES (?, 2, ?, ?)`,
          args: [fixture.designId, editedJson, now],
        },
      ]);

      await client.batch([
        {
          sql: `UPDATE orders SET status = 'PAID', paid_at = ?, updated_at = ? WHERE id = ?`,
          args: [now, now, orderId],
        },
        {
          sql: `UPDATE payments SET status = 'SUCCEEDED', provider_payment_id = ?,
                  succeeded_at = ?, updated_at = ? WHERE id = ?`,
          args: [providerPaymentId, now, now, paymentId],
        },
        {
          sql: `INSERT INTO payment_webhook_events (
            id, provider, event_id, payload_hash, received_at, processed_at,
            outcome, raw_payload, provider_transaction_id, actual_amount_minor
          ) VALUES (?, 'SEPAY', ?, ?, ?, ?, 'PROCESSED', '{}', ?, 1000)`,
          args: [randomUUID(), providerPaymentId, "b".repeat(64), now, now, providerPaymentId],
        },
        {
          sql: `INSERT INTO payment_settlement_evidence (
            id, payment_id, provider, evidence_source, source_transaction_id,
            amount_minor, currency, verified_at, payload_hash, status, created_at
          ) VALUES (?, ?, 'SEPAY', 'SEPAY_WEBHOOK', ?, 1000, 'VND', ?, ?, 'VERIFIED', ?)`,
          args: [randomUUID(), paymentId, providerPaymentId, now, "b".repeat(64), now],
        },
      ]);

      const session = await createSession(client, fixture.customerId);
      const env = {
        DB: adapter,
        STORAGE: storage.storage,
        ENVIRONMENT: "local",
        LOCAL_TEST_MODE: "true",
        PAYMENT_MODE: "mock",
        APP_ORIGIN: "https://crushify.test",
      } as Parameters<typeof handleApiRequest>[1];
      await client.execute(
        `CREATE TRIGGER fail_snapshot_entitlement_once
         BEFORE INSERT ON storage_entitlements
         WHEN NEW.order_id = '${orderId}'
         BEGIN SELECT RAISE(ABORT, 'controlled first-fulfillment failure'); END`,
      );
      const firstAttempt = await handleFulfillmentForOrder(env, orderId, NOW);
      assert.equal(firstAttempt.completed, false);
      assert.equal(firstAttempt.retryable, true);

      const lateEdit = { ...editedData, headline: "Edit after payment" };
      const lateEditResponse = await assetRequest(env, session, `/designs/${fixture.designId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schema_version: 1, expected_revision: 2, data: lateEdit }),
      });
      assert.equal(lateEditResponse.status, 200);

      await client.execute("DROP TRIGGER fail_snapshot_entitlement_once");
      const retryAt = await client.execute(
        "SELECT next_attempt_at FROM fulfillment_jobs WHERE order_id = ?",
        [orderId],
      );
      const retryTime = new Date(String(retryAt.rows[0]?.next_attempt_at));
      retryTime.setTime(retryTime.getTime() + 1);
      const retry = await handleFulfillmentForOrder(env, orderId, retryTime);
      assert.deepEqual(retry, { completed: true, retryable: false });

      const result = await client.execute({
        sql:         `SELECT o.status AS order_status, d.revision AS current_revision, d.data_json,
                snapshot.design_revision, p.published_revision, p.snapshot_json
              FROM orders o
              JOIN designs d ON d.id = o.design_id
              JOIN order_design_snapshots snapshot ON snapshot.order_id = o.id
              JOIN publications p ON p.order_id = o.id
              WHERE o.id = ?`,
        args: [orderId],
      });
      const row = result.rows[0]!;
      assert.equal(row.order_status, "FULFILLED");
      assert.equal(row.current_revision, 3);
      assert.equal(row.design_revision, 1);
      assert.equal(row.published_revision, 1);
      assert.equal(
        (JSON.parse(String(row.data_json)) as { headline: string }).headline,
        "Edit after payment",
      );
      assert.equal(
        (JSON.parse(String(row.snapshot_json)) as { data: { headline: string } }).data.headline,
        (JSON.parse(originalData) as { headline: string }).headline,
      );
    } finally {
      client.close();
    }
  });
});

describe("upload and design deletion concurrency", () => {
  it("serializes design reference creation before asset deletion", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const database = new PausableDatabase(adapter);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createDraftFixture(client, true);
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      const session = await createSession(client, fixture.customerId);
      const harness = deletionContext(database, storage.storage, session);
      const deletionGate = database.pauseNextBatch();
      const deletion = assetRequest(
        harness.env, session, `/assets/${fixture.assetId}`, { method: "DELETE" },
      );
      await deletionGate.entered;

      const saved = await saveDesignWithAsset(
        harness.env, session, client, fixture.designId, fixture.assetId,
      );
      assert.equal(saved.status, 200);
      deletionGate.release();

      assert.equal((await deletion).status, 409);
      const state = await client.execute({
        sql: `SELECT a.status, COUNT(ref.asset_id) AS references_count
              FROM assets a LEFT JOIN design_asset_refs ref ON ref.asset_id = a.id
              WHERE a.id = ? GROUP BY a.id`,
        args: [fixture.assetId],
      });
      assert.deepEqual(state.rows[0], { status: "READY", references_count: 1 });
      assert.equal(storage.objects.size, 1);
    } finally {
      client.close();
    }
  });

  it("refuses a design reference when asset deletion wins the serialization race", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const database = new PausableDatabase(adapter);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createDraftFixture(client, true);
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      const session = await createSession(client, fixture.customerId);
      const harness = deletionContext(database, storage.storage, session);
      const saveGate = database.pauseNextBatch();
      const save = saveDesignWithAsset(
        harness.env, session, client, fixture.designId, fixture.assetId,
      );
      await saveGate.entered;

      const deleted = await assetRequest(
        harness.env, session, `/assets/${fixture.assetId}`, { method: "DELETE" },
      );
      assert.equal(deleted.status, 200);
      saveGate.release();

      assert.equal((await save).status, 409);
      const state = await client.execute({
        sql: `SELECT a.status, d.data_json,
                (SELECT COUNT(*) FROM design_asset_refs ref WHERE ref.asset_id = a.id) AS references_count
              FROM assets a JOIN designs d ON d.id = a.design_id WHERE a.id = ?`,
        args: [fixture.assetId],
      });
      assert.equal(state.rows[0]?.status, "DELETED");
      assert.equal(state.rows[0]?.references_count, 0);
      assert.equal(JSON.parse(String(state.rows[0]?.data_json)).photos.length, 0);
      assert.equal(storage.objects.size, 0);
    } finally {
      client.close();
    }
  });

  it("reproduces upload initiation racing after deletion and refuses the archived design", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const database = new PausableDatabase(adapter);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createDraftFixture(client);
      const session = await createSession(client, fixture.customerId);
      const harness = deletionContext(database, storage.storage, session);
      const gate = database.pauseNextBatch();
      const grantPromise = createUploadGrant(harness.env, session, fixture.designId);

      await gate.entered;
      const deleted = await harness.deleteDesign(fixture.designId);
      assert.equal(deleted.status, 200);
      gate.release();

      const grant = await grantPromise;
      assert.equal(grant.response.status, 409);
      assert.match((grant.body as unknown as { error: { message: string } }).error.message,
        /no longer available/);
      const state = await client.execute({
        sql: `SELECT d.status AS design_status, COUNT(a.id) AS assets
              FROM designs d LEFT JOIN assets a ON a.design_id = d.id
              WHERE d.id = ? GROUP BY d.id`,
        args: [fixture.designId],
      });
      assert.deepEqual(state.rows[0], { design_status: "ARCHIVED", assets: 0 });

      const archivedGrant = await createUploadGrant(harness.env, session, fixture.designId);
      assert.equal(archivedGrant.response.status, 404);
      assert.equal((await client.execute(
        "SELECT COUNT(*) AS count FROM assets WHERE design_id = ?",
        [fixture.designId],
      )).rows[0]?.count, 0);
    } finally {
      client.close();
    }
  });

  it("lets a claimed upload finish before deletion and then cleans it up", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const uploadStarted = deferred();
    const releaseUpload = deferred();
    const storage = createRaceStorage({
      beforeUpload: async () => {
        uploadStarted.resolve();
        await releaseUpload.promise;
      },
    });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createDraftFixture(client);
      const session = await createSession(client, fixture.customerId);
      const harness = deletionContext(adapter, storage.storage, session);
      const grant = await createUploadGrant(harness.env, session, fixture.designId);
      assert.equal(grant.response.status, 201);

      const uploading = assetRequest(harness.env, session, grant.body.upload_url.replace("/api/v1", ""), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${grant.body.upload_token}`,
          "Content-Type": "image/png",
        },
        body: new Blob([UPLOAD_PNG], { type: "image/png" }),
      });
      const uploadState = await Promise.race([
        uploadStarted.promise.then(() => "started" as const),
        uploading.then(async (response) => `finished:${response.status}:${await response.text()}`),
      ]);
      assert.equal(uploadState, "started");

      const blockedDelete = await harness.deleteDesign(fixture.designId);
      assert.equal(blockedDelete.status, 409);
      assert.equal((await client.execute(
        "SELECT status FROM designs WHERE id = ?",
        [fixture.designId],
      )).rows[0]?.status, "DRAFT");
      assert.equal((await client.execute(
        "SELECT status FROM asset_upload_sessions WHERE asset_id = ?",
        [grant.body.asset_id],
      )).rows[0]?.status, "UPLOADING");

      releaseUpload.resolve();
      assert.equal((await uploading).status, 204);
      const completed = await assetRequest(
        harness.env, session, `/assets/${grant.body.asset_id}/complete`, { method: "POST" },
      );
      assert.equal(completed.status, 200);

      const deleted = await harness.deleteDesign(fixture.designId);
      assert.equal(deleted.status, 200);
      const finalState = await client.execute({
        sql: `SELECT d.status AS design_status, a.status AS asset_status
              FROM designs d JOIN assets a ON a.design_id = d.id WHERE d.id = ?`,
        args: [fixture.designId],
      });
      assert.deepEqual(finalState.rows[0], {
        design_status: "ARCHIVED",
        asset_status: "DELETED",
      });
      assert.equal(storage.objects.size, 0);
    } finally {
      releaseUpload.resolve();
      client.close();
    }
  });

  it("prevents a paused completion from committing after deletion wins", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const objectRead = deferred();
    const releaseObjectRead = deferred();
    const storage = createRaceStorage({
      afterGet: async () => {
        objectRead.resolve();
        await releaseObjectRead.promise;
      },
    });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createDraftFixture(client);
      const session = await createSession(client, fixture.customerId);
      const harness = deletionContext(adapter, storage.storage, session);
      const grant = await createUploadGrant(harness.env, session, fixture.designId);
      assert.equal(grant.response.status, 201);
      const uploaded = await assetRequest(harness.env, session, grant.body.upload_url.replace("/api/v1", ""), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${grant.body.upload_token}`,
          "Content-Type": "image/png",
        },
        body: new Blob([UPLOAD_PNG], { type: "image/png" }),
      });
      assert.equal(uploaded.status, 204);

      const completion = assetRequest(
        harness.env, session, `/assets/${grant.body.asset_id}/complete`, { method: "POST" },
      );
      await objectRead.promise;
      const deleted = await harness.deleteDesign(fixture.designId);
      assert.equal(deleted.status, 200);
      releaseObjectRead.resolve();

      const completionResponse = await completion;
      assert.equal(completionResponse.status, 409);
      const state = await client.execute({
        sql: `SELECT d.status AS design_status, a.status AS asset_status
              FROM designs d JOIN assets a ON a.design_id = d.id WHERE d.id = ?`,
        args: [fixture.designId],
      });
      assert.deepEqual(state.rows[0], {
        design_status: "ARCHIVED",
        asset_status: "DELETED",
      });
      assert.equal(storage.objects.size, 0);
    } finally {
      releaseObjectRead.resolve();
      client.close();
    }
  });

  it("reconciles late provider success after an expired upload lease and design deletion", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const uploadStarted = deferred();
    const releaseUpload = deferred();
    const storage = createRaceStorage({
      beforeUpload: async () => {
        uploadStarted.resolve();
        await releaseUpload.promise;
      },
    });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createDraftFixture(client);
      const session = await createSession(client, fixture.customerId);
      const harness = deletionContext(adapter, storage.storage, session);
      const grant = await createUploadGrant(harness.env, session, fixture.designId);
      assert.equal(grant.response.status, 201);
      const upload = assetRequest(
        harness.env,
        session,
        grant.body.upload_url.replace("/api/v1", ""),
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${grant.body.upload_token}`,
            "Content-Type": "image/png",
          },
          body: new Blob([UPLOAD_PNG], { type: "image/png" }),
        },
      );
      await uploadStarted.promise;
      const attempt = await client.execute(
        "SELECT object_key FROM asset_upload_attempts WHERE asset_id = ? AND status = 'UPLOADING'",
        [grant.body.asset_id],
      );
      const objectKey = String(attempt.rows[0]?.object_key);
      await client.execute(
        `UPDATE asset_upload_sessions
         SET status = 'UPLOADING', used_at = ?, lease_expires_at = '2000-01-01T00:00:00.000Z'
         WHERE asset_id = ?`,
        [NOW.toISOString(), grant.body.asset_id],
      );
      await client.execute(
        `UPDATE asset_upload_attempts
         SET lease_expires_at = '2000-01-01T00:00:00.000Z'
         WHERE asset_id = ? AND status = 'UPLOADING'`,
        [grant.body.asset_id],
      );

      const deleted = await harness.deleteDesign(fixture.designId);
      assert.equal(deleted.status, 200);
      releaseUpload.resolve();
      assert.equal((await upload).status, 503);
      assert.equal(storage.objects.size, 1);
      const state = await client.execute({
        sql: `SELECT d.status AS design_status, a.status AS asset_status, u.status AS upload_status
              FROM designs d JOIN assets a ON a.design_id = d.id
              JOIN asset_upload_sessions u ON u.asset_id = a.id WHERE d.id = ?`,
        args: [fixture.designId],
      });
      assert.deepEqual(state.rows[0], {
        design_status: "ARCHIVED",
        asset_status: "DELETED",
        upload_status: "CANCELLED",
      });
      const reconciled = await reconcileUploadAttemptCleanup(harness.env, {
        now: new Date(Date.now() + 2 * 60 * 60_000),
      });
      assert.equal(reconciled.cleaned, 1);
      assert.equal(storage.objects.size, 0);
    } finally {
      releaseUpload.resolve();
      client.close();
    }
  });

  it("allows concurrent uploads to one draft to finalize once each", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createDraftFixture(client);
      const session = await createSession(client, fixture.customerId);
      const harness = deletionContext(adapter, storage.storage, session);
      const grants = await Promise.all([
        createUploadGrant(harness.env, session, fixture.designId),
        createUploadGrant(harness.env, session, fixture.designId),
      ]);
      assert.ok(grants.every((grant) => grant.response.status === 201));
      const uploads = await Promise.all(grants.map((grant) => assetRequest(
        harness.env, session, grant.body.upload_url.replace("/api/v1", ""), {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${grant.body.upload_token}`,
            "Content-Type": "image/png",
          },
          body: new Blob([UPLOAD_PNG], { type: "image/png" }),
        },
      )));
      assert.ok(uploads.every((response) => response.status === 204));
      const completions = await Promise.all(grants.map((grant) => assetRequest(
        harness.env, session, `/assets/${grant.body.asset_id}/complete`, { method: "POST" },
      )));
      assert.ok(completions.every((response) => response.status === 200));
      assert.equal((await client.execute(
        "SELECT COUNT(*) AS count FROM assets WHERE design_id = ? AND status = 'READY'",
        [fixture.designId],
      )).rows[0]?.count, 2);
      assert.equal(storage.objects.size, 2);
    } finally {
      client.close();
    }
  });

  it("fences an expired upload worker and cleans only its unique stale object", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const uploadStarted = deferred();
    const releaseFirstUpload = deferred();
    let uploadCount = 0;
    const storage = createRaceStorage({
      beforeUpload: async () => {
        uploadCount++;
        if (uploadCount === 1) {
          uploadStarted.resolve();
          await releaseFirstUpload.promise;
        }
      },
    });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createDraftFixture(client);
      const session = await createSession(client, fixture.customerId);
      const harness = deletionContext(adapter, storage.storage, session);
      const grant = await createUploadGrant(harness.env, session, fixture.designId);
      const firstUpload = assetRequest(
        harness.env, session, grant.body.upload_url.replace("/api/v1", ""), {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${grant.body.upload_token}`,
            "Content-Type": "image/png",
          },
          body: new Blob([UPLOAD_PNG], { type: "image/png" }),
        },
      );
      await uploadStarted.promise;
      await client.execute(
        `UPDATE asset_upload_sessions
         SET lease_expires_at = '2000-01-01T00:00:00.000Z'
         WHERE asset_id = ?`,
        [grant.body.asset_id],
      );

      const takeover = await assetRequest(
        harness.env, session, grant.body.upload_url.replace("/api/v1", ""), {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${grant.body.upload_token}`,
            "Content-Type": "image/png",
          },
          body: new Blob([UPLOAD_PNG], { type: "image/png" }),
        },
      );
      assert.equal(takeover.status, 204);
      const completed = await assetRequest(
        harness.env, session, `/assets/${grant.body.asset_id}/complete`, { method: "POST" },
      );
      assert.equal(completed.status, 200);
      releaseFirstUpload.resolve();
      assert.equal((await firstUpload).status, 503);

      const current = await client.execute(
        "SELECT object_key FROM assets WHERE id = ? AND status = 'READY'",
        [grant.body.asset_id],
      );
      const currentKey = String(current.rows[0]?.object_key);
      const stale = await client.execute(
        `SELECT id, object_key, next_cleanup_at FROM asset_upload_attempts
         WHERE asset_id = ? AND status = 'CLEANUP_PENDING'`,
        [grant.body.asset_id],
      );
      assert.equal(stale.rows.length, 1);
      assert.notEqual(stale.rows[0]?.object_key, currentKey);
      assert.equal((await saveDesignWithAsset(
        harness.env, session, client, fixture.designId, grant.body.asset_id,
      )).status, 200);

      const cleanupAt = new Date(String(stale.rows[0]?.next_cleanup_at));
      cleanupAt.setTime(cleanupAt.getTime() + 1);
      const cleanup = await reconcileUploadAttemptCleanup(harness.env, { now: cleanupAt });
      assert.equal(cleanup.cleaned, 1);
      assert.deepEqual([...storage.objects.keys()], [currentKey]);
      const references = await client.execute(
        "SELECT COUNT(*) AS count FROM design_asset_refs WHERE asset_id = ?",
        [grant.body.asset_id],
      );
      assert.equal(references.rows[0]?.count, 1);
    } finally {
      releaseFirstUpload.resolve();
      client.close();
    }
  });

  it("cleans a stale worker result while a takeover upload is still in flight", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const secondStarted = deferred();
    const releaseSecond = deferred();
    let uploadCount = 0;
    const storage = createRaceStorage({
      beforeUpload: async () => {
        uploadCount++;
        if (uploadCount === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        } else if (uploadCount === 2) {
          secondStarted.resolve();
          await releaseSecond.promise;
        }
      },
    });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createDraftFixture(client);
      const session = await createSession(client, fixture.customerId);
      const harness = deletionContext(adapter, storage.storage, session);
      const grant = await createUploadGrant(harness.env, session, fixture.designId);
      const upload = () => assetRequest(
        harness.env, session, grant.body.upload_url.replace("/api/v1", ""), {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${grant.body.upload_token}`,
            "Content-Type": "image/png",
          },
          body: new Blob([UPLOAD_PNG], { type: "image/png" }),
        },
      );

      const firstUpload = upload();
      await firstStarted.promise;
      await client.execute(
        `UPDATE asset_upload_sessions
         SET lease_expires_at = '2000-01-01T00:00:00.000Z'
         WHERE asset_id = ?`,
        [grant.body.asset_id],
      );
      await client.execute(
        `UPDATE asset_upload_attempts
         SET lease_expires_at = '2000-01-01T00:00:00.000Z'
         WHERE asset_id = ? AND status = 'UPLOADING'`,
        [grant.body.asset_id],
      );

      const secondUpload = upload();
      await secondStarted.promise;
      releaseFirst.resolve();
      assert.equal((await firstUpload).status, 409);

      const attempts = await client.execute(
        `SELECT object_key, status FROM asset_upload_attempts
         WHERE asset_id = ? ORDER BY created_at, id`,
        [grant.body.asset_id],
      );
      assert.equal(attempts.rows.length, 2);
      const staleKey = String(attempts.rows.find((row) => row.status === "CLEANUP_PENDING")?.object_key);
      const currentAttemptKey = String(attempts.rows.find((row) => row.status === "UPLOADING")?.object_key);
      assert.notEqual(staleKey, currentAttemptKey);
      assert.equal(storage.objects.has(staleKey), true);
      assert.equal(storage.objects.has(currentAttemptKey), false);

      await client.execute(
        "UPDATE asset_upload_attempts SET next_cleanup_at = ? WHERE object_key = ?",
        [new Date().toISOString(), staleKey],
      );
      const cleanup = await reconcileUploadAttemptCleanup(harness.env, { now: new Date() });
      assert.equal(cleanup.cleaned, 1);
      assert.equal(storage.objects.has(staleKey), false);
      assert.equal(storage.objects.has(currentAttemptKey), false);

      releaseSecond.resolve();
      assert.equal((await secondUpload).status, 204);
      assert.equal((await assetRequest(
        harness.env, session, `/assets/${grant.body.asset_id}/complete`, { method: "POST" },
      )).status, 200);
      const asset = await client.execute(
        "SELECT status, object_key FROM assets WHERE id = ?",
        [grant.body.asset_id],
      );
      assert.deepEqual(asset.rows[0], { status: "READY", object_key: currentAttemptKey });
      assert.deepEqual([...storage.objects.keys()], [currentAttemptKey]);

      const repeated = await reconcileUploadAttemptCleanup(harness.env, { now: new Date() });
      assert.equal(repeated.processed, 0);
      assert.deepEqual([...storage.objects.keys()], [currentAttemptKey]);
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      client.close();
    }
  });

  it("reconciles an uncertain provider timeout without deleting a retried referenced asset", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    let uploadCount = 0;
    const storage = createRaceStorage({
      afterUpload: async () => {
        uploadCount++;
        if (uploadCount === 1) throw new Error("provider accepted upload but response timed out");
      },
    });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createDraftFixture(client);
      const session = await createSession(client, fixture.customerId);
      const harness = deletionContext(adapter, storage.storage, session);
      const grant = await createUploadGrant(harness.env, session, fixture.designId);
      const requestUpload = () => assetRequest(
        harness.env, session, grant.body.upload_url.replace("/api/v1", ""), {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${grant.body.upload_token}`,
            "Content-Type": "image/png",
          },
          body: new Blob([UPLOAD_PNG], { type: "image/png" }),
        },
      );
      assert.equal((await requestUpload()).status, 503);
      const uncertain = await client.execute(
        `SELECT object_key, next_cleanup_at, status FROM asset_upload_attempts
         WHERE asset_id = ?`,
        [grant.body.asset_id],
      );
      assert.equal(uncertain.rows[0]?.status, "CLEANUP_PENDING");
      assert.equal(storage.objects.size, 1);

      assert.equal((await requestUpload()).status, 204);
      assert.equal((await assetRequest(
        harness.env, session, `/assets/${grant.body.asset_id}/complete`, { method: "POST" },
      )).status, 200);
      assert.equal((await saveDesignWithAsset(
        harness.env, session, client, fixture.designId, grant.body.asset_id,
      )).status, 200);
      const current = await client.execute(
        "SELECT object_key FROM assets WHERE id = ? AND status = 'READY'",
        [grant.body.asset_id],
      );
      const currentKey = String(current.rows[0]?.object_key);

      const cleanupAt = new Date(String(uncertain.rows[0]?.next_cleanup_at));
      cleanupAt.setTime(cleanupAt.getTime() + 1);
      const cleanup = await reconcileUploadAttemptCleanup(harness.env, { now: cleanupAt });
      assert.equal(cleanup.cleaned, 1);
      assert.deepEqual([...storage.objects.keys()], [currentKey]);
      const state = await client.execute(
        `SELECT a.status, a.object_key,
           (SELECT COUNT(*) FROM design_asset_refs ref WHERE ref.asset_id = a.id) AS references_count
         FROM assets a WHERE a.id = ?`,
        [grant.body.asset_id],
      );
      assert.deepEqual(state.rows[0], {
        status: "READY",
        object_key: currentKey,
        references_count: 1,
      });
    } finally {
      client.close();
    }
  });

  it("retries cleanup when upload persistence and initial object deletion both fail", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage({ sourceDeleteFailures: 1 });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createDraftFixture(client);
      const session = await createSession(client, fixture.customerId);
      const harness = deletionContext(adapter, storage.storage, session);
      const grant = await createUploadGrant(harness.env, session, fixture.designId);
      assert.equal(grant.response.status, 201);
      await client.execute(
        `CREATE TRIGGER reject_upload_metadata
         BEFORE UPDATE OF sha256 ON assets
         WHEN NEW.status = 'QUARANTINED'
         BEGIN SELECT RAISE(ABORT, 'forced asset metadata failure'); END`,
      );
      const failedUpload = await assetRequest(harness.env, session, grant.body.upload_url.replace("/api/v1", ""), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${grant.body.upload_token}`,
          "Content-Type": "image/png",
        },
        body: new Blob([UPLOAD_PNG], { type: "image/png" }),
      });
      assert.equal(failedUpload.status, 503);
      const pending = await client.execute({
        sql: `SELECT a.status AS asset_status, u.status AS upload_status
              FROM assets a JOIN asset_upload_sessions u ON u.asset_id = a.id
              WHERE a.id = ?`,
        args: [grant.body.asset_id],
      });
      assert.deepEqual(pending.rows[0], {
        asset_status: "PENDING",
        upload_status: "PENDING",
      });
      await client.execute("DROP TRIGGER reject_upload_metadata");

      const firstDelete = await assetRequest(
        harness.env, session, `/assets/${grant.body.asset_id}`, { method: "DELETE" },
      );
      assert.equal(firstDelete.status, 503);
      const cleanupTime = await client.execute(
        "SELECT next_cleanup_at FROM asset_upload_attempts WHERE asset_id = ?",
        [grant.body.asset_id],
      );
      const cleanupAt = new Date(String(cleanupTime.rows[0]?.next_cleanup_at));
      cleanupAt.setTime(cleanupAt.getTime() + 1);
      const reconciled = await reconcileUploadAttemptCleanup(harness.env, { now: cleanupAt });
      assert.equal(reconciled.cleaned, 1);
      assert.equal(storage.objects.size, 0);

      const retriedCleanup = await assetRequest(
        harness.env, session, `/assets/${grant.body.asset_id}`, { method: "DELETE" },
      );
      assert.equal(retriedCleanup.status, 200);
      const repeatedCleanup = await assetRequest(
        harness.env, session, `/assets/${grant.body.asset_id}`, { method: "DELETE" },
      );
      assert.equal(repeatedCleanup.status, 200);
      assert.equal(storage.objects.size, 0);
      assert.equal((await client.execute(
        "SELECT status FROM assets WHERE id = ?",
        [grant.body.asset_id],
      )).rows[0]?.status, "DELETED");
    } finally {
      client.close();
    }
  });

  it("reconciles an abandoned expired lease but leaves a live upload lease untouched", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createDraftFixture(client);
      const session = await createSession(client, fixture.customerId);
      const harness = deletionContext(adapter, storage.storage, session);
      const abandoned = await createUploadGrant(harness.env, session, fixture.designId);
      const live = await createUploadGrant(harness.env, session, fixture.designId);
      const now = new Date();
      await insertUploadAttemptFixture(client, abandoned.body.asset_id, {
        status: "UPLOADING",
        leaseExpiresAt: "2000-01-01T00:00:00.000Z",
        nextCleanupAt: "2000-01-01T00:00:00.000Z",
      });
      await insertUploadAttemptFixture(client, live.body.asset_id, { status: "UPLOADING" });

      const reconciled = await reconcileUploadAttemptCleanup(harness.env, { now });
      assert.deepEqual(reconciled, {
        processed: 1,
        cleaned: 1,
        preserved: 0,
        retryable: 0,
        manualReview: 0,
      });
      const abandonedState = await client.execute({
        sql: `SELECT attempt.status AS attempt_status, session.status AS session_status,
                asset.status AS asset_status
              FROM asset_upload_attempts attempt
              JOIN asset_upload_sessions session ON session.id = attempt.session_id
              JOIN assets asset ON asset.id = attempt.asset_id
              WHERE attempt.asset_id = ?`,
        args: [abandoned.body.asset_id],
      });
      assert.deepEqual(abandonedState.rows[0], {
        attempt_status: "CLEANED",
        session_status: "CANCELLED",
        asset_status: "REJECTED",
      });

      const liveCleanup = await reconcileUploadAttemptCleanup(harness.env, { now });
      assert.equal(liveCleanup.processed, 0);
      assert.equal((await client.execute(
        "SELECT status FROM asset_upload_attempts WHERE asset_id = ?",
        [live.body.asset_id],
      )).rows[0]?.status, "UPLOADING");
    } finally {
      client.close();
    }
  });

  it("does not clean a valid ATTACHED attempt or an asset it no longer owns", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createDraftFixture(client);
      const session = await createSession(client, fixture.customerId);
      const harness = deletionContext(adapter, storage.storage, session);
      const grant = await createUploadGrant(harness.env, session, fixture.designId);
      assert.equal((await assetRequest(
        harness.env, session, grant.body.upload_url.replace("/api/v1", ""), {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${grant.body.upload_token}`,
            "Content-Type": "image/png",
          },
          body: new Blob([UPLOAD_PNG], { type: "image/png" }),
        },
      )).status, 204);
      assert.equal((await assetRequest(
        harness.env, session, `/assets/${grant.body.asset_id}/complete`, { method: "POST" },
      )).status, 200);
      const attempt = await client.execute(
        "SELECT object_key FROM asset_upload_attempts WHERE asset_id = ?",
        [grant.body.asset_id],
      );
      const attachedKey = String(attempt.rows[0]?.object_key);
      const currentKey = `private/current-${grant.body.asset_id}.png`;
      await storage.storage.upload(currentKey, UPLOAD_PNG, { contentType: "image/png" });
      await client.execute(
        `UPDATE assets SET object_key = ? WHERE id = ?`,
        [currentKey, grant.body.asset_id],
      );
      await client.execute(
        `UPDATE asset_upload_attempts
         SET next_cleanup_at = '2000-01-01T00:00:00.000Z'
         WHERE asset_id = ?`,
        [grant.body.asset_id],
      );

      const cleanup = await reconcileUploadAttemptCleanup(harness.env, { now: new Date() });
      assert.deepEqual(cleanup, {
        processed: 1,
        cleaned: 1,
        preserved: 0,
        retryable: 0,
        manualReview: 0,
      });
      assert.equal(await storage.storage.get(attachedKey), null);
      assert.ok(await storage.storage.get(currentKey));
      const state = await client.execute(
        "SELECT status, object_key FROM assets WHERE id = ?",
        [grant.body.asset_id],
      );
      assert.deepEqual(state.rows[0], { status: "READY", object_key: currentKey });
    } finally {
      client.close();
    }
  });

  it("fences concurrent cleanup and retries late provider success on the next reconciliation", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const uploadStarted = deferred();
    const releaseUpload = deferred();
    const releaseDelete = deferred();
    const deleteStarted = deferred();
    const storage = createRaceStorage({
      beforeUpload: async () => {
        uploadStarted.resolve();
        await releaseUpload.promise;
      },
      beforeDelete: async () => {
        deleteStarted.resolve();
        await releaseDelete.promise;
      },
    });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createDraftFixture(client);
      const session = await createSession(client, fixture.customerId);
      const harness = deletionContext(adapter, storage.storage, session);
      const grant = await createUploadGrant(harness.env, session, fixture.designId);
      const upload = assetRequest(
        harness.env, session, grant.body.upload_url.replace("/api/v1", ""), {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${grant.body.upload_token}`,
            "Content-Type": "image/png",
          },
          body: new Blob([UPLOAD_PNG], { type: "image/png" }),
        },
      );
      await uploadStarted.promise;
      await client.execute(
        `UPDATE asset_upload_sessions SET lease_expires_at = '2000-01-01T00:00:00.000Z'
         WHERE asset_id = ?`,
        [grant.body.asset_id],
      );
      await client.execute(
        `UPDATE asset_upload_attempts
         SET lease_expires_at = '2000-01-01T00:00:00.000Z',
             next_cleanup_at = '2000-01-01T00:00:00.000Z'
         WHERE asset_id = ? AND status = 'UPLOADING'`,
        [grant.body.asset_id],
      );

      const firstCleanup = reconcileUploadAttemptCleanup(harness.env, { now: NOW });
      await deleteStarted.promise;
      const overlappingCleanup = await reconcileUploadAttemptCleanup(harness.env, { now: NOW });
      assert.equal(overlappingCleanup.processed, 0);
      releaseDelete.resolve();
      assert.equal((await firstCleanup).cleaned, 1);
      releaseUpload.resolve();
      assert.equal((await upload).status, 503);
      assert.equal(storage.objects.size, 1, "late provider success is not cancelled by DB fencing");

      const lateRetry = await reconcileUploadAttemptCleanup(harness.env, {
        now: new Date(NOW.getTime() + 60 * 60_000 + 1),
      });
      assert.equal(lateRetry.cleaned, 1);
      assert.equal(storage.objects.size, 0);
      assert.equal((await client.execute(
        "SELECT reconciliation_state FROM asset_upload_attempts WHERE asset_id = ?",
        [grant.body.asset_id],
      )).rows[0]?.reconciliation_state, "ACTIVE");
    } finally {
      releaseDelete.resolve();
      releaseUpload.resolve();
      client.close();
    }
  });

  it("moves exhausted cleanup retries to manual review and stops automated retries", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage({ sourceDeleteFailures: 8 });
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createDraftFixture(client);
      const session = await createSession(client, fixture.customerId);
      const harness = deletionContext(adapter, storage.storage, session);
      const grant = await createUploadGrant(harness.env, session, fixture.designId);
      const attempt = await insertUploadAttemptFixture(client, grant.body.asset_id);
      const objectKey = attempt.objectKey;
      await storage.storage.upload(objectKey, UPLOAD_PNG, { contentType: "image/png" });
      await client.execute(
        `UPDATE asset_upload_attempts
         SET status = 'CLEANUP_PENDING', cleanup_attempts = 7,
             next_cleanup_at = '2000-01-01T00:00:00.000Z'
         WHERE asset_id = ?`,
        [grant.body.asset_id],
      );

      const exhausted = await reconcileUploadAttemptCleanup(harness.env, { now: NOW });
      assert.equal(exhausted.retryable, 1);
      assert.equal(exhausted.manualReview, 1);
      const state = await client.execute(
        `SELECT status, reconciliation_state, cleanup_attempts
         FROM asset_upload_attempts WHERE asset_id = ?`,
        [grant.body.asset_id],
      );
      assert.deepEqual(state.rows[0], {
        status: "CLEANUP_PENDING",
        reconciliation_state: "MANUAL_REVIEW",
        cleanup_attempts: 8,
      });
      const later = await reconcileUploadAttemptCleanup(harness.env, {
        now: new Date(NOW.getTime() + 30 * 24 * 60 * 60_000),
      });
      assert.equal(later.processed, 0);
      assert.ok(await storage.storage.get(objectKey));
    } finally {
      client.close();
    }
  });

  it("runs upload cleanup through the scheduled lifecycle", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createDraftFixture(client);
      const session = await createSession(client, fixture.customerId);
      const harness = deletionContext(adapter, storage.storage, session);
      const grant = await createUploadGrant(harness.env, session, fixture.designId);
      await insertUploadAttemptFixture(client, grant.body.asset_id, {
        nextCleanupAt: "2000-01-01T00:00:00.000Z",
      });

      const run = await runScheduledPublicationLifecycle(harness.env, { now: NOW, limit: 10 });
      assert.equal(run.acquired, true);
      const recorded = await client.execute(
        "SELECT result_json FROM scheduled_task_runs WHERE status = 'COMPLETED'",
      );
      const result = JSON.parse(String(recorded.rows[0]?.result_json)) as {
        operations: { uploadCleanup: { result: { cleaned: number } } };
      };
      assert.equal(result.operations.uploadCleanup.result.cleaned, 1);
      assert.equal((await client.execute(
        "SELECT status FROM asset_upload_attempts WHERE asset_id = ?",
        [grant.body.asset_id],
      )).rows[0]?.status, "CLEANED");
    } finally {
      client.close();
    }
  });

  it("makes concurrent design deletion idempotent", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    const adapter = new TursoDatabaseAdapter(client);
    const storage = createRaceStorage();
    try {
      await client.execute("PRAGMA foreign_keys = ON");
      await applyMigrations(client, await loadMigrations());
      const fixture = await createDraftFixture(client, true);
      await storage.storage.upload(fixture.sourceKey, UPLOAD_PNG, { contentType: "image/png" });
      const session = await createSession(client, fixture.customerId);
      const harness = deletionContext(adapter, storage.storage, session);
      const responses = await Promise.all([
        harness.deleteDesign(fixture.designId),
        harness.deleteDesign(fixture.designId),
      ]);
      assert.ok(responses.every((response) => response.status === 200));
      assert.equal(await storage.storage.get(fixture.sourceKey), null);
      const deleted = await client.execute({
        sql: `SELECT d.status AS design_status, a.status AS asset_status
              FROM designs d JOIN assets a ON a.design_id = d.id WHERE d.id = ?`,
        args: [fixture.designId],
      });
      assert.deepEqual(deleted.rows[0], { design_status: "ARCHIVED", asset_status: "DELETED" });
    } finally {
      client.close();
    }
  });

  it("enforces migration 0012 asset retention through the database trigger", async () => {
    const client = createClient({ url: "file::memory:", intMode: "number" });
    try {
      const migrations = await loadMigrations();
      assert.deepEqual(
        await applyMigrations(client, migrations.filter((migration) => migration.version <= 11)),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      );
      const retainedUntil = new Date(Date.now() + 60_000).toISOString();
      const protectedFixtures = [];
      for (const status of ["PUBLISHED", "UNPUBLISHED", "EXPIRED", "REVOKED"] as const) {
        protectedFixtures.push(await createFixture(client, {
          status,
          expiresAt: status === "PUBLISHED" || status === "UNPUBLISHED"
            ? new Date(Date.now() + 86_400_000).toISOString()
            : new Date(Date.now() - 86_400_000).toISOString(),
          retentionUntil: retainedUntil,
          withAsset: true,
        }));
      }

      assert.deepEqual(await applyMigrations(client, migrations),
        [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
      assert.deepEqual(await applyMigrations(client, migrations), []);

      for (const fixture of protectedFixtures) {
        for (const status of ["DELETION_PENDING", "DELETED"]) {
          await assert.rejects(
            client.execute({
              sql: "UPDATE assets SET status = ? WHERE id = ?",
              args: [status, fixture.assetId],
            }),
            /referenced asset cannot be deleted/,
            `${status} must be blocked for retained publication ${fixture.publicationId}`,
          );
        }
        assert.equal((await client.execute(
          "SELECT status FROM assets WHERE id = ?",
          [fixture.assetId],
        )).rows[0]?.status, "READY");
      }

      const retainedExpired = protectedFixtures.find((fixture) => fixture !== undefined);
      assert.ok(retainedExpired);
      await client.execute(
        `UPDATE publications SET status = 'EXPIRED', retention_delete_after_at = ?
         WHERE id = ?`,
        [retainedUntil, retainedExpired.publicationId],
      );
      await assert.rejects(
        client.execute(
          "UPDATE assets SET status = 'DELETION_PENDING' WHERE id = ?",
          [retainedExpired.assetId],
        ),
        /referenced asset cannot be deleted/,
        "expired publication references remain protected until their deadline",
      );
      await client.execute(
        "UPDATE publications SET retention_delete_after_at = ? WHERE id = ?",
        [new Date(Date.now() - 1_000).toISOString(), retainedExpired.publicationId],
      );
      await client.execute(
        "UPDATE assets SET status = 'DELETION_PENDING' WHERE id = ?",
        [retainedExpired.assetId],
      );
      await client.execute(
        "UPDATE assets SET status = 'DELETED' WHERE id = ?",
        [retainedExpired.assetId],
      );
      assert.equal((await client.execute(
        "SELECT status FROM assets WHERE id = ?",
        [retainedExpired.assetId],
      )).rows[0]?.status, "DELETED");

      const unrelated = await createDraftFixture(client, true);
      await client.execute(
        "UPDATE assets SET status = 'DELETION_PENDING' WHERE id = ?",
        [unrelated.assetId],
      );
      await client.execute(
        "UPDATE assets SET status = 'DELETED' WHERE id = ?",
        [unrelated.assetId],
      );
      assert.equal((await client.execute(
        "SELECT status FROM assets WHERE id = ?",
        [unrelated.assetId],
      )).rows[0]?.status, "DELETED");
      assert.deepEqual((await client.execute("PRAGMA foreign_key_check")).rows, []);
    } finally {
      client.close();
    }
  });
});

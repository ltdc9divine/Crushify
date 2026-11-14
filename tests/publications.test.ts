import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createClient, type Client } from "@libsql/client";
import type { Database, DatabaseStatement } from "../src/database.ts";
import { TursoDatabaseAdapter } from "../src/database/turso.ts";
import { applyMigrations, type SqlMigration } from "../src/database/migrations.ts";
import { handleApiRequest } from "../src/index.ts";
import { reconcileUploadAttemptCleanup } from "../src/assets.ts";
import { createVercelApiHandler } from "../src/platform/vercel.ts";
import { handleFulfillmentForOrder, runPublicationLifecycle } from "../src/publications.ts";
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

  constructor(inner: Database) {
    this.inner = inner;
  }

  prepare(query: string): DatabaseStatement {
    return this.inner.prepare(query);
  }

  pauseNextBatch() {
    const entered = deferred();
    const released = deferred();
    this.batchGate = { entered, released };
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
  sourceDeleteFailures?: number;
} = {}): { storage: Storage; objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  let sourceDeleteFailures = options.sourceDeleteFailures ?? 0;
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
    },
    getPublishedDerivative: asObject,
    async deletePublishedDerivative(key) { objects.delete(key); },
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
                id, provider, event_id, payload_hash, received_at, processed_at, outcome, raw_payload
              ) VALUES (?, 'SEPAY', ?, ?, ?, ?, 'PROCESSED', '{}')`,
        args: [id(), transactionId, "f".repeat(64), now, now],
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

      const firstResponse = await handler(new Request(
        "https://crushify.test/api/cron/publication-lifecycle",
        { headers: { Authorization: `Bearer ${secret}` } },
      ));
      assert.equal(firstResponse.status, 200);
      assert.deepEqual(await firstResponse.json(), {
        acquired: true,
        expired: 1,
        erased: 0,
        retryable: 1,
      });
      assert.equal(connections, 1);
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

      const sourceRetry = await handler(new Request(
        "https://crushify.test/api/cron/publication-lifecycle",
        { headers: { Authorization: `Bearer ${secret}` } },
      ));
      assert.equal(sourceRetry.status, 200);
      assert.deepEqual(await sourceRetry.json(), {
        acquired: true,
        expired: 0,
        erased: 0,
        retryable: 1,
      });

      const completed = await handler(new Request(
        "https://crushify.test/api/cron/publication-lifecycle",
        { headers: { Authorization: `Bearer ${secret}` } },
      ));
      assert.equal(completed.status, 200);
      assert.deepEqual(await completed.json(), {
        acquired: true,
        expired: 0,
        erased: 1,
        retryable: 0,
      });
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
      assert.deepEqual(await repeated.json(), {
        acquired: true,
        expired: 0,
        erased: 0,
        retryable: 0,
      });
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
      await assert.rejects(
        runScheduledPublicationLifecycle(lifecycleEnv, { limit: 10 }),
        /injected lifecycle failure/,
      );
      await client.execute("DROP TRIGGER reject_lifecycle_expiry");

      const summary = await runScheduledPublicationLifecycle(lifecycleEnv, { limit: 10 });
      assert.deepEqual(summary, { acquired: true, expired: 1, erased: 0, retryable: 0 });
      assert.deepEqual(Object.keys(summary).sort(), ["acquired", "erased", "expired", "retryable"]);

      const repeated = await runScheduledPublicationLifecycle(lifecycleEnv, { limit: 10 });
      assert.deepEqual(repeated, {
        acquired: true,
        expired: 0,
        erased: 0,
        retryable: 0,
      });
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
        now: cleanupNow,
      });
      assert.equal(sourceFailure.retryable, 1);
      const completed = await runPublicationLifecycle(env, {
        limit: 10,
        now: cleanupNow,
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
      await applyMigrations(client, await loadMigrations());
      const fixture = await createDraftFixture(client, true);
      await storage.storage.upload(fixture.sourceKey, IMAGE, { contentType: "image/png" });
      await client.batch([
        {
          sql: `INSERT INTO design_asset_refs (
                  design_id, asset_id, customer_id, revision, created_at
                ) VALUES (?, ?, ?, 1, ?)`,
          args: [fixture.designId, fixture.assetId, fixture.customerId, NOW.toISOString()],
        },
        {
          sql: "UPDATE designs SET status = 'ARCHIVED' WHERE id = ?",
          args: [fixture.designId],
        },
      ]);
      const session = await createSession(client, fixture.customerId);
      const harness = deletionContext(adapter, storage.storage, session);

      const failedCleanup = await harness.deleteDesign(fixture.designId);
      assert.equal(failedCleanup.status, 503);
      const retained = await client.execute({
        sql: `SELECT d.status AS design_status, a.status AS asset_status,
                (SELECT COUNT(*) FROM design_asset_refs ref WHERE ref.asset_id = a.id) AS design_refs
              FROM designs d JOIN assets a ON a.design_id = d.id WHERE d.id = ?`,
        args: [fixture.designId],
      });
      assert.deepEqual(retained.rows[0], {
        design_status: "ARCHIVED",
        asset_status: "DELETION_PENDING",
        design_refs: 0,
      });
      assert.ok(await storage.storage.get(fixture.sourceKey));

      assert.equal((await harness.deleteDesign(fixture.designId)).status, 200);
      assert.equal((await harness.deleteDesign(fixture.designId)).status, 200);
      assert.equal(await storage.storage.get(fixture.sourceKey), null);
      assert.equal((await client.execute(
        "SELECT status FROM assets WHERE id = ?",
        [fixture.assetId],
      )).rows[0]?.status, "DELETED");
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
            id, provider, event_id, payload_hash, received_at, processed_at, outcome, raw_payload
          ) VALUES (?, 'SEPAY', ?, ?, ?, ?, 'PROCESSED', '{}')`,
          args: [randomUUID(), providerPaymentId, "b".repeat(64), now, now],
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
        now: new Date(NOW.getTime() + 7 * 24 * 60 * 60_000 + 1),
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
        uploadCleanup: { cleaned: number };
      };
      assert.equal(result.uploadCleanup.cleaned, 1);
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
});

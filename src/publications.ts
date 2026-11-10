import { requireCsrf, requireSession } from "./auth.ts";
import { DatabaseError } from "./database.ts";
import {
  apiError,
  jsonResponse,
  nowIso,
  randomToken,
  readJson,
  safeId,
  sha256,
} from "./http.ts";
import {
  assetReferences,
  publicTemplateData,
  supportsTemplateVersion,
  TEMPLATE_RENDERERS,
  validateTemplateData,
  type TemplateData,
  type TemplateId,
} from "./template-registry.ts";
import { entitlementExpiry } from "./storage-plans.ts";
import type { Env } from "./types.ts";

const CONSENT_VERSION = "public-image-v1";
const SLUG_PATTERN = /^g[A-Za-z0-9_-]{20,40}$/;
const ID_PATTERN = /^[0-9a-f-]{36}$/i;

interface EligibleOrder {
  order_id: string;
  customer_id: string;
  design_id: string;
  order_reference: string;
  design_revision: number;
  design_current_revision: number;
  template_id: string;
  schema_version: number;
  renderer_version: string;
  data_json: string;
  paid_at: string;
  storage_plan_id: string;
  storage_plan_title: string;
  storage_duration_months: number | null;
  storage_lifetime: number;
}

interface PublicationRow {
  id: string;
  design_id: string;
  order_id: string | null;
  published_revision: number;
  template_id: string;
  schema_version: number;
  renderer_version: string;
  slug: string | null;
  slug_hash: string;
  snapshot_json: string;
  status: string;
  lifecycle_revision: number;
  expires_at: string | null;
}

interface AssetRow {
  id: string;
  object_key: string;
  media_type: string;
  byte_size: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localPublishingEnabled(env: Env): boolean {
  return env.LOCAL_TEST_MODE === "true" &&
    (env.ENVIRONMENT === undefined || env.ENVIRONMENT === "local");
}

async function requireLocalPublishing(requestId: string, env: Env): Promise<Response | null> {
  if (!localPublishingEnabled(env)) {
    return apiError(requestId, 503, "PUBLICATION_DISABLED", "Publication mutations are enabled only in local test mode");
  }
  if (!env.STORAGE) {
    return apiError(requestId, 503, "STORAGE_UNAVAILABLE", "Media storage is unavailable");
  }
  return null;
}

function publicationSlug(): string {
  return `g${randomToken(16)}`;
}

function urlForPublication(request: Request, slug: string): string {
  return new URL(`/p/${encodeURIComponent(slug)}`, request.url).toString();
}

async function paidOrderForOwner(
  env: Env,
  customerId: string,
  orderId: string,
): Promise<EligibleOrder | null> {
  return env.DB.prepare(
    `SELECT o.id AS order_id, o.customer_id, d.id AS design_id, o.order_reference,
            o.design_revision, d.revision AS design_current_revision,
            d.template_id, d.schema_version, d.data_json,
            t.current_renderer_version AS renderer_version, o.paid_at,
            storage_item.reference_id AS storage_plan_id,
            json_extract(storage_item.metadata_json, '$.title') AS storage_plan_title,
            json_extract(storage_item.metadata_json, '$.duration_months') AS storage_duration_months,
            json_extract(storage_item.metadata_json, '$.lifetime') AS storage_lifetime
     FROM orders o
     JOIN designs d ON d.id = o.design_id AND d.customer_id = o.customer_id
     JOIN order_items i ON i.order_id = o.id AND i.item_type = 'TEMPLATE_LICENSE'
     JOIN order_items storage_item ON storage_item.order_id = o.id
       AND storage_item.item_type = 'ADD_ON'
       AND json_extract(storage_item.metadata_json, '$.kind') = 'STORAGE_PLAN'
     JOIN payments p ON p.order_id = o.id AND p.provider = 'SEPAY'
     JOIN payment_webhook_events e ON e.provider = p.provider
       AND e.event_id = p.provider_payment_id AND e.outcome = 'PROCESSED'
     JOIN templates t ON t.id = d.template_id AND t.status = 'ACTIVE'
     JOIN template_versions v ON v.template_id = d.template_id
       AND v.schema_version = d.schema_version AND v.status = 'ACTIVE'
     WHERE o.id = ? AND o.customer_id = ? AND o.order_type = 'SELF_SERVICE'
       AND o.status IN ('PAID','FULFILLING','FULFILLED') AND o.paid_at IS NOT NULL
       AND o.payment_review_required = 0
       AND o.design_revision IS NOT NULL AND o.design_revision <= d.revision
       AND d.status = 'DRAFT' AND d.data_json IS NOT NULL
       AND i.reference_id = d.template_id
       AND CAST(json_extract(i.metadata_json, '$.schema_version') AS INTEGER) = d.schema_version
       AND p.status = 'SUCCEEDED' AND p.review_required = 0
       AND p.provider_payment_id IS NOT NULL AND p.provider_payment_id <> ''
       AND p.succeeded_at IS NOT NULL AND p.amount_minor = o.total_minor
       AND p.currency = o.currency
       AND NOT EXISTS (
         SELECT 1 FROM order_items pricing_item
         WHERE pricing_item.order_id = o.id AND pricing_item.item_type = 'ADD_ON'
           AND json_extract(pricing_item.metadata_json, '$.pricing_snapshot.total_minor') IS NOT NULL
           AND CAST(json_extract(pricing_item.metadata_json, '$.pricing_snapshot.total_minor') AS INTEGER) <> o.total_minor
       )` ,
  ).bind(orderId, customerId).first<EligibleOrder>();
}

async function designRevisionData(
  env: Env,
  designId: string,
  revision: number,
): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT data_json FROM design_revisions WHERE design_id = ? AND revision = ?",
  ).bind(designId, revision).first<{ data_json: string }>();
  return row?.data_json ?? null;
}

function parseConsentList(value: unknown, requiredIds: string[]): Array<{ assetId: string }> | null {
  if (!Array.isArray(value) || value.length > requiredIds.length) return null;
  const consents: Array<{ assetId: string }> = [];
  for (const entry of value) {
    if (!isRecord(entry) || Object.keys(entry).length !== 2 ||
        typeof entry.asset_id !== "string" || !ID_PATTERN.test(entry.asset_id) ||
        entry.consent_version !== CONSENT_VERSION) return null;
    consents.push({ assetId: entry.asset_id });
  }
  const expected = [...requiredIds].sort();
  const actual = consents.map(({ assetId }) => assetId);
  if (new Set(actual).size !== actual.length || actual.some((id) => !expected.includes(id))) return null;
  return consents;
}

async function validateOwnedAssets(
  env: Env,
  design: Pick<EligibleOrder, "customer_id" | "design_id">,
  references: string[],
): Promise<AssetRow[] | null> {
  if (references.length === 0) return [];
  const placeholders = references.map(() => "?").join(",");
  const result = await env.DB.prepare(
    `SELECT id, object_key, media_type, byte_size FROM assets
     WHERE customer_id = ? AND design_id = ? AND status = 'READY'
       AND id IN (${placeholders})`,
  ).bind(design.customer_id, design.design_id, ...references).all<AssetRow>();
  return result.results.length === references.length ? result.results : null;
}

async function insertPublication(
  request: Request,
  env: Env,
  requestId: string,
  customerId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const orderId = body.order_id;
  const expectedRevision = body.expected_revision;
  if (Object.keys(body).length !== 3 || typeof orderId !== "string" || !ID_PATTERN.test(orderId) ||
      !Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) {
    return apiError(requestId, 400, "VALIDATION_ERROR", "Expected order_id, expected_revision and asset_consents");
  }
  const order = await paidOrderForOwner(env, customerId, orderId);
  if (!order) return apiError(requestId, 422, "PAYMENT_NOT_VERIFIED", "A verified paid template order is required");
  if (order.design_current_revision !== expectedRevision) {
    return apiError(requestId, 409, "CONFLICT", "Design revision changed; reload before publishing");
  }
  const renderer = TEMPLATE_RENDERERS[order.template_id as TemplateId];
  if (!renderer || !supportsTemplateVersion(order.template_id, order.schema_version) ||
      renderer.rendererVersion !== order.renderer_version) {
    return apiError(requestId, 422, "RENDERER_UNAVAILABLE", "This template version cannot be published");
  }
  const rawData = await designRevisionData(env, order.design_id, expectedRevision as number);
  if (!rawData) return apiError(requestId, 409, "CONFLICT", "Design revision is unavailable");
  const validated = validateTemplateData(order.template_id, order.schema_version, JSON.parse(rawData));
  if (!validated.value) {
    return apiError(requestId, 422, "VALIDATION_ERROR", "Design data is invalid", validated.fields);
  }
  const references = assetReferences(order.template_id, validated.value);
  const consents = parseConsentList(body.asset_consents, references);
  if (!consents) {
    return apiError(requestId, 422, "ASSET_CONSENT_REQUIRED", "Every selected photo requires explicit publication consent");
  }
  const assets = await validateOwnedAssets(env, order, references);
  if (!assets) return apiError(requestId, 422, "ASSET_UNAVAILABLE", "A selected image is unavailable");
  const consentedIds = new Set(consents.map(({ assetId }) => assetId));
  const snapshotData = references.reduce((data, assetId) =>
    consentedIds.has(assetId) ? data : removeAssetReference(order.template_id, data, assetId),
  validated.value);

  const existing = await env.DB.prepare(
    `SELECT id FROM publications
     WHERE design_id = ? AND status IN ('PUBLISHED','UNPUBLISHED','EXPIRED')
       AND renderer_version <> 'unsupported'`,
  ).bind(order.design_id).first<{ id: string }>();
  if (existing) return apiError(requestId, 409, "PUBLICATION_EXISTS", "This design already has a publication");

  const now = nowIso();
  const storageExpiry = entitlementExpiry({
    id: order.storage_plan_id,
    durationMonths: order.storage_duration_months,
    lifetime: Boolean(order.storage_lifetime),
  }, new Date(order.paid_at));
  if (!Number.isFinite(Date.parse(order.paid_at))) {
    return apiError(requestId, 422, "PAYMENT_NOT_VERIFIED", "Payment activation time is invalid");
  }
  const expiresAt = storageExpiry?.toISOString() ?? null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const slug = publicationSlug();
    const publicationId = safeId();
    const statements = [
      env.DB.prepare(
        `INSERT INTO publications (
           id, design_id, order_id, published_revision, template_id, schema_version,
           renderer_version, slug, slug_hash, snapshot_json, status, lifecycle_revision,
           activated_at, original_expires_at, expires_at, created_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UNPUBLISHED', 1, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM orders o
           JOIN designs d ON d.id = o.design_id AND d.customer_id = o.customer_id
           JOIN order_items i ON i.order_id = o.id AND i.item_type = 'TEMPLATE_LICENSE'
           JOIN payments p ON p.order_id = o.id AND p.provider = 'SEPAY'
           JOIN payment_webhook_events e ON e.provider = p.provider
             AND e.event_id = p.provider_payment_id AND e.outcome = 'PROCESSED'
           JOIN templates t ON t.id = d.template_id AND t.status = 'ACTIVE'
           JOIN template_versions v ON v.template_id = d.template_id
             AND v.schema_version = d.schema_version AND v.status = 'ACTIVE'
           WHERE o.id = ? AND o.customer_id = ? AND o.order_type = 'SELF_SERVICE'
             AND o.status IN ('PAID','FULFILLING','FULFILLED')
             AND o.paid_at IS NOT NULL AND o.payment_review_required = 0
             AND o.design_revision = ? AND d.revision = ? AND d.status = 'DRAFT'
             AND d.template_id = ? AND d.schema_version = ?
             AND i.reference_id = d.template_id
             AND CAST(json_extract(i.metadata_json, '$.schema_version') AS INTEGER) = d.schema_version
             AND p.status = 'SUCCEEDED' AND p.provider_payment_id IS NOT NULL
             AND p.provider_payment_id <> '' AND p.succeeded_at IS NOT NULL
             AND p.review_required = 0 AND p.amount_minor = o.total_minor
             AND p.currency = o.currency
         )`,
      ).bind(
        publicationId, order.design_id, order.order_id, expectedRevision as number,
        order.template_id, order.schema_version, renderer.rendererVersion, slug, await sha256(slug),
        JSON.stringify({ data: snapshotData }), order.paid_at, order.paid_at,
        expiresAt, now, now, order.order_id, customerId,
        expectedRevision as number, expectedRevision as number, order.template_id, order.schema_version,
      ),
      ...consents.map(({ assetId }) => env.DB.prepare(
        `INSERT INTO publication_assets (
           id, publication_id, asset_id, customer_id, consent_version, consented_at,
           derivative_status, created_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?
         WHERE EXISTS (SELECT 1 FROM publications WHERE id = ?)`,
      ).bind(safeId(), publicationId, assetId, customerId, CONSENT_VERSION, now, now, now,
        publicationId)),
      env.DB.prepare(
        `INSERT INTO audit_logs (
           id, actor_type, actor_id, action, entity_type, entity_id, request_id,
           metadata_json, created_at
         )
         SELECT ?, 'CUSTOMER', ?, 'publication.created', 'publication', ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM publications WHERE id = ?)`,
      ).bind(safeId(), customerId, publicationId, requestId,
        JSON.stringify({ design_id: order.design_id, order_reference: order.order_reference }), now,
        publicationId),
    ];
    try {
      const results = await env.DB.batch(statements);
      if ((results[0]?.meta.changes ?? 0) !== 1) {
        return apiError(requestId, 422, "PAYMENT_NOT_VERIFIED", "A verified paid template order is required");
      }
      return jsonResponse({
        publication_id: publicationId,
        status: "UNPUBLISHED",
        lifecycle_revision: 1,
        url: urlForPublication(request, slug),
      }, 201, requestId);
    } catch (error) {
      if (!(error instanceof DatabaseError) || error.code !== "CONSTRAINT") throw error;
      const collided = await env.DB.prepare(
        "SELECT id FROM publications WHERE slug = ? OR design_id = ?",
      ).bind(slug, order.design_id).first<{ id: string }>();
      if (collided) {
        if (collided.id !== publicationId) {
          return apiError(requestId, 409, "PUBLICATION_EXISTS", "This design already has a publication");
        }
        continue;
      }
      throw error;
    }
  }
  return apiError(requestId, 503, "SLUG_UNAVAILABLE", "Could not allocate a public link; retry the request");
}

async function loadOwnedPublication(
  env: Env,
  customerId: string,
  publicationId: string,
): Promise<PublicationRow | null> {
  return env.DB.prepare(
    `SELECT p.id, p.design_id, p.order_id, p.published_revision, p.template_id,
            p.schema_version, p.renderer_version, p.slug, p.slug_hash,
            p.snapshot_json, p.status, p.lifecycle_revision, p.expires_at
     FROM publications p
     JOIN designs d ON d.id = p.design_id AND d.customer_id = ?
     WHERE p.id = ? AND p.renderer_version <> 'unsupported'`,
  ).bind(customerId, publicationId).first<PublicationRow>();
}

async function cleanupAssets(
  env: Env,
  publicationId: string,
): Promise<boolean> {
  if (!env.STORAGE) return false;
  const rows = await env.DB.prepare(
    `SELECT id, derivative_key FROM publication_assets
     WHERE publication_id = ? AND derivative_key IS NOT NULL
       AND derivative_status IN ('READY','CLEANUP_PENDING')`,
  ).bind(publicationId).all<{ id: string; derivative_key: string }>();
  let success = true;
  for (const row of rows.results) {
    try {
      await env.STORAGE.deletePublishedDerivative(row.derivative_key);
      await env.DB.prepare(
        `UPDATE publication_assets SET derivative_key = NULL, derivative_status = 'DELETED',
           updated_at = ? WHERE id = ? AND derivative_key = ?`,
      ).bind(nowIso(), row.id, row.derivative_key).run();
    } catch (error) {
      success = false;
      console.error("Published media cleanup failed", {
        publication_id: publicationId,
        publication_asset_id: row.id,
        error,
      });
      await env.DB.prepare(
        `UPDATE publication_assets SET derivative_status = 'CLEANUP_PENDING', updated_at = ?
         WHERE id = ? AND derivative_key = ?`,
      ).bind(nowIso(), row.id, row.derivative_key).run();
    }
  }
  return success;
}

export async function runPublicationLifecycle(
  env: Env,
  options: { limit?: number; retentionDays?: number; now?: Date } = {},
): Promise<{ expired: number; erased: number; retryable: number }> {
  const limit = options.limit ?? 50;
  const retentionDays = options.retentionDays ?? Number(env.DATA_RETENTION_DAYS ?? 30);
  const nowDate = options.now ?? new Date();
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650 ||
      !Number.isFinite(nowDate.getTime())) {
    throw new RangeError("Invalid publication lifecycle batch configuration");
  }
  if (!env.STORAGE) throw new Error("Publication lifecycle requires private media storage");

  const now = nowDate.toISOString();
  const retainUntil = new Date(nowDate.getTime() + retentionDays * 86400_000).toISOString();
  const expiring = await env.DB.prepare(
    `SELECT id FROM publications
     WHERE status = 'PUBLISHED' AND expires_at IS NOT NULL AND expires_at <= ?
       AND NOT EXISTS (
         SELECT 1 FROM storage_entitlements entitlement
         WHERE entitlement.publication_id = publications.id AND entitlement.status = 'LIFETIME'
       )
     ORDER BY expires_at LIMIT ?`,
  ).bind(now, limit).all<{ id: string }>();
  for (const { id } of expiring.results) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE publications
         SET status = 'EXPIRED', expired_at = COALESCE(expired_at, ?),
             retention_delete_after_at = COALESCE(retention_delete_after_at, ?),
             lifecycle_revision = lifecycle_revision + 1, updated_at = ?
         WHERE id = ? AND status = 'PUBLISHED' AND expires_at <= ?`,
      ).bind(now, retainUntil, now, id, now),
      env.DB.prepare(
        `UPDATE storage_entitlements SET status = 'EXPIRED'
         WHERE publication_id = ? AND status = 'ACTIVE' AND expires_at IS NOT NULL
           AND expires_at <= ?`,
      ).bind(id, now),
    ]);
  }

  const expired = await env.DB.prepare(
    `SELECT id, design_id FROM publications
     WHERE status IN ('EXPIRED','REVOKED') AND retention_delete_after_at IS NOT NULL
       AND retention_delete_after_at <= ?
       AND NOT EXISTS (
         SELECT 1 FROM storage_entitlements entitlement
         WHERE entitlement.publication_id = publications.id AND entitlement.status = 'LIFETIME'
       )
       AND NOT EXISTS (
         SELECT 1 FROM orders o
         WHERE o.design_id = publications.design_id
           AND (o.status IN ('PAID','FULFILLING') OR
             (o.status = 'AWAITING_PAYMENT' AND o.expires_at > ?))
       )
     ORDER BY retention_delete_after_at LIMIT ?`,
  ).bind(now, now, limit).all<{ id: string; design_id: string }>();
  let erased = 0;
  let retryable = 0;
  for (const publication of expired.results) {
    const claimed = await env.DB.prepare(
      `UPDATE designs SET status = 'ARCHIVED', updated_at = ?
       WHERE id = ? AND status IN ('DRAFT','ARCHIVED')
         AND NOT EXISTS (
           SELECT 1 FROM orders o
           WHERE o.design_id = designs.id
             AND (o.status IN ('PAID','FULFILLING') OR
               (o.status = 'AWAITING_PAYMENT' AND o.expires_at > ?))
         )
         AND NOT EXISTS (
           SELECT 1 FROM publications other
           WHERE other.design_id = designs.id AND other.id <> ?
             AND (other.status IN ('PUBLISHED','UNPUBLISHED') OR
               (other.status IN ('EXPIRED','REVOKED') AND
                 (other.retention_delete_after_at IS NULL OR other.retention_delete_after_at > ?)))
         )`,
    ).bind(now, publication.design_id, now, publication.id, now).run();
    if (claimed.meta.changes !== 1) {
      retryable++;
      continue;
    }
    if (!await cleanupAssets(env, publication.id)) {
      retryable++;
      continue;
    }
    const assets = await env.DB.prepare(
      `SELECT id, object_key FROM assets
       WHERE design_id = ? AND status NOT IN ('DELETED','REJECTED')`,
    ).bind(publication.design_id).all<{ id: string; object_key: string }>();
    let deleted = true;
    for (const asset of assets.results) {
      try {
        await env.STORAGE.delete(asset.object_key);
      } catch (error) {
        deleted = false;
        console.error("Expired publication media cleanup failed", {
          publication_id: publication.id,
          asset_id: asset.id,
          error,
        });
        break;
      }
    }
    if (!deleted) {
      retryable++;
      continue;
    }
    const archivedAt = nowIso();
    await env.DB.batch([
      ...assets.results.map((asset) => env.DB.prepare(
        `UPDATE assets SET status = 'DELETED', deleted_at = COALESCE(deleted_at, ?), updated_at = ?
         WHERE id = ?`,
      ).bind(archivedAt, archivedAt, asset.id)),
      env.DB.prepare(
        `UPDATE designs SET data_json = '{}', status = 'ARCHIVED', updated_at = ?
         WHERE id = ? AND NOT EXISTS (
           SELECT 1 FROM publications WHERE design_id = ? AND status = 'PUBLISHED'
         )`,
      ).bind(archivedAt, publication.design_id, publication.design_id),
      env.DB.prepare("DELETE FROM design_revisions WHERE design_id = ?").bind(publication.design_id),
      env.DB.prepare(
        "UPDATE preview_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE design_id = ?",
      ).bind(archivedAt, publication.design_id),
      env.DB.prepare(
        `UPDATE publications SET snapshot_json = '{}', retention_delete_after_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('EXPIRED','REVOKED')`,
      ).bind(archivedAt, publication.id),
      env.DB.prepare(
        `INSERT INTO audit_logs (
           id, actor_type, actor_id, action, entity_type, entity_id, request_id,
           metadata_json, created_at
         ) VALUES (?, 'SYSTEM', NULL, 'publication.retention_data_erased',
           'publication', ?, NULL, '{}', ?)`,
      ).bind(safeId(), publication.id, archivedAt),
    ]);
    erased++;
  }
  return { expired: expiring.results.length, erased, retryable };
}

async function publish(
  request: Request,
  env: Env,
  requestId: string,
  customerId: string,
  publicationId: string,
  expectedLifecycle: number,
): Promise<Response> {
  if (!env.STORAGE) return apiError(requestId, 503, "STORAGE_UNAVAILABLE", "Media storage is unavailable");
  const row = await loadOwnedPublication(env, customerId, publicationId);
  if (!row) return apiError(requestId, 404, "NOT_FOUND", "Publication not found");
  if (row.status === "REVOKED" || row.status === "EXPIRED" ||
      row.lifecycle_revision !== expectedLifecycle) {
    return apiError(requestId, 409, "CONFLICT", "Publication state changed; reload before publishing");
  }
  if (!row.order_id || !await paidOrderForOwner(env, customerId, row.order_id)) {
    return apiError(requestId, 422, "PAYMENT_NOT_VERIFIED", "The linked paid order is no longer eligible");
  }
  const renderer = TEMPLATE_RENDERERS[row.template_id as TemplateId];
  if (!renderer || !supportsTemplateVersion(row.template_id, row.schema_version) ||
      renderer.rendererVersion !== row.renderer_version) {
    return apiError(requestId, 422, "RENDERER_UNAVAILABLE", "This template version cannot be published");
  }
  const snapshot = JSON.parse(row.snapshot_json) as { data?: unknown };
  const validated = validateTemplateData(row.template_id, row.schema_version, snapshot.data);
  if (!validated.value) return apiError(requestId, 422, "VALIDATION_ERROR", "Publication snapshot is invalid");
  const references = assetReferences(row.template_id, validated.value);
  const assets = await env.DB.prepare(
    `SELECT pa.id, pa.asset_id, pa.customer_id, pa.consent_version, pa.revoked_at,
            pa.derivative_key, pa.derivative_status, a.object_key, a.media_type, a.byte_size
     FROM publication_assets pa JOIN assets a ON a.id = pa.asset_id
     WHERE pa.publication_id = ? AND pa.revoked_at IS NULL`,
  ).bind(publicationId).all<{
    id: string;
    asset_id: string;
    customer_id: string;
    consent_version: string;
    revoked_at: string | null;
    derivative_key: string | null;
    derivative_status: string;
    object_key: string;
    media_type: string;
    byte_size: number;
  }>();
  if (assets.results.length !== references.length ||
      references.some((id) => !assets.results.some((item) =>
        item.asset_id === id && item.customer_id === customerId &&
        item.consent_version === CONSENT_VERSION && !item.revoked_at))) {
    return apiError(requestId, 422, "ASSET_CONSENT_REQUIRED", "Photo consent is missing or revoked");
  }
  const owned = await validateOwnedAssets(env, {
    customer_id: customerId,
    design_id: row.design_id,
  }, references);
  if (!owned) return apiError(requestId, 422, "ASSET_UNAVAILABLE", "A selected image is unavailable");

  for (const item of assets.results) {
    if (!references.includes(item.asset_id)) continue;
    if (item.derivative_status === "CLEANUP_PENDING") {
      return apiError(requestId, 503, "MEDIA_CLEANUP_PENDING", "Photo cleanup must complete before republishing");
    }
    let derivativeKey = item.derivative_key;
    if (!derivativeKey || item.derivative_status === "DELETED") {
      const extension = item.media_type === "image/png" ? "png" :
        item.media_type === "image/jpeg" ? "jpg" : null;
      if (!extension || !Number.isSafeInteger(item.byte_size) || item.byte_size < 1) {
        return apiError(requestId, 422, "ASSET_UNAVAILABLE", "A selected image has invalid metadata");
      }
      derivativeKey = `published/${randomToken(32)}-${extension}`;
      const staged = await env.DB.prepare(
        `UPDATE publication_assets SET derivative_key = ?, derivative_status = 'PENDING', updated_at = ?
         WHERE id = ? AND revoked_at IS NULL AND derivative_status IN ('PENDING','DELETED')`,
      ).bind(derivativeKey, nowIso(), item.id).run();
      if (staged.meta.changes !== 1) return apiError(requestId, 409, "CONFLICT", "Photo consent changed during publish");
    }
    if (item.derivative_status !== "READY" || !item.derivative_key) {
      try {
        await env.STORAGE.createPublishedDerivative(item.object_key, derivativeKey);
      } catch (error) {
        console.error("Published media creation failed", {
          publication_id: publicationId,
          publication_asset_id: item.id,
          error,
        });
        return apiError(requestId, 503, "MEDIA_PUBLISH_FAILED", "Could not prepare an approved photo");
      }
      const ready = await env.DB.prepare(
        `UPDATE publication_assets SET derivative_status = 'READY', updated_at = ?
         WHERE id = ? AND derivative_key = ? AND revoked_at IS NULL`,
      ).bind(nowIso(), item.id, derivativeKey).run();
      if (ready.meta.changes !== 1) {
        try {
          await env.STORAGE.deletePublishedDerivative(derivativeKey);
        } catch (error) {
          console.error("Uncommitted published media cleanup failed", {
            publication_id: publicationId,
            publication_asset_id: item.id,
            error,
          });
        }
        return apiError(requestId, 409, "CONFLICT", "Photo consent changed during publish");
      }
    }
  }

  const now = nowIso();
  const result = await env.DB.prepare(
    `UPDATE publications
     SET status = 'PUBLISHED', published_at = COALESCE(published_at, ?),
         unpublished_at = NULL, lifecycle_revision = lifecycle_revision + 1, updated_at = ?
     WHERE id = ? AND status = 'UNPUBLISHED' AND lifecycle_revision = ?
       AND (expires_at IS NULL OR expires_at > ?)
       AND EXISTS (
         SELECT 1 FROM orders o
         JOIN designs d ON d.id = o.design_id AND d.customer_id = o.customer_id
         JOIN order_items i ON i.order_id = o.id AND i.item_type = 'TEMPLATE_LICENSE'
         JOIN payments payment ON payment.order_id = o.id AND payment.provider = 'SEPAY'
         JOIN payment_webhook_events e ON e.provider = payment.provider
           AND e.event_id = payment.provider_payment_id AND e.outcome = 'PROCESSED'
         JOIN templates t ON t.id = d.template_id AND t.status = 'ACTIVE'
         JOIN template_versions v ON v.template_id = d.template_id
           AND v.schema_version = d.schema_version AND v.status = 'ACTIVE'
         WHERE o.id = publications.order_id AND o.customer_id = ?
           AND o.order_type = 'SELF_SERVICE' AND o.status IN ('PAID','FULFILLING','FULFILLED')
           AND o.paid_at IS NOT NULL AND o.payment_review_required = 0
           AND o.design_revision IS NOT NULL AND o.design_revision <= d.revision
           AND d.status = 'DRAFT' AND d.template_id = publications.template_id
           AND d.schema_version = publications.schema_version
           AND publications.published_revision <= d.revision
           AND i.reference_id = d.template_id
           AND CAST(json_extract(i.metadata_json, '$.schema_version') AS INTEGER) = d.schema_version
           AND payment.status = 'SUCCEEDED' AND payment.provider_payment_id IS NOT NULL
           AND payment.provider_payment_id <> '' AND payment.succeeded_at IS NOT NULL
           AND payment.review_required = 0 AND payment.amount_minor = o.total_minor
           AND payment.currency = o.currency
           AND NOT EXISTS (
             SELECT 1 FROM order_items pricing_item
             WHERE pricing_item.order_id = o.id AND pricing_item.item_type = 'ADD_ON'
               AND json_extract(pricing_item.metadata_json, '$.pricing_snapshot.total_minor') IS NOT NULL
               AND CAST(json_extract(pricing_item.metadata_json, '$.pricing_snapshot.total_minor') AS INTEGER) <> o.total_minor
           )
       )`,
  ).bind(now, now, publicationId, expectedLifecycle, now, customerId).run();
  if (result.meta.changes !== 1) return apiError(requestId, 409, "CONFLICT", "Publication state changed; reload before publishing");
  await env.DB.prepare(
    `INSERT INTO audit_logs (
       id, actor_type, actor_id, action, entity_type, entity_id, request_id, metadata_json, created_at
     ) VALUES (?, 'CUSTOMER', ?, 'publication.published', 'publication', ?, ?, '{}', ?)`,
  ).bind(safeId(), customerId, publicationId, requestId, now).run();
  return jsonResponse({
    status: "PUBLISHED",
    lifecycle_revision: expectedLifecycle + 1,
    url: row.slug ? urlForPublication(request, row.slug) : null,
    published_at: row.status === "PUBLISHED" ? undefined : now,
  }, 200, requestId);
}

async function unpublishOrRevoke(
  request: Request,
  env: Env,
  requestId: string,
  customerId: string,
  publicationId: string,
  expectedLifecycle: number,
  revoke: boolean,
): Promise<Response> {
  const row = await loadOwnedPublication(env, customerId, publicationId);
  if (!row) return apiError(requestId, 404, "NOT_FOUND", "Publication not found");
  if (row.lifecycle_revision !== expectedLifecycle ||
      (revoke ? row.status === "REVOKED" : row.status !== "PUBLISHED" && row.status !== "UNPUBLISHED")) {
    return apiError(requestId, 409, "CONFLICT", "Publication state changed; reload before continuing");
  }
  const now = nowIso();
  const retentionDays = Number(env.DATA_RETENTION_DAYS ?? 30);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new Error("DATA_RETENTION_DAYS must be between 1 and 3650");
  }
  const retentionUntil = new Date(Date.parse(now) + retentionDays * 86400_000).toISOString();
  const status = revoke ? "REVOKED" : "UNPUBLISHED";
  const statements = [
    env.DB.prepare(
      `UPDATE publications SET status = ?, unpublished_at = ?,
       revoked_at = CASE WHEN ? = 1 THEN ? ELSE revoked_at END,
       retention_delete_after_at = CASE WHEN ? = 1
         THEN COALESCE(retention_delete_after_at, ?) ELSE retention_delete_after_at END,
       lifecycle_revision = lifecycle_revision + 1, updated_at = ?
     WHERE id = ? AND lifecycle_revision = ?
       AND status IN ('PUBLISHED','UNPUBLISHED')`,
    ).bind(status, now, revoke ? 1 : 0, now, revoke ? 1 : 0, retentionUntil,
      now, publicationId, expectedLifecycle),
  ];
  if (revoke) {
    statements.push(env.DB.prepare(
      `UPDATE storage_entitlements SET status = 'REVOKED'
       WHERE publication_id = ? AND status IN ('ACTIVE','EXTENDED','LIFETIME')
         AND EXISTS (SELECT 1 FROM publications WHERE id = ? AND status = 'REVOKED')`,
    ).bind(publicationId, publicationId));
  }
  const result = await env.DB.batch(statements);
  if (result[0]?.meta.changes !== 1) {
    return apiError(requestId, 409, "CONFLICT", "Publication state changed; retry");
  }
  const cleaned = await cleanupAssets(env, publicationId);
  await env.DB.prepare(
    `INSERT INTO audit_logs (
       id, actor_type, actor_id, action, entity_type, entity_id, request_id, metadata_json, created_at
     ) VALUES (?, 'CUSTOMER', ?, ?, 'publication', ?, ?, '{}', ?)`,
  ).bind(safeId(), customerId, revoke ? "publication.revoked" : "publication.unpublished",
    publicationId, requestId, now).run();
  if (!cleaned) return apiError(requestId, 503, "MEDIA_CLEANUP_PENDING", "Link is disabled; media cleanup will be retried");
  return jsonResponse({ status, lifecycle_revision: expectedLifecycle + 1 }, 200, requestId);
}

function removeAssetReference(templateId: string, data: TemplateData, assetId: string): TemplateData {
  const copy = structuredClone(data);
  const without = (items: unknown) => Array.isArray(items)
    ? items.filter((item) => !isRecord(item) || item.asset_id !== assetId)
    : items;
  if ((templateId === "our-universe" || templateId === "say-yes" || templateId === "love-letter") &&
      Array.isArray(copy.photos)) {
    copy.photos = without(copy.photos);
  } else if (templateId === "our-memories") {
    if (copy.coverImage === assetId) copy.coverImage = "";
    if (Array.isArray(copy.chapters)) {
      copy.chapters = copy.chapters.map((chapter) =>
        isRecord(chapter) ? { ...chapter, photos: without(chapter.photos) } : chapter);
    }
  }
  return copy;
}

async function revokeAssetConsent(
  env: Env,
  requestId: string,
  customerId: string,
  publicationId: string,
  assetId: string,
): Promise<Response> {
  const row = await loadOwnedPublication(env, customerId, publicationId);
  if (!row) return apiError(requestId, 404, "NOT_FOUND", "Publication not found");
  const consent = await env.DB.prepare(
    `SELECT id, derivative_key FROM publication_assets
     WHERE publication_id = ? AND asset_id = ? AND customer_id = ? AND revoked_at IS NULL`,
  ).bind(publicationId, assetId, customerId).first<{ id: string; derivative_key: string | null }>();
  if (!consent) return apiError(requestId, 404, "NOT_FOUND", "Publication consent not found");
  const snapshot = JSON.parse(row.snapshot_json) as { data: TemplateData };
  const data = removeAssetReference(row.template_id, snapshot.data, assetId);
  const now = nowIso();
  const updated = await env.DB.batch([
    env.DB.prepare(
      `UPDATE publications SET snapshot_json = ?, updated_at = ?,
       lifecycle_revision = lifecycle_revision + 1
       WHERE id = ? AND status <> 'REVOKED' AND lifecycle_revision = ?`,
    ).bind(JSON.stringify({ data }), now, publicationId, row.lifecycle_revision),
    env.DB.prepare(
      `UPDATE publication_assets SET revoked_at = ?, derivative_status = CASE
         WHEN derivative_key IS NULL THEN 'DELETED' ELSE 'CLEANUP_PENDING' END,
         updated_at = ? WHERE id = ? AND revoked_at IS NULL
         AND EXISTS (
           SELECT 1 FROM publications
           WHERE id = ? AND lifecycle_revision = ? AND status <> 'REVOKED'
         )`,
    ).bind(now, now, consent.id, publicationId, row.lifecycle_revision + 1),
  ]);
  if ((updated[0]?.meta.changes ?? 0) !== 1 || (updated[1]?.meta.changes ?? 0) !== 1) {
    return apiError(requestId, 409, "CONFLICT", "Publication state changed; reload before revoking consent");
  }
  if (consent.derivative_key && env.STORAGE) {
    try {
      await env.STORAGE.deletePublishedDerivative(consent.derivative_key);
      await env.DB.prepare(
        `UPDATE publication_assets SET derivative_key = NULL, derivative_status = 'DELETED',
           updated_at = ? WHERE id = ? AND derivative_key = ?`,
      ).bind(nowIso(), consent.id, consent.derivative_key).run();
    } catch (error) {
      console.error("Consent revocation media cleanup failed", {
        publication_id: publicationId,
        publication_asset_id: consent.id,
        error,
      });
      return apiError(requestId, 503, "MEDIA_CLEANUP_PENDING", "Image access is revoked; media cleanup is pending");
    }
  }
  await env.DB.prepare(
    `INSERT INTO audit_logs (
       id, actor_type, actor_id, action, entity_type, entity_id, request_id, metadata_json, created_at
     ) VALUES (?, 'CUSTOMER', ?, 'publication.asset_consent_revoked',
       'publication', ?, ?, ?, ?)`,
  ).bind(safeId(), customerId, publicationId, requestId, JSON.stringify({ asset_id: assetId }), now).run();
  return jsonResponse({
    consent_revoked: true,
    lifecycle_revision: row.lifecycle_revision + 1,
  }, 200, requestId);
}

async function updateSnapshot(
  request: Request,
  env: Env,
  requestId: string,
  customerId: string,
  publicationId: string,
  body: unknown,
): Promise<Response> {
  if (!isRecord(body) || Object.keys(body).length !== 3 ||
      !Number.isSafeInteger(body.expected_revision) || (body.expected_revision as number) < 1 ||
      !Number.isSafeInteger(body.expected_lifecycle_revision) ||
      (body.expected_lifecycle_revision as number) < 1) {
    return apiError(requestId, 400, "VALIDATION_ERROR", "Expected expected_revision, expected_lifecycle_revision and asset_consents");
  }
  const row = await loadOwnedPublication(env, customerId, publicationId);
  if (!row || !row.order_id) return apiError(requestId, 404, "NOT_FOUND", "Publication not found");
  if (row.status !== "UNPUBLISHED") {
    return apiError(requestId, 409, "UNPUBLISH_REQUIRED", "Unpublish the current version before preparing an update");
  }
  if (row.lifecycle_revision !== body.expected_lifecycle_revision) {
    return apiError(requestId, 409, "CONFLICT", "Publication state changed; reload before updating");
  }
  const order = await paidOrderForOwner(env, customerId, row.order_id);
  if (!order) return apiError(requestId, 422, "PAYMENT_NOT_VERIFIED", "The linked paid order is no longer eligible");
  if (order.design_current_revision !== body.expected_revision) {
    return apiError(requestId, 409, "CONFLICT", "Design revision changed; reload before updating");
  }
  const rawData = await designRevisionData(env, row.design_id, body.expected_revision as number);
  if (!rawData) return apiError(requestId, 409, "CONFLICT", "Design revision is unavailable");
  const validated = validateTemplateData(row.template_id, row.schema_version, JSON.parse(rawData));
  if (!validated.value) return apiError(requestId, 422, "VALIDATION_ERROR", "Design data is invalid", validated.fields);
  const references = assetReferences(row.template_id, validated.value);
  const consents = parseConsentList(body.asset_consents, references);
  if (!consents) return apiError(requestId, 422, "ASSET_CONSENT_REQUIRED", "Every selected photo requires explicit publication consent");
  if (!await validateOwnedAssets(env, order, references)) {
    return apiError(requestId, 422, "ASSET_UNAVAILABLE", "A selected image is unavailable");
  }
  const consentedIds = new Set(consents.map(({ assetId }) => assetId));
  const snapshotJson = JSON.stringify({ data: references.reduce((data, assetId) =>
    consentedIds.has(assetId) ? data : removeAssetReference(row.template_id, data, assetId),
  validated.value) });
  const priorAssets = await env.DB.prepare(
    "SELECT id, asset_id, derivative_key, revoked_at FROM publication_assets WHERE publication_id = ?",
  ).bind(publicationId).all<{
    id: string;
    asset_id: string;
    derivative_key: string | null;
    revoked_at: string | null;
  }>();
  const now = nowIso();
  const statements = [
    env.DB.prepare(
      `UPDATE publications SET snapshot_json = ?, published_revision = ?,
         lifecycle_revision = lifecycle_revision + 1, updated_at = ?
       WHERE id = ? AND status = 'UNPUBLISHED' AND lifecycle_revision = ?`,
    ).bind(snapshotJson, body.expected_revision as number, now,
      publicationId, body.expected_lifecycle_revision as number),
  ];
  for (const old of priorAssets.results) {
    if (!consentedIds.has(old.asset_id) || old.revoked_at) {
      statements.push(env.DB.prepare(
        `UPDATE publication_assets SET revoked_at = COALESCE(revoked_at, ?),
           derivative_status = CASE WHEN derivative_key IS NULL THEN 'DELETED' ELSE 'CLEANUP_PENDING' END,
           updated_at = ? WHERE id = ?
           AND EXISTS (
             SELECT 1 FROM publications
             WHERE id = ? AND lifecycle_revision = ? AND status = 'UNPUBLISHED'
               AND snapshot_json = ? AND published_revision = ?
           )`,
      ).bind(now, now, old.id, publicationId,
        (body.expected_lifecycle_revision as number) + 1, snapshotJson,
        body.expected_revision as number));
    }
  }
  for (const { assetId } of consents) {
    const prior = priorAssets.results.find((item) => item.asset_id === assetId);
    if (prior && !prior.revoked_at) continue;
    if (prior) {
      statements.push(env.DB.prepare(
        `UPDATE publication_assets SET consent_version = ?, consented_at = ?,
           revoked_at = NULL, derivative_key = NULL, derivative_status = 'PENDING', updated_at = ?
         WHERE id = ? AND EXISTS (
           SELECT 1 FROM publications
           WHERE id = ? AND lifecycle_revision = ? AND status = 'UNPUBLISHED'
             AND snapshot_json = ? AND published_revision = ?
         )`,
      ).bind(CONSENT_VERSION, now, now, prior.id, publicationId,
        (body.expected_lifecycle_revision as number) + 1, snapshotJson,
        body.expected_revision as number));
    } else {
      statements.push(env.DB.prepare(
        `INSERT INTO publication_assets (
           id, publication_id, asset_id, customer_id, consent_version, consented_at,
           derivative_status, created_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?
         WHERE EXISTS (
           SELECT 1 FROM publications
           WHERE id = ? AND lifecycle_revision = ? AND status = 'UNPUBLISHED'
             AND snapshot_json = ? AND published_revision = ?
         )`,
      ).bind(safeId(), publicationId, assetId, customerId, CONSENT_VERSION, now, now, now,
        publicationId, (body.expected_lifecycle_revision as number) + 1, snapshotJson,
        body.expected_revision as number));
    }
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO audit_logs (
         id, actor_type, actor_id, action, entity_type, entity_id, request_id, metadata_json, created_at
       )
       SELECT ?, 'CUSTOMER', ?, 'publication.snapshot_updated', 'publication', ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM publications
         WHERE id = ? AND lifecycle_revision = ? AND status = 'UNPUBLISHED'
           AND snapshot_json = ? AND published_revision = ?
       )`,
    ).bind(safeId(), customerId, publicationId, requestId,
      JSON.stringify({ revision: body.expected_revision }), now, publicationId,
      (body.expected_lifecycle_revision as number) + 1, snapshotJson,
      body.expected_revision as number),
  );
  const result = await env.DB.batch(statements);
  if ((result[0]?.meta.changes ?? 0) !== 1) return apiError(requestId, 409, "CONFLICT", "Publication state changed; reload");
  const cleaned = await cleanupAssets(env, publicationId);
  if (!cleaned) return apiError(requestId, 503, "MEDIA_CLEANUP_PENDING", "Update is saved but old media cleanup is pending");
  return jsonResponse({
    status: "UNPUBLISHED",
    lifecycle_revision: (body.expected_lifecycle_revision as number) + 1,
    design_revision: body.expected_revision,
  }, 200, requestId);
}

async function listCustomerWebsites(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  const required = await requireSession(request, env, requestId);
  if (required.response) return required.response;
  const ownerId = required.session!.customerId;
  const rows = await env.DB.prepare(
    `SELECT d.id AS design_id, d.template_id, d.schema_version, d.revision, d.data_json,
            t.title AS template_title,
            o.id AS order_id, o.order_reference, o.status AS order_status,
            p.status AS payment_status,
            pub.id AS publication_id, pub.slug, pub.status AS publication_status,
            pub.lifecycle_revision, pub.published_at, pub.expires_at,
            pub.published_revision, pub.activated_at,
            entitlement.status AS entitlement_status,
            entitlement.storage_plan_id, plan.title AS storage_plan_title,
            entitlement.starts_at AS entitlement_started_at,
            fj.status AS fulfillment_status
     FROM designs d
     JOIN templates t ON t.id = d.template_id
     LEFT JOIN orders o ON o.id = (
       SELECT o2.id FROM orders o2 WHERE o2.design_id = d.id AND o2.customer_id = d.customer_id
       ORDER BY o2.created_at DESC LIMIT 1
     )
     LEFT JOIN payments p ON p.order_id = o.id
     LEFT JOIN publications pub ON pub.design_id = d.id AND pub.renderer_version <> 'unsupported'
     LEFT JOIN storage_entitlements entitlement ON entitlement.id = (
       SELECT e.id FROM storage_entitlements e
       WHERE e.publication_id = pub.id ORDER BY e.created_at DESC LIMIT 1
     )
     LEFT JOIN storage_plans plan ON plan.id = entitlement.storage_plan_id
     LEFT JOIN fulfillment_jobs fj ON fj.order_id = o.id
     WHERE d.customer_id = ? AND d.status IN ('DRAFT','PUBLISHED')
     ORDER BY d.updated_at DESC LIMIT 100`,
  ).bind(ownerId).all<{
    design_id: string;
    template_id: string;
    schema_version: number;
    revision: number;
    data_json: string;
    template_title: string;
    order_id: string | null;
    order_reference: string | null;
    order_status: string | null;
    payment_status: string | null;
    publication_id: string | null;
    slug: string | null;
    publication_status: string | null;
    lifecycle_revision: number | null;
    published_at: string | null;
    expires_at: string | null;
    published_revision: number | null;
    activated_at: string | null;
    entitlement_status: string | null;
    storage_plan_id: string | null;
    storage_plan_title: string | null;
    entitlement_started_at: string | null;
    fulfillment_status: string | null;
  }>();
  const entitlementRows = await env.DB.prepare(
    `SELECT e.publication_id, e.order_id, e.storage_plan_id, p.title AS storage_plan_title,
            e.duration_months, e.activated_at, e.starts_at, e.previous_expires_at,
            e.expires_at, e.status, e.created_at
     FROM storage_entitlements e
     JOIN publications pub ON pub.id = e.publication_id
     JOIN designs d ON d.id = pub.design_id AND d.customer_id = ?
     JOIN storage_plans p ON p.id = e.storage_plan_id
     ORDER BY e.created_at DESC LIMIT 500`,
  ).bind(ownerId).all<{
    publication_id: string;
    order_id: string;
    storage_plan_id: string;
    storage_plan_title: string;
    duration_months: number | null;
    activated_at: string;
    starts_at: string;
    previous_expires_at: string | null;
    expires_at: string | null;
    status: string;
    created_at: string;
  }>();
  const entitlementsByPublication = new Map<string, typeof entitlementRows.results>();
  for (const entitlement of entitlementRows.results) {
    const history = entitlementsByPublication.get(entitlement.publication_id) ?? [];
    history.push(entitlement);
    entitlementsByPublication.set(entitlement.publication_id, history);
  }
  const consentRows = await env.DB.prepare(
    `SELECT pa.publication_id, pa.asset_id
     FROM publication_assets pa
     JOIN publications pub ON pub.id = pa.publication_id
     JOIN designs d ON d.id = pub.design_id AND d.customer_id = ?
     WHERE pa.revoked_at IS NULL`,
  ).bind(ownerId).all<{ publication_id: string; asset_id: string }>();
  const consentedByPublication = new Map<string, string[]>();
  for (const consent of consentRows.results) {
    const list = consentedByPublication.get(consent.publication_id) ?? [];
    list.push(consent.asset_id);
    consentedByPublication.set(consent.publication_id, list);
  }
  const origin = new URL(request.url).origin;
  return jsonResponse({
    websites: rows.results.map((row) => ({
      ...row,
      public_url: row.slug ? `${origin}/p/${encodeURIComponent(row.slug)}` : null,
      photo_asset_ids: assetReferences(row.template_id,
        JSON.parse(row.data_json) as TemplateData),
      storage_plan: row.storage_plan_id ? {
        id: row.storage_plan_id,
        title: row.storage_plan_title,
        status: row.entitlement_status,
        activated_at: row.activated_at,
        starts_at: row.entitlement_started_at,
        expires_at: row.expires_at,
      } : null,
      renewal_history: row.publication_id
        ? entitlementsByPublication.get(row.publication_id) ?? []
        : [],
      consented_asset_ids: row.publication_id
        ? consentedByPublication.get(row.publication_id) ?? []
        : [],
      slug: undefined,
    })),
  }, 200, requestId);
}

async function applyStorageRenewal(
  env: Env,
  orderId: string,
  customerId: string,
  publicationId: string,
): Promise<void> {
  const [publication, order, planItem] = await Promise.all([
    env.DB.prepare(
      `SELECT id, design_id, order_id, status, lifecycle_revision, expires_at,
              retention_delete_after_at
       FROM publications WHERE id = ? AND renderer_version <> 'unsupported'`,
    ).bind(publicationId).first<{
      id: string;
      design_id: string;
      order_id: string | null;
      status: string;
      lifecycle_revision: number;
      expires_at: string | null;
      retention_delete_after_at: string | null;
    }>(),
    env.DB.prepare("SELECT paid_at FROM orders WHERE id = ? AND customer_id = ? AND status = 'FULFILLING'")
      .bind(orderId, customerId).first<{ paid_at: string }>(),
    env.DB.prepare(
      `SELECT metadata_json FROM order_items
       WHERE order_id = ? AND item_type = 'ADD_ON'
         AND json_extract(metadata_json, '$.kind') = 'STORAGE_PLAN'`,
    ).bind(orderId).first<{ metadata_json: string }>(),
  ]);
  if (!publication || publication.status === "REVOKED" ||
      !order?.paid_at || !planItem ||
      publication.retention_delete_after_at &&
        publication.retention_delete_after_at <= order.paid_at) {
    throw new Error("RENEWAL_UNAVAILABLE");
  }
  const verified = await paidOrderForOwner(env, customerId, orderId);
  if (!verified || verified.design_id !== publication.design_id) throw new Error("PAYMENT_NOT_VERIFIED");
  const item = JSON.parse(planItem.metadata_json) as {
    storage_plan_id?: unknown;
    duration_months?: unknown;
    lifetime?: unknown;
  };
  if (typeof item.storage_plan_id !== "string" ||
      (typeof item.duration_months !== "number" && item.duration_months !== null) ||
      typeof item.lifetime !== "boolean" ||
      (item.lifetime && item.duration_months !== null) ||
      (!item.lifetime && (!Number.isSafeInteger(item.duration_months) || (item.duration_months as number) < 1))) {
    throw new Error("STORAGE_PLAN_SNAPSHOT_INVALID");
  }

  let entitlement = await env.DB.prepare(
    `SELECT expires_at, previous_expires_at, starts_at
     FROM storage_entitlements WHERE order_id = ?`,
  ).bind(orderId).first<{
    expires_at: string | null;
    previous_expires_at: string | null;
    starts_at: string;
  }>();
  if (!entitlement) {
    const nowTime = Date.parse(order.paid_at);
    if (!Number.isFinite(nowTime)) throw new Error("PAYMENT_ACTIVATION_INVALID");
    const previousExpiry = publication.expires_at;
    const activeExpiry = previousExpiry && Date.parse(previousExpiry) > nowTime
      ? new Date(previousExpiry)
      : new Date(nowTime);
    const expiry = entitlementExpiry({
      id: item.storage_plan_id,
      durationMonths: item.duration_months,
      lifetime: item.lifetime,
    }, activeExpiry);
    const startsAt = activeExpiry.toISOString();
    const createdAt = nowIso();
    const nextStatus = item.lifetime ? "LIFETIME" : "ACTIVE";
    const update = await env.DB.batch([
      env.DB.prepare(
        `UPDATE publications
         SET expires_at = ?, status = CASE WHEN status = 'EXPIRED' THEN 'UNPUBLISHED' ELSE status END,
             retention_delete_after_at = NULL, lifecycle_revision = lifecycle_revision + 1,
             updated_at = ?
         WHERE id = ? AND status IN ('PUBLISHED','UNPUBLISHED','EXPIRED')
           AND lifecycle_revision = ? AND expires_at IS ?
           AND retention_delete_after_at IS ?`,
      ).bind(expiry?.toISOString() ?? null, createdAt, publicationId,
        publication.lifecycle_revision, publication.expires_at,
        publication.retention_delete_after_at),
      env.DB.prepare(
        `UPDATE storage_entitlements SET status = 'EXTENDED'
         WHERE publication_id = ? AND status IN ('ACTIVE','EXPIRED')
           AND EXISTS (
             SELECT 1 FROM publications
             WHERE id = ? AND lifecycle_revision = ? AND expires_at IS ?
           )`,
      ).bind(publicationId, publicationId, publication.lifecycle_revision + 1,
        expiry?.toISOString() ?? null),
      env.DB.prepare(
        `INSERT INTO storage_entitlements (
           id, publication_id, order_id, storage_plan_id, duration_months,
           activated_at, starts_at, previous_expires_at, expires_at, status, created_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM publications
           WHERE id = ? AND lifecycle_revision = ? AND expires_at IS ?
         )
         ON CONFLICT(order_id) DO NOTHING`,
      ).bind(safeId(), publicationId, orderId, item.storage_plan_id,
        item.duration_months, order.paid_at, startsAt, previousExpiry,
        expiry?.toISOString() ?? null, nextStatus, createdAt, publicationId,
        publication.lifecycle_revision + 1, expiry?.toISOString() ?? null),
    ]);
    if (update[0]?.meta.changes !== 1) throw new Error("RENEWAL_STATE_CHANGED");
    entitlement = {
      expires_at: expiry?.toISOString() ?? null,
      previous_expires_at: previousExpiry,
      starts_at: startsAt,
    };
  }

  const current = await env.DB.prepare(
    `SELECT id, lifecycle_revision, status FROM publications WHERE id = ?`,
  ).bind(publicationId).first<{ id: string; lifecycle_revision: number; status: string }>();
  if (!current) throw new Error("RENEWAL_UNAVAILABLE");
  if (current.status !== "PUBLISHED") {
    const request = new Request(`${env.APP_ORIGIN ?? "https://crushify.local"}/api/v1/publications`);
    const published = await publish(
      request, env, crypto.randomUUID(), customerId, current.id, current.lifecycle_revision,
    );
    if (!published.ok) {
      const body = await published.json() as { error?: { code?: string } };
      throw new Error(body.error?.code ?? "RENEWAL_PUBLISH_FAILED");
    }
  }
}

export async function handleFulfillmentForOrder(
  env: Env,
  orderId: string,
): Promise<{ completed: boolean; retryable: boolean }> {
  const job = await env.DB.prepare(
    `SELECT status FROM fulfillment_jobs WHERE order_id = ?`,
  ).bind(orderId).first<{ status: string }>();
  if (!job || job.status === "COMPLETED") return { completed: job?.status === "COMPLETED", retryable: false };
  const now = nowIso();
  const claimed = await env.DB.prepare(
    `UPDATE fulfillment_jobs SET status = 'PROCESSING', attempts = attempts + 1,
       started_at = ?, updated_at = ?, last_error_code = NULL
     WHERE order_id = ? AND (
       status IN ('PENDING','FAILED') OR
       (status = 'PROCESSING' AND updated_at <= ?)
     )`,
  ).bind(now, now, orderId, new Date(Date.now() - 5 * 60_000).toISOString()).run();
  if (claimed.meta.changes !== 1) return { completed: false, retryable: true };

  let customerId: string | null = null;
  try {
    const order = await env.DB.prepare(
      `SELECT customer_id, status, renewal_publication_id
       FROM orders WHERE id = ? AND status IN ('PAID','FULFILLING')`,
    ).bind(orderId).first<{
      customer_id: string;
      status: string;
      renewal_publication_id: string | null;
    }>();
    if (!order) throw new Error("PAID_ORDER_UNAVAILABLE");
    customerId = order.customer_id;
    await env.DB.prepare(
      `UPDATE orders SET status = 'FULFILLING', updated_at = ?
       WHERE id = ? AND status IN ('PAID','FULFILLING')`,
    ).bind(nowIso(), orderId).run();

    if (order.renewal_publication_id) {
      await applyStorageRenewal(env, orderId, customerId, order.renewal_publication_id);
    } else {
    const existing = await env.DB.prepare(
      `SELECT id, lifecycle_revision, status FROM publications WHERE order_id = ?`,
    ).bind(orderId).first<{ id: string; lifecycle_revision: number; status: string }>();
    let publication = existing;
    if (!publication) {
      const eligible = await paidOrderForOwner(env, customerId, orderId);
      if (!eligible) throw new Error("PAYMENT_NOT_VERIFIED");
      const item = await env.DB.prepare(
        `SELECT metadata_json FROM order_items
         WHERE order_id = ? AND item_type = 'ADD_ON'
           AND json_extract(metadata_json, '$.kind') = 'STORAGE_PLAN'`,
      ).bind(orderId).first<{ metadata_json: string }>();
      if (!item) throw new Error("STORAGE_PLAN_SNAPSHOT_MISSING");
      const snapshot = JSON.parse(item.metadata_json) as { asset_consents?: unknown };
      const request = new Request(`${env.APP_ORIGIN ?? "https://crushify.local"}/api/v1/publications`);
      const created = await insertPublication(request, env, crypto.randomUUID(), customerId, {
        order_id: orderId,
        expected_revision: eligible.design_current_revision,
        asset_consents: snapshot.asset_consents ?? [],
      });
      if (created.status !== 201) {
        const body = await created.json() as { error?: { code?: string } };
        throw new Error(body.error?.code ?? "PUBLICATION_CREATE_FAILED");
      }
      publication = await env.DB.prepare(
        `SELECT id, lifecycle_revision, status FROM publications WHERE order_id = ?`,
      ).bind(orderId).first<{ id: string; lifecycle_revision: number; status: string }>();
    }
    if (!publication) throw new Error("PUBLICATION_CREATE_FAILED");
    if (publication.status !== "PUBLISHED") {
      const request = new Request(`${env.APP_ORIGIN ?? "https://crushify.local"}/api/v1/publications`);
      const published = await publish(
        request, env, crypto.randomUUID(), customerId, publication.id, publication.lifecycle_revision,
      );
      if (!published.ok) {
        const body = await published.json() as { error?: { code?: string } };
        throw new Error(body.error?.code ?? "PUBLICATION_FAILED");
      }
    }
    }

    const publishedAt = nowIso();
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO storage_entitlements (
           id, publication_id, order_id, storage_plan_id, duration_months,
           activated_at, starts_at, previous_expires_at, expires_at, status, created_at
         )
         SELECT ?, p.id, o.id, sp.id, json_extract(i.metadata_json, '$.duration_months'),
           o.paid_at, o.paid_at, NULL, p.expires_at,
           CASE WHEN json_extract(i.metadata_json, '$.lifetime') = 1 THEN 'LIFETIME' ELSE 'ACTIVE' END,
           ?
         FROM publications p
         JOIN orders o ON o.id = p.order_id
         JOIN order_items i ON i.order_id = o.id AND i.item_type = 'ADD_ON'
           AND json_extract(i.metadata_json, '$.kind') = 'STORAGE_PLAN'
         JOIN storage_plans sp ON sp.id = i.reference_id
         WHERE o.id = ? AND o.renewal_publication_id IS NULL AND p.status = 'PUBLISHED'
         ON CONFLICT(order_id) DO NOTHING`,
      ).bind(safeId(), publishedAt, orderId),
      env.DB.prepare(
        `UPDATE orders SET status = 'FULFILLED', updated_at = ?
         WHERE id = ? AND status = 'FULFILLING'
           AND EXISTS (
             SELECT 1 FROM payments payment
             JOIN payment_webhook_events e ON e.provider = payment.provider
               AND e.event_id = payment.provider_payment_id AND e.outcome = 'PROCESSED'
             JOIN publications p ON p.status = 'PUBLISHED'
               AND (p.order_id = orders.id OR p.id = orders.renewal_publication_id)
             WHERE payment.order_id = orders.id AND payment.provider = 'SEPAY'
               AND payment.status = 'SUCCEEDED' AND payment.succeeded_at IS NOT NULL
               AND payment.provider_payment_id IS NOT NULL AND payment.provider_payment_id <> ''
               AND payment.review_required = 0 AND payment.amount_minor = orders.total_minor
               AND payment.currency = orders.currency
           )`,
      ).bind(publishedAt, orderId),
      env.DB.prepare(
        `UPDATE fulfillment_jobs SET status = 'COMPLETED', completed_at = ?, updated_at = ?,
           last_error_code = NULL
         WHERE order_id = ? AND status = 'PROCESSING'`,
      ).bind(publishedAt, publishedAt, orderId),
      env.DB.prepare(
        `INSERT INTO audit_logs (
           id, actor_type, actor_id, action, entity_type, entity_id, request_id, metadata_json, created_at
         ) VALUES (?, 'SYSTEM', NULL, 'order.fulfilled', 'order', ?, NULL, '{}', ?)`,
      ).bind(safeId(), orderId, publishedAt),
    ]);
    if (results[1]?.meta.changes !== 1 || results[2]?.meta.changes !== 1) {
      throw new Error("FULFILLMENT_FINALIZATION_FAILED");
    }
    return { completed: true, retryable: false };
  } catch (error) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE fulfillment_jobs SET status = 'FAILED', last_error_code = ?,
           updated_at = ? WHERE order_id = ? AND status = 'PROCESSING'`,
      ).bind(error instanceof Error ? error.message.slice(0, 80) : "FULFILLMENT_FAILED", nowIso(), orderId),
      env.DB.prepare(
        `UPDATE orders SET status = 'FULFILLING', updated_at = ?
         WHERE id = ? AND status IN ('PAID','FULFILLING')`,
      ).bind(nowIso(), orderId),
    ]);
    console.error("Order fulfillment failed", {
      order_id: orderId,
      customer_id: customerId,
      error: error instanceof Error ? error.message : "Unknown fulfillment failure",
    });
    return { completed: false, retryable: true };
  }
}

export async function recoverPendingFulfillments(
  env: Env,
  limit = 50,
): Promise<{ attempted: number; completed: number; retryable: number }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Fulfillment recovery batch size must be between 1 and 100");
  }
  const rows = await env.DB.prepare(
    `SELECT order_id FROM fulfillment_jobs
     WHERE status IN ('PENDING','FAILED') OR
       (status = 'PROCESSING' AND updated_at <= ?)
     ORDER BY created_at LIMIT ?`,
  ).bind(new Date(Date.now() - 5 * 60_000).toISOString(), limit).all<{ order_id: string }>();
  let completed = 0;
  let retryable = 0;
  for (const row of rows.results) {
    const result = await handleFulfillmentForOrder(env, row.order_id);
    if (result.completed) completed++;
    else if (result.retryable) retryable++;
  }
  return { attempted: rows.results.length, completed, retryable };
}

async function publicPublication(
  env: Env,
  requestId: string,
  slug: string,
): Promise<Response> {
  if (!SLUG_PATTERN.test(slug)) return apiError(requestId, 404, "NOT_FOUND", "Website not found");
  const now = nowIso();
  const row = await env.DB.prepare(
    `SELECT p.id, p.template_id, p.schema_version, p.renderer_version,
            p.snapshot_json, p.status, p.expires_at
     FROM publications p
     JOIN orders o ON o.id = p.order_id AND o.design_id = p.design_id
       AND o.order_type = 'SELF_SERVICE' AND o.status IN ('PAID','FULFILLED')
       AND o.paid_at IS NOT NULL AND o.payment_review_required = 0
     JOIN designs d ON d.id = o.design_id AND d.customer_id = o.customer_id
       AND d.template_id = p.template_id AND d.schema_version = p.schema_version
       AND d.status = 'DRAFT' AND p.published_revision <= d.revision
     JOIN order_items i ON i.order_id = o.id AND i.item_type = 'TEMPLATE_LICENSE'
       AND i.reference_id = p.template_id
       AND CAST(json_extract(i.metadata_json, '$.schema_version') AS INTEGER) = p.schema_version
     JOIN payments payment ON payment.order_id = o.id AND payment.provider = 'SEPAY'
       AND payment.status = 'SUCCEEDED' AND payment.provider_payment_id IS NOT NULL
       AND payment.provider_payment_id <> '' AND payment.succeeded_at IS NOT NULL
       AND payment.review_required = 0 AND payment.amount_minor = o.total_minor
       AND payment.currency = o.currency
       AND NOT EXISTS (
         SELECT 1 FROM order_items pricing_item
         WHERE pricing_item.order_id = o.id AND pricing_item.item_type = 'ADD_ON'
           AND json_extract(pricing_item.metadata_json, '$.pricing_snapshot.total_minor') IS NOT NULL
           AND CAST(json_extract(pricing_item.metadata_json, '$.pricing_snapshot.total_minor') AS INTEGER) <> o.total_minor
       )
     JOIN payment_webhook_events e ON e.provider = payment.provider
       AND e.event_id = payment.provider_payment_id AND e.outcome = 'PROCESSED'
     JOIN templates t ON t.id = p.template_id AND t.status = 'ACTIVE'
     JOIN template_versions v ON v.template_id = p.template_id
       AND v.schema_version = p.schema_version AND v.status = 'ACTIVE'
     WHERE p.slug_hash = ? AND p.renderer_version <> 'unsupported'`,
  ).bind(await sha256(slug)).first<{
    id: string;
    template_id: string;
    schema_version: number;
    renderer_version: string;
    snapshot_json: string;
    status: string;
    expires_at: string | null;
  }>();
  if (!row) return apiError(requestId, 404, "NOT_FOUND", "Website not found");
  if (row.status !== "PUBLISHED") {
    return apiError(requestId, 410, "PUBLICATION_UNAVAILABLE", "This website is no longer available");
  }
  if (row.expires_at && row.expires_at <= now) {
    const retentionDays = Number(env.DATA_RETENTION_DAYS ?? 30);
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
      throw new Error("DATA_RETENTION_DAYS must be between 1 and 3650");
    }
    const retentionUntil = new Date(Date.parse(now) + retentionDays * 86400_000).toISOString();
    await env.DB.prepare(
      `UPDATE publications SET status = 'EXPIRED', expired_at = COALESCE(expired_at, ?),
         retention_delete_after_at = COALESCE(retention_delete_after_at, ?),
         lifecycle_revision = lifecycle_revision + 1, updated_at = ?
       WHERE id = ? AND status = 'PUBLISHED' AND expires_at <= ?`,
    ).bind(now, retentionUntil, now, row.id, now).run();
    await env.DB.prepare(
      `UPDATE storage_entitlements SET status = 'EXPIRED'
       WHERE publication_id = ? AND status = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at <= ?`,
    ).bind(row.id, now).run();
    return apiError(requestId, 410, "PUBLICATION_EXPIRED", "This website has expired");
  }
  const renderer = TEMPLATE_RENDERERS[row.template_id as TemplateId];
  if (!renderer || renderer.rendererVersion !== row.renderer_version ||
      !supportsTemplateVersion(row.template_id, row.schema_version)) {
    return apiError(requestId, 503, "RENDERER_UNAVAILABLE", "This website version is no longer supported");
  }
  const snapshot = JSON.parse(row.snapshot_json) as { data?: unknown };
  const validated = validateTemplateData(row.template_id, row.schema_version, snapshot.data);
  if (!validated.value) return apiError(requestId, 503, "PUBLICATION_INVALID", "This website could not be loaded");
  return jsonResponse({
    template_id: row.template_id,
    schema_version: row.schema_version,
    renderer_version: row.renderer_version,
    data: publicTemplateData(row.template_id, validated.value, (assetId) =>
      `/api/v1/publications/${encodeURIComponent(slug)}/assets/${encodeURIComponent(assetId)}`),
  }, 200, requestId, {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
  });
}

async function publicAsset(
  env: Env,
  requestId: string,
  slug: string,
  assetId: string,
): Promise<Response> {
  if (!env.STORAGE || !SLUG_PATTERN.test(slug) || !ID_PATTERN.test(assetId)) {
    return apiError(requestId, 404, "NOT_FOUND", "Image not found");
  }
  const row = await env.DB.prepare(
    `SELECT pa.derivative_key, a.media_type, a.byte_size
     FROM publications p
     JOIN orders o ON o.id = p.order_id AND o.design_id = p.design_id
       AND o.order_type = 'SELF_SERVICE' AND o.status IN ('PAID','FULFILLED')
       AND o.paid_at IS NOT NULL AND o.payment_review_required = 0
     JOIN designs d ON d.id = o.design_id AND d.customer_id = o.customer_id
       AND d.template_id = p.template_id AND d.schema_version = p.schema_version
       AND d.status = 'DRAFT' AND p.published_revision <= d.revision
     JOIN order_items i ON i.order_id = o.id AND i.item_type = 'TEMPLATE_LICENSE'
       AND i.reference_id = p.template_id
       AND CAST(json_extract(i.metadata_json, '$.schema_version') AS INTEGER) = p.schema_version
     JOIN payments payment ON payment.order_id = o.id AND payment.provider = 'SEPAY'
       AND payment.status = 'SUCCEEDED' AND payment.provider_payment_id IS NOT NULL
       AND payment.provider_payment_id <> '' AND payment.succeeded_at IS NOT NULL
       AND payment.review_required = 0 AND payment.amount_minor = o.total_minor
       AND payment.currency = o.currency
       AND NOT EXISTS (
         SELECT 1 FROM order_items pricing_item
         WHERE pricing_item.order_id = o.id AND pricing_item.item_type = 'ADD_ON'
           AND json_extract(pricing_item.metadata_json, '$.pricing_snapshot.total_minor') IS NOT NULL
           AND CAST(json_extract(pricing_item.metadata_json, '$.pricing_snapshot.total_minor') AS INTEGER) <> o.total_minor
       )
     JOIN payment_webhook_events e ON e.provider = payment.provider
       AND e.event_id = payment.provider_payment_id AND e.outcome = 'PROCESSED'
     JOIN templates t ON t.id = p.template_id AND t.status = 'ACTIVE'
     JOIN template_versions v ON v.template_id = p.template_id
       AND v.schema_version = p.schema_version AND v.status = 'ACTIVE'
     JOIN publication_assets pa ON pa.publication_id = p.id AND pa.asset_id = ?
       AND pa.customer_id = o.customer_id AND pa.revoked_at IS NULL
       AND pa.derivative_status = 'READY'
     JOIN assets a ON a.id = pa.asset_id AND a.customer_id = o.customer_id
       AND a.status = 'READY'
     WHERE p.slug_hash = ? AND p.status = 'PUBLISHED'
       AND (p.expires_at IS NULL OR p.expires_at > ?)`,
  ).bind(assetId, await sha256(slug), nowIso()).first<{
    derivative_key: string | null;
    media_type: string;
    byte_size: number;
  }>();
  if (!row?.derivative_key) return apiError(requestId, 404, "NOT_FOUND", "Image not found");
  const object = await env.STORAGE.getPublishedDerivative(row.derivative_key);
  if (!object || object.size !== row.byte_size || object.contentType !== row.media_type) {
    await object?.body?.cancel();
    return apiError(requestId, 404, "NOT_FOUND", "Image not found");
  }
  return new Response(object.body, {
    headers: {
      "Content-Type": row.media_type,
      "Content-Length": String(row.byte_size),
      "Content-Disposition": "inline; filename=\"crushify-photo\"",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-Request-ID": requestId,
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function handlePublicationRoutes(
  request: Request,
  env: Env,
  path: string,
  requestId: string,
): Promise<Response | null> {
  const publicAssetMatch = path.match(/^\/api\/v1\/publications\/(g[A-Za-z0-9_-]{20,40})\/assets\/([0-9a-f-]{36})$/i);
  if (publicAssetMatch) {
    if (request.method !== "GET") return apiError(requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
    return publicAsset(env, requestId, publicAssetMatch[1], publicAssetMatch[2]);
  }
  const publicMatch = path.match(/^\/api\/v1\/publications\/(g[A-Za-z0-9_-]{20,40})$/);
  if (publicMatch) {
    if (request.method !== "GET") return apiError(requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
    return publicPublication(env, requestId, publicMatch[1]);
  }
  if (path === "/api/v1/publications") {
    if (request.method === "GET") return listCustomerWebsites(request, env, requestId);
    if (request.method !== "POST") return apiError(requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
    const unavailable = await requireLocalPublishing(requestId, env);
    if (unavailable) return unavailable;
    const required = await requireSession(request, env, requestId);
    if (required.response) return required.response;
    const csrf = await requireCsrf(request, env, required.session!, requestId);
    if (csrf) return csrf;
    const parsed = await readJson(request, requestId);
    if (parsed.response) return parsed.response;
    if (!isRecord(parsed.value)) return apiError(requestId, 400, "VALIDATION_ERROR", "Request body must be an object");
    return insertPublication(request, env, requestId, required.session!.customerId, parsed.value);
  }
  const match = path.match(/^\/api\/v1\/publications\/([0-9a-f-]{36})(?:\/(publish|republish|unpublish|revoke|assets\/([0-9a-f-]{36})\/consent))?$/i);
  if (!match) return null;
  const [, publicationId, action, assetId] = match;
  const unavailable = await requireLocalPublishing(requestId, env);
  if (unavailable) return unavailable;
  const required = await requireSession(request, env, requestId);
  if (required.response) return required.response;
  const customerId = required.session!.customerId;
  if (request.method === "GET" && !action) {
    const row = await loadOwnedPublication(env, customerId, publicationId);
    if (!row) return apiError(requestId, 404, "NOT_FOUND", "Publication not found");
    return jsonResponse({
      publication_id: row.id,
      design_id: row.design_id,
      template_id: row.template_id,
      schema_version: row.schema_version,
      design_revision: row.published_revision,
      status: row.status,
      lifecycle_revision: row.lifecycle_revision,
      url: row.slug ? urlForPublication(request, row.slug) : null,
      expires_at: row.expires_at,
    }, 200, requestId);
  }
  if (request.method !== "POST" && request.method !== "PATCH") {
    return apiError(requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
  }
  const csrf = await requireCsrf(request, env, required.session!, requestId);
  if (csrf) return csrf;
  const parsed = await readJson(request, requestId);
  if (parsed.response) return parsed.response;
  if (action?.startsWith("assets/")) {
    if (request.method !== "POST") return apiError(requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
    if (!assetId) return apiError(requestId, 404, "NOT_FOUND", "Publication asset not found");
    return revokeAssetConsent(env, requestId, customerId, publicationId, assetId);
  }
  if (action === "publish" || action === "republish") {
    if (request.method !== "POST" || !isRecord(parsed.value) ||
        Object.keys(parsed.value).length !== 1 ||
        !Number.isSafeInteger(parsed.value.expected_lifecycle_revision) ||
        (parsed.value.expected_lifecycle_revision as number) < 1) {
      return apiError(requestId, 400, "VALIDATION_ERROR", "Expected expected_lifecycle_revision");
    }
    return publish(request, env, requestId, customerId, publicationId,
      parsed.value.expected_lifecycle_revision as number);
  }
  if (action === "unpublish" || action === "revoke") {
    if (request.method !== "POST" || !isRecord(parsed.value) ||
        Object.keys(parsed.value).length !== 1 ||
        !Number.isSafeInteger(parsed.value.expected_lifecycle_revision) ||
        (parsed.value.expected_lifecycle_revision as number) < 1) {
      return apiError(requestId, 400, "VALIDATION_ERROR", "Expected expected_lifecycle_revision");
    }
    return unpublishOrRevoke(request, env, requestId, customerId, publicationId,
      parsed.value.expected_lifecycle_revision as number, action === "revoke");
  }
  if (request.method === "PATCH") {
    return updateSnapshot(request, env, requestId, customerId, publicationId, parsed.value);
  }
  return apiError(requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
}

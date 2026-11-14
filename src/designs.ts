import { requireCsrf, requireSession } from "./auth.ts";
import { logSafeError } from "./logging.ts";
import { cleanupAssets } from "./publications.ts";
import { apiError, jsonResponse, nowIso, randomToken, readJson, safeId, sha256 } from "./http.ts";
import { isJsonWithinLimit } from "./universe.ts";
import {
  assetReferences,
  publicTemplateData,
  supportsTemplateVersion,
  TEMPLATE_RENDERERS,
  validateTemplateData,
  type TemplateData,
} from "./template-registry.ts";
import type { Env } from "./types.ts";

const TOKEN_SECONDS = 15 * 60;

const designHasProtectedHistory = `(
  EXISTS (
    SELECT 1 FROM orders o
    WHERE o.design_id = designs.id
      AND o.status IN ('PAID','FULFILLING','FULFILLED','REFUND_PENDING','REFUNDED')
  ) OR EXISTS (
    SELECT 1 FROM payments payment
    JOIN orders o ON o.id = payment.order_id
    WHERE o.design_id = designs.id
      AND payment.status IN ('SUCCEEDED','REFUND_PENDING','REFUNDED')
  ) OR EXISTS (
    SELECT 1 FROM publications publication WHERE publication.design_id = designs.id
  ) OR EXISTS (
    SELECT 1 FROM storage_entitlements entitlement
    JOIN publications publication ON publication.id = entitlement.publication_id
    WHERE publication.design_id = designs.id
  )
)`;

const noDesignDeletionInProgress = `NOT EXISTS (
  SELECT 1 FROM orders o
  WHERE o.design_id = designs.id
    AND o.status IN ('DRAFT','AWAITING_PAYMENT','PAID','FULFILLING','REFUND_PENDING')
) AND NOT EXISTS (
  SELECT 1 FROM fulfillment_jobs job
  JOIN orders o ON o.id = job.order_id
  WHERE o.design_id = designs.id
    AND job.status IN ('PENDING','PROCESSING','FAILED','MANUAL_REVIEW')
)`;

const noActiveUploadInProgress = `NOT EXISTS (
  SELECT 1 FROM asset_upload_sessions upload
  JOIN assets asset ON asset.id = upload.asset_id
  WHERE asset.design_id = designs.id
    AND upload.status = 'UPLOADING' AND upload.lease_expires_at > ?
)`;

const noSharedPublicationAsset = `NOT EXISTS (
  SELECT 1 FROM assets source
  JOIN publication_assets asset_ref ON asset_ref.asset_id = source.id
    AND asset_ref.revoked_at IS NULL
  JOIN publications other ON other.id = asset_ref.publication_id
  WHERE source.design_id = designs.id
    AND other.design_id <> designs.id
    AND (
      other.status IN ('PUBLISHED','UNPUBLISHED') OR
      (other.status IN ('EXPIRED','REVOKED') AND
        other.retention_delete_after_at > ?)
    )
)`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function validateAssetReferences(
  env: Env,
  ownerId: string,
  designId: string,
  templateId: string,
  data: TemplateData,
): Promise<boolean> {
  const ids = assetReferences(templateId, data);
  if (new Set(ids).size !== ids.length) return false;
  if (!ids.length) return true;
  const placeholders = ids.map(() => "?").join(",");
  const result = await env.DB.prepare(
    `SELECT id FROM assets
     WHERE customer_id = ? AND design_id = ? AND status = 'READY'
       AND id IN (${placeholders})`,
  ).bind(ownerId, designId || null, ...ids).all<{ id: string }>();
  return result.results.length === ids.length;
}

type CreatePayload =
  | { error: string }
  | { templateId: string; schemaVersion: number; data: unknown };

function validateCreatePayload(value: unknown): CreatePayload {
  if (!isRecord(value)) return { error: "Request body must be an object" };
  const allowed = new Set(["template_id", "schema_version", "data"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return { error: "Unsupported request field" };
  if (typeof value.template_id !== "string" ||
      !Object.hasOwn(TEMPLATE_RENDERERS, value.template_id)) return { error: "Unsupported template" };
  const renderer = TEMPLATE_RENDERERS[value.template_id as keyof typeof TEMPLATE_RENDERERS];
  if (typeof value.schema_version !== "number" ||
      value.schema_version !== renderer.schemaVersion) return { error: "Unsupported schema version" };
  return {
    templateId: value.template_id,
    schemaVersion: value.schema_version,
    data: value.data,
  };
}

function parseDesignData(templateId: string, schemaVersion: number, value: unknown) {
  const validated = validateTemplateData(templateId, schemaVersion, value);
  if (!validated.value) return { fields: validated.fields };
  if (!isJsonWithinLimit(validated.value, 48 * 1024)) return { fields: { data: "Design data is too large" } };
  return { value: validated.value };
}

async function updateDesign(
  request: Request,
  env: Env,
  requestId: string,
  designId: string,
): Promise<Response> {
  const required = await requireSession(request, env, requestId);
  if (required.response) return required.response;
  const csrf = await requireCsrf(request, env, required.session!, requestId);
  if (csrf) return csrf;
  const parsed = await readJson(request, requestId);
  if (parsed.response) return parsed.response;
  if (!isRecord(parsed.value) || Object.keys(parsed.value).length !== 3 ||
      typeof parsed.value.expected_revision !== "number" ||
      typeof parsed.value.schema_version !== "number" || !Object.hasOwn(parsed.value, "data")) {
    return apiError(requestId, 400, "VALIDATION_ERROR", "Expected schema_version, expected_revision and data");
  }
  const expectedRevision = parsed.value.expected_revision;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    return apiError(requestId, 400, "VALIDATION_ERROR", "Invalid expected revision");
  }
  const design = await env.DB.prepare(
    `SELECT template_id, schema_version FROM designs
     WHERE id = ? AND customer_id = ? AND status = 'DRAFT'`,
  ).bind(designId, required.session!.customerId).first<{
    template_id: string;
    schema_version: number;
  }>();
  if (!design) return apiError(requestId, 404, "NOT_FOUND", "Design not found");
  if (design.schema_version !== parsed.value.schema_version) {
    return apiError(requestId, 422, "VALIDATION_ERROR", "Unsupported schema version");
  }
  const validated = parseDesignData(design.template_id, design.schema_version, parsed.value.data);
  if (!validated.value) {
    return apiError(requestId, 422, "VALIDATION_ERROR", "Design data is invalid", validated.fields);
  }
  const references = assetReferences(design.template_id, validated.value);
  if (!await validateAssetReferences(env, required.session!.customerId, designId, design.template_id, validated.value)) {
    return apiError(requestId, 422, "VALIDATION_ERROR", "One or more photo references are not available");
  }

  const now = nowIso();
  const nextRevision = expectedRevision + 1;
  const dataJson = JSON.stringify(validated.value);
  const assetGuard = references.length
    ? `AND (
         SELECT COUNT(*) FROM assets
         WHERE customer_id = ? AND design_id = ? AND status = 'READY'
           AND id IN (${references.map(() => "?").join(",")})
       ) = ?`
    : "";
  const statements = [
    env.DB.prepare(
      `UPDATE designs
       SET data_json = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND customer_id = ? AND status = 'DRAFT' AND revision = ?
         AND schema_version = ?
         ${assetGuard}`,
    ).bind(
      dataJson, now, designId, required.session!.customerId, expectedRevision, design.schema_version,
      ...(references.length
        ? [required.session!.customerId, designId, ...references, references.length]
        : []),
    ),
    env.DB.prepare(
      `INSERT INTO design_revisions (design_id, revision, data_json, created_at)
       SELECT ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM designs
         WHERE id = ? AND customer_id = ? AND status = 'DRAFT' AND revision = ?
           AND NOT EXISTS (
             SELECT 1 FROM design_revisions
             WHERE design_id = ? AND revision = ?
           )
       )`,
    ).bind(
      designId,
      nextRevision,
      dataJson,
      now,
      designId,
      required.session!.customerId,
      nextRevision,
      designId,
      nextRevision,
    ),
    env.DB.prepare(
      `DELETE FROM design_asset_refs
       WHERE design_id = ? AND EXISTS (
         SELECT 1 FROM designs
         WHERE id = ? AND customer_id = ? AND status = 'DRAFT'
           AND revision = ? AND data_json = ?
       )`,
    ).bind(designId, designId, required.session!.customerId, nextRevision, dataJson),
    ...references.map((assetId) => env.DB.prepare(
      `INSERT INTO design_asset_refs (design_id, asset_id, customer_id, revision, created_at)
       SELECT ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM designs
         WHERE id = ? AND customer_id = ? AND status = 'DRAFT'
           AND revision = ? AND data_json = ?
       )`,
    ).bind(
      designId, assetId, required.session!.customerId, nextRevision, now,
      designId, required.session!.customerId, nextRevision, dataJson,
    )),
  ];
  const batch = await env.DB.batch(statements);
  if ((batch[0]?.meta.changes ?? 0) !== 1) {
    const current = await env.DB.prepare(
      "SELECT revision FROM designs WHERE id = ? AND customer_id = ? AND status = 'DRAFT'",
    ).bind(designId, required.session!.customerId).first<{ revision: number }>();
    if (!current) return apiError(requestId, 404, "NOT_FOUND", "Design not found");
    return jsonResponse({
      error: { code: "CONFLICT", message: "Design has changed; reload before saving" },
      request_id: requestId,
      current_revision: current.revision,
    }, 409, requestId);
  }
  if (batch[1]?.meta.changes !== 1 ||
      batch.slice(3).some((result) => result.meta.changes !== 1)) {
    throw new Error("Design revision asset references could not be persisted atomically");
  }
  await env.DB.prepare(
    "UPDATE preview_tokens SET revoked_at = ? WHERE design_id = ? AND revoked_at IS NULL",
  ).bind(now, designId).run();
  return jsonResponse({ design_id: designId, revision: nextRevision, data: validated.value }, 200, requestId);
}

async function deleteDesign(
  request: Request,
  env: Env,
  requestId: string,
  designId: string,
): Promise<Response> {
  const required = await requireSession(request, env, requestId);
  if (required.response) return required.response;
  const csrf = await requireCsrf(request, env, required.session!, requestId);
  if (csrf) return csrf;

  const ownerId = required.session!.customerId;
  const now = nowIso();
  const owned = await env.DB.prepare(
    "SELECT status FROM designs WHERE id = ? AND customer_id = ?",
  ).bind(designId, ownerId).first<{ status: string }>();
  if (!owned) return apiError(requestId, 404, "NOT_FOUND", "Design not found");
  if (!env.STORAGE) {
    return apiError(requestId, 503, "STORAGE_UNAVAILABLE", "Private media storage is unavailable");
  }
  if (owned.status === "ARCHIVED") {
    const protectedAsset = await env.DB.prepare(
      `SELECT asset.id FROM assets asset
       WHERE asset.design_id = ? AND asset.customer_id = ?
         AND (
           EXISTS (
             SELECT 1 FROM order_asset_refs ref
             JOIN orders o ON o.id = ref.order_id
             WHERE ref.asset_id = asset.id
               AND o.status IN ('DRAFT','AWAITING_PAYMENT','PAID','FULFILLING','REFUND_PENDING')
           ) OR EXISTS (
             SELECT 1 FROM publication_assets ref
             JOIN publications p ON p.id = ref.publication_id
             WHERE ref.asset_id = asset.id AND ref.revoked_at IS NULL
               AND (
                 p.status IN ('PUBLISHED','UNPUBLISHED') OR
                 (p.status IN ('EXPIRED','REVOKED') AND p.retention_delete_after_at > ?)
               )
           )
         )
       LIMIT 1`,
    ).bind(designId, ownerId, now).first<{ id: string }>();
    if (protectedAsset) {
      return apiError(requestId, 409, "ASSET_IN_USE",
        "An archived design asset is still required by an order or retained website");
    }
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM design_asset_refs
         WHERE design_id = ? AND EXISTS (
           SELECT 1 FROM designs
           WHERE id = ? AND customer_id = ? AND status = 'ARCHIVED'
         )
         AND NOT EXISTS (
           SELECT 1 FROM assets asset
           WHERE asset.design_id = ? AND asset.customer_id = ?
             AND (
               EXISTS (
                 SELECT 1 FROM order_asset_refs ref
                 JOIN orders o ON o.id = ref.order_id
                 WHERE ref.asset_id = asset.id
                   AND o.status IN ('DRAFT','AWAITING_PAYMENT','PAID','FULFILLING','REFUND_PENDING')
               ) OR EXISTS (
                 SELECT 1 FROM publication_assets ref
                 JOIN publications p ON p.id = ref.publication_id
                 WHERE ref.asset_id = asset.id AND ref.revoked_at IS NULL
                   AND (
                     p.status IN ('PUBLISHED','UNPUBLISHED') OR
                     (p.status IN ('EXPIRED','REVOKED') AND p.retention_delete_after_at > ?)
                   )
               )
             )
         )`,
      ).bind(designId, designId, ownerId, designId, ownerId, now),
      env.DB.prepare(
        `UPDATE assets SET status = 'DELETION_PENDING', updated_at = ?
         WHERE design_id = ? AND customer_id = ? AND status NOT IN ('DELETION_PENDING','DELETED')
           AND NOT EXISTS (
             SELECT 1 FROM design_asset_refs ref WHERE ref.asset_id = assets.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM order_asset_refs ref JOIN orders o ON o.id = ref.order_id
             WHERE ref.asset_id = assets.id
               AND o.status IN ('DRAFT','AWAITING_PAYMENT','PAID','FULFILLING','REFUND_PENDING')
           )
           AND NOT EXISTS (
             SELECT 1 FROM publication_assets ref
             JOIN publications p ON p.id = ref.publication_id
             WHERE ref.asset_id = assets.id AND ref.revoked_at IS NULL
               AND (
                 p.status IN ('PUBLISHED','UNPUBLISHED') OR
                 (p.status IN ('EXPIRED','REVOKED') AND p.retention_delete_after_at > ?)
               )
           )
           AND EXISTS (
             SELECT 1 FROM designs
             WHERE id = ? AND customer_id = ? AND status = 'ARCHIVED'
           )`,
      ).bind(now, designId, ownerId, now, designId, ownerId),
    ]);
    const archivedAssets = await env.DB.prepare(
      `SELECT id, object_key FROM assets
       WHERE design_id = ? AND customer_id = ? AND status = 'DELETION_PENDING'`,
    ).bind(designId, ownerId).all<{ id: string; object_key: string }>();
    for (const asset of archivedAssets.results) {
      try {
        await env.STORAGE.delete(asset.object_key);
        const deletedAt = nowIso();
        const finalized = await env.DB.prepare(
          `UPDATE assets SET status = 'DELETED', deleted_at = COALESCE(deleted_at, ?), updated_at = ?
           WHERE id = ? AND customer_id = ? AND status = 'DELETION_PENDING'`,
        ).bind(deletedAt, deletedAt, asset.id, ownerId).run();
        if (finalized.meta.changes !== 1) {
          const current = await env.DB.prepare(
            "SELECT status FROM assets WHERE id = ? AND customer_id = ?",
          ).bind(asset.id, ownerId).first<{ status: string }>();
          if (current?.status !== "DELETED") {
            return apiError(requestId, 503, "DELETION_PENDING", "Design media cleanup will be retried");
          }
        }
      } catch (error) {
        logSafeError("design.media_deletion_failed", "storage", error, { request_id: requestId });
        return apiError(requestId, 503, "DELETION_PENDING", "Design media cleanup will be retried");
      }
    }
    const remaining = await env.DB.prepare(
      `SELECT id FROM assets
       WHERE design_id = ? AND customer_id = ? AND status NOT IN ('DELETED','REJECTED')
       LIMIT 1`,
    ).bind(designId, ownerId).first<{ id: string }>();
    if (remaining) {
      return apiError(requestId, 503, "DELETION_PENDING", "Design media cleanup will be retried");
    }
    return jsonResponse({ deleted: true }, 200, requestId);
  }
  if (owned.status !== "DRAFT" && owned.status !== "DELETION_PENDING") {
    return apiError(requestId, 409, "DELETION_BLOCKED", "Design is not available for deletion");
  }
  const transition = await env.DB.batch([
    env.DB.prepare(
      `UPDATE designs SET status = 'DELETION_PENDING', updated_at = ?
       WHERE id = ? AND customer_id = ? AND status IN ('DRAFT','DELETION_PENDING')
         AND ${noDesignDeletionInProgress}
         AND ${noActiveUploadInProgress}
         AND NOT ${designHasProtectedHistory}
         AND ${noSharedPublicationAsset}`,
    ).bind(now, designId, ownerId, now, now),
    env.DB.prepare(
      `UPDATE designs SET status = 'DELETION_PENDING', updated_at = ?
       WHERE id = ? AND customer_id = ? AND status IN ('DRAFT','DELETION_PENDING')
         AND ${noDesignDeletionInProgress}
         AND ${noActiveUploadInProgress}
         AND ${designHasProtectedHistory}`,
    ).bind(now, designId, ownerId, now),
    env.DB.prepare(
      `DELETE FROM design_asset_refs
       WHERE design_id = ? AND EXISTS (
         SELECT 1 FROM designs
         WHERE id = ? AND customer_id = ? AND status = 'DELETION_PENDING'
           AND NOT ${designHasProtectedHistory}
       )`,
    ).bind(designId, designId, ownerId),
    env.DB.prepare(
      `UPDATE assets SET status = 'DELETION_PENDING', updated_at = ?
       WHERE design_id = ? AND customer_id = ? AND status != 'DELETED'
         AND EXISTS (
           SELECT 1 FROM designs
           WHERE id = ? AND customer_id = ? AND status = 'DELETION_PENDING'
             AND NOT ${designHasProtectedHistory}
         )
      `,
    ).bind(now, designId, ownerId, designId, ownerId),
    env.DB.prepare(
      `UPDATE asset_upload_attempts
       SET status = 'CLEANUP_PENDING', next_cleanup_at = ?, updated_at = ?
       WHERE status IN ('UPLOADING','ATTACHED')
         AND EXISTS (
           SELECT 1 FROM assets
           WHERE id = asset_upload_attempts.asset_id AND design_id = ?
             AND status = 'DELETION_PENDING'
         )`,
    ).bind(new Date(Date.parse(now) + 60 * 60_000).toISOString(), now, designId),
    env.DB.prepare(
      `UPDATE publications SET status = 'UNPUBLISHED', unpublished_at = ?,
         lifecycle_revision = lifecycle_revision + 1, updated_at = ?
       WHERE design_id = ? AND status = 'PUBLISHED'
         AND EXISTS (
           SELECT 1 FROM designs
           WHERE id = ? AND customer_id = ? AND status = 'DELETION_PENDING'
             AND ${designHasProtectedHistory}
         )`,
    ).bind(now, now, designId, designId, ownerId),
    env.DB.prepare(
      `UPDATE asset_upload_sessions
       SET status = 'CANCELLED', lease_expires_at = NULL, used_at = COALESCE(used_at, ?)
       WHERE status IN ('PENDING','UPLOADING')
         AND (status = 'PENDING' OR lease_expires_at <= ?)
         AND EXISTS (
           SELECT 1 FROM assets a JOIN designs d ON d.id = a.design_id
           WHERE a.id = asset_upload_sessions.asset_id AND d.id = ? AND d.customer_id = ?
             AND d.status = 'DELETION_PENDING'
         )`,
    ).bind(now, now, designId, ownerId),
  ]);
  const physicalDeletionClaimed = transition[0]?.meta.changes === 1;
  const protectedDeletionClaimed = transition[1]?.meta.changes === 1;
  if (!physicalDeletionClaimed && !protectedDeletionClaimed) {
    return apiError(requestId, 409, "DELETION_BLOCKED",
      "Deletion is blocked while an upload, order, fulfillment, or shared publication is using this design");
  }

  if (protectedDeletionClaimed) {
    const publications = await env.DB.prepare(
      "SELECT id FROM publications WHERE design_id = ?",
    ).bind(designId).all<{ id: string }>();
    let cleanupSucceeded = true;
    for (const publication of publications.results) {
      if (!await cleanupAssets(env, publication.id)) cleanupSucceeded = false;
    }
    if (!cleanupSucceeded) {
      return apiError(requestId, 503, "DELETION_PENDING",
        "Public media cleanup is pending; payment and source data remain preserved");
    }
    return jsonResponse({
      deleted: false,
      deletion_requested: true,
      public_access_revoked: true,
      data_retained: true,
    }, 202, requestId);
  }

  const sharedAsset = await env.DB.prepare(
    `SELECT source.id FROM assets source
     JOIN publication_assets asset_ref ON asset_ref.asset_id = source.id
       AND asset_ref.revoked_at IS NULL
     JOIN publications other ON other.id = asset_ref.publication_id
     WHERE source.design_id = ? AND other.design_id <> ?
       AND (
         other.status IN ('PUBLISHED','UNPUBLISHED') OR
         (other.status IN ('EXPIRED','REVOKED') AND
           other.retention_delete_after_at > ?)
       )
     LIMIT 1`,
  ).bind(designId, designId, now).first<{ id: string }>();
  if (sharedAsset) {
    return apiError(requestId, 409, "ASSET_IN_USE",
      "A design asset is still referenced by another active or retained website");
  }

  const assets = await env.DB.prepare(
    `SELECT id, object_key FROM assets
     WHERE design_id = ? AND customer_id = ? AND status != 'DELETED'`,
  ).bind(designId, ownerId).all<{ id: string; object_key: string }>();
  for (const asset of assets.results) {
    try {
      await env.STORAGE.delete(asset.object_key);
      const deletedAt = nowIso();
      const deleted = await env.DB.prepare(
        `UPDATE assets SET status = 'DELETED', deleted_at = ?, updated_at = ?
         WHERE id = ? AND customer_id = ? AND status = 'DELETION_PENDING'`,
      ).bind(deletedAt, deletedAt, asset.id, ownerId).run();
      if (deleted.meta.changes !== 1) {
        const current = await env.DB.prepare(
          "SELECT status FROM assets WHERE id = ? AND customer_id = ?",
        ).bind(asset.id, ownerId).first<{ status: string }>();
        if (current?.status !== "DELETED") {
          return apiError(requestId, 503, "DELETION_PENDING",
            "Design media cleanup is incomplete and will be retried");
        }
      }
    } catch (error) {
      logSafeError("design.media_deletion_failed", "storage", error, { request_id: requestId });
      return apiError(requestId, 503, "DELETION_PENDING", "Design deletion will be retried");
    }
  }
  const remainingAssets = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM assets
     WHERE design_id = ? AND customer_id = ? AND status != 'DELETED'`,
  ).bind(designId, ownerId).first<{ count: number }>();
  if ((remainingAssets?.count ?? 0) > 0) {
    return apiError(requestId, 503, "DELETION_PENDING",
      "Design media cleanup is incomplete and will be retried");
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE designs SET data_json = '{}', status = 'ARCHIVED', updated_at = ?
       WHERE id = ? AND customer_id = ? AND status = 'DELETION_PENDING'
         AND NOT ${designHasProtectedHistory}
         AND ${noDesignDeletionInProgress}
         AND ${noActiveUploadInProgress}
         AND NOT EXISTS (
           SELECT 1 FROM assets
           WHERE design_id = designs.id AND customer_id = designs.customer_id
             AND status != 'DELETED'
         )
         AND ${noSharedPublicationAsset}`,
    ).bind(now, designId, ownerId, now, now),
    env.DB.prepare(
      `DELETE FROM design_revisions
       WHERE design_id = ? AND EXISTS (
         SELECT 1 FROM designs
         WHERE id = ? AND customer_id = ? AND status = 'ARCHIVED'
       )`,
    ).bind(designId, designId, ownerId),
    env.DB.prepare(
      `UPDATE preview_tokens SET revoked_at = ?
       WHERE design_id = ? AND revoked_at IS NULL AND EXISTS (
         SELECT 1 FROM designs
         WHERE id = ? AND customer_id = ? AND status = 'ARCHIVED'
       )`,
    ).bind(now, designId, designId, ownerId),
  ]);
  const archived = await env.DB.prepare(
    "SELECT status FROM designs WHERE id = ? AND customer_id = ?",
  ).bind(designId, ownerId).first<{ status: string }>();
  if (archived?.status !== "ARCHIVED") {
    return apiError(requestId, 409, "DELETION_BLOCKED",
      "Design data was retained because another operation still references it");
  }
  return jsonResponse({ deleted: true }, 200, requestId);
}

async function createDesign(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  const required = await requireSession(request, env, requestId);
  if (required.response) return required.response;
  const csrf = await requireCsrf(request, env, required.session!, requestId);
  if (csrf) return csrf;
  const parsed = await readJson(request, requestId);
  if (parsed.response) return parsed.response;
  const payload = validateCreatePayload(parsed.value);
  if ("error" in payload) return apiError(requestId, 422, "VALIDATION_ERROR", payload.error);

  const template = await env.DB.prepare(
    `SELECT tv.default_data_json
     FROM templates t JOIN template_versions tv ON tv.template_id = t.id
     WHERE t.id = ? AND t.status = 'ACTIVE' AND t.current_schema_version = ?
       AND tv.schema_version = ? AND tv.status = 'ACTIVE'`,
  ).bind(payload.templateId, payload.schemaVersion, payload.schemaVersion)
    .first<{ default_data_json: string }>();
  if (!template) return apiError(requestId, 422, "VALIDATION_ERROR", "Template or schema version is unavailable");
  const validated = parseDesignData(
    payload.templateId,
    payload.schemaVersion,
    payload.data ?? JSON.parse(template.default_data_json) as unknown,
  );
  if (!validated.value) {
    return apiError(requestId, 422, "VALIDATION_ERROR", "Design data is invalid", validated.fields);
  }
  if (assetReferences(payload.templateId, validated.value).length > 0) {
    return apiError(requestId, 422, "VALIDATION_ERROR", "New designs cannot reference unowned assets");
  }

  const id = safeId();
  const now = nowIso();
  const data = JSON.stringify(validated.value);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO designs
       (id, customer_id, template_id, schema_version, data_json, revision, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 'DRAFT', ?, ?)`,
    ).bind(id, required.session!.customerId, payload.templateId, payload.schemaVersion, data, now, now),
    env.DB.prepare(
      "INSERT INTO design_revisions (design_id, revision, data_json, created_at) VALUES (?, 1, ?, ?)",
    ).bind(id, data, now),
  ]);
  return jsonResponse({
    design_id: id,
    template_id: payload.templateId,
    schema_version: payload.schemaVersion,
    revision: 1,
    data: validated.value,
  }, 201, requestId);
}

async function getDesign(
  request: Request,
  env: Env,
  requestId: string,
  designId: string,
): Promise<Response> {
  const required = await requireSession(request, env, requestId);
  if (required.response) return required.response;
  const row = await env.DB.prepare(
    `SELECT id, template_id, schema_version, data_json, revision, updated_at
     FROM designs
     WHERE id = ? AND customer_id = ? AND status = 'DRAFT'`,
  ).bind(designId, required.session!.customerId).first<{
    id: string;
    template_id: string;
    schema_version: number;
    data_json: string;
    revision: number;
    updated_at: string;
  }>();
  if (!row) return apiError(requestId, 404, "NOT_FOUND", "Design not found");
  return jsonResponse({
    design_id: row.id,
    template_id: row.template_id,
    schema_version: row.schema_version,
    revision: row.revision,
    updated_at: row.updated_at,
    data: JSON.parse(row.data_json) as unknown,
  }, 200, requestId);
}

async function createPreview(
  request: Request,
  env: Env,
  requestId: string,
  designId: string,
): Promise<Response> {
  const required = await requireSession(request, env, requestId);
  if (required.response) return required.response;
  const csrf = await requireCsrf(request, env, required.session!, requestId);
  if (csrf) return csrf;
  const row = await env.DB.prepare(
    `SELECT template_id, schema_version, revision FROM designs
     WHERE id = ? AND customer_id = ? AND status = 'DRAFT'`,
  ).bind(designId, required.session!.customerId)
    .first<{ template_id: string; schema_version: number; revision: number }>();
  if (!row) return apiError(requestId, 404, "NOT_FOUND", "Design not found");

  const token = randomToken();
  const expiresAt = new Date(Date.now() + TOKEN_SECONDS * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO preview_tokens
     (id, design_id, customer_id, design_revision, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    safeId(),
    designId,
    required.session!.customerId,
    row.revision,
    await sha256(token),
    expiresAt,
    nowIso(),
  ).run();
  return jsonResponse({
    token,
    url: `/templates/${encodeURIComponent(row.template_id)}/?preview#${encodeURIComponent(token)}`,
    expires_at: expiresAt,
    revision: row.revision,
    schema_version: row.schema_version,
  }, 201, requestId);
}

export async function handleDesignRoutes(
  request: Request,
  env: Env,
  path: string,
  requestId: string,
): Promise<Response | null> {
  if (path === "/api/v1/designs" && request.method === "POST") {
    return createDesign(request, env, requestId);
  }

  const match = path.match(/^\/api\/v1\/designs\/([0-9a-f-]{36})(?:\/(preview))?$/i);
  if (!match) return null;
  const [, designId, action] = match;
  if (action === "preview" && request.method === "POST") {
    return createPreview(request, env, requestId, designId);
  }
  if (action) return apiError(requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
  if (request.method === "GET") return getDesign(request, env, requestId, designId);
  if (request.method === "PUT") return updateDesign(request, env, requestId, designId);
  if (request.method === "DELETE") return deleteDesign(request, env, requestId, designId);
  return apiError(requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
}

export async function handlePreviewRoutes(
  request: Request,
  env: Env,
  path: string,
  requestId: string,
): Promise<Response | null> {
  const match = path.match(/^\/api\/v1\/previews(?:\/assets\/([0-9a-f-]{36}))?$/i);
  if (!match) return null;
  if (request.method !== "GET") {
    return apiError(requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
  }
  const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{30,100})$/)?.[1];
  if (!token) return apiError(requestId, 404, "NOT_FOUND", "Preview is unavailable");
  const assetId = match[1];
  const tokenHash = await sha256(token);
  const now = nowIso();
  const preview = await env.DB.prepare(
    `SELECT p.design_id, p.customer_id, p.design_revision, r.data_json, d.template_id, d.schema_version
     FROM preview_tokens p
     JOIN designs d ON d.id = p.design_id
     JOIN design_revisions r ON r.design_id = p.design_id AND r.revision = p.design_revision
     WHERE p.token_hash = ? AND p.revoked_at IS NULL AND p.expires_at > ?
       AND d.status = 'DRAFT'`,
  ).bind(tokenHash, now).first<{
    design_id: string;
    customer_id: string;
    design_revision: number;
    data_json: string;
    template_id: string;
    schema_version: number;
  }>();
  if (!preview) return apiError(requestId, 404, "NOT_FOUND", "Preview is unavailable");
  if (assetId) {
    const data = JSON.parse(preview.data_json) as TemplateData;
    if (!assetReferences(preview.template_id, data).includes(assetId)) {
      return apiError(requestId, 404, "NOT_FOUND", "Preview asset not found");
    }
    return serveAsset(request, env, requestId, assetId, preview.customer_id, preview.design_id);
  }

  const data = JSON.parse(preview.data_json) as TemplateData;
  const validated = validateTemplateData(preview.template_id, preview.schema_version, data);
  if (!validated.value) return apiError(requestId, 404, "NOT_FOUND", "Preview is unavailable");
  return jsonResponse({
    template_id: preview.template_id,
    schema_version: preview.schema_version,
    revision: preview.design_revision,
    data: publicTemplateData(preview.template_id, validated.value, (id) =>
      `/api/v1/previews/assets/${encodeURIComponent(id)}`),
  }, 200, requestId, { "X-Robots-Tag": "noindex, nofollow" });
}

export async function serveAsset(
  request: Request,
  env: Env,
  requestId: string,
  assetId: string,
  customerId: string,
  designId: string,
): Promise<Response> {
  if (!env.STORAGE) return apiError(requestId, 503, "STORAGE_UNAVAILABLE", "Private media storage is unavailable");
  const asset = await env.DB.prepare(
    `SELECT object_key, media_type, byte_size FROM assets
     WHERE id = ? AND customer_id = ? AND design_id = ? AND status = 'READY'`,
  ).bind(assetId, customerId, designId).first<{
    object_key: string;
    media_type: string;
    byte_size: number;
  }>();
  if (!asset) return apiError(requestId, 404, "NOT_FOUND", "Asset not found");
  const object = await env.STORAGE.get(asset.object_key);
  if (!object || object.size !== asset.byte_size || object.contentType !== asset.media_type) {
    await object?.body?.cancel();
    return apiError(requestId, 404, "NOT_FOUND", "Asset not found");
  }
  return new Response(object.body, {
    headers: {
      "Content-Type": asset.media_type,
      "Content-Length": String(asset.byte_size),
      "Content-Disposition": "inline; filename=\"crushify-photo\"",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-Request-ID": requestId,
      "Referrer-Policy": "no-referrer",
    },
  });
}

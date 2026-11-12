import { requireCsrf, requireSession } from "./auth.ts";
import { logSafeError } from "./logging.ts";
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
  if (!await validateAssetReferences(env, required.session!.customerId, designId, design.template_id, validated.value)) {
    return apiError(requestId, 422, "VALIDATION_ERROR", "One or more photo references are not available");
  }

  const now = nowIso();
  const nextRevision = expectedRevision + 1;
  const batch = await env.DB.batch([
    env.DB.prepare(
      `UPDATE designs
       SET data_json = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND customer_id = ? AND status = 'DRAFT' AND revision = ?
         AND schema_version = ?`,
    ).bind(JSON.stringify(validated.value), now, designId, required.session!.customerId, expectedRevision,
      design.schema_version),
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
      JSON.stringify(validated.value),
      now,
      designId,
      required.session!.customerId,
      nextRevision,
      designId,
      nextRevision,
    ),
  ]);
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
  if (!env.STORAGE) return apiError(requestId, 503, "STORAGE_UNAVAILABLE", "Private media storage is unavailable");

  const ownerId = required.session!.customerId;
  const now = nowIso();
  const owned = await env.DB.prepare(
    "SELECT id FROM designs WHERE id = ? AND customer_id = ? AND status IN ('DRAFT','DELETION_PENDING')",
  ).bind(designId, ownerId).first<{ id: string }>();
  if (!owned) return apiError(requestId, 404, "NOT_FOUND", "Design not found");
  await env.DB.prepare(
    "UPDATE designs SET status = 'DELETION_PENDING', updated_at = ? WHERE id = ? AND customer_id = ?",
  ).bind(now, designId, ownerId).run();

  const derivatives = await env.DB.prepare(
    `SELECT pa.id, pa.derivative_key
     FROM publication_assets pa
     JOIN publications p ON p.id = pa.publication_id
     WHERE p.design_id = ? AND p.status IN ('PUBLISHED','UNPUBLISHED','REVOKED')
       AND pa.derivative_key IS NOT NULL
       AND pa.derivative_status IN ('READY','CLEANUP_PENDING')`,
  ).bind(designId).all<{ id: string; derivative_key: string }>();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE publications SET status = 'REVOKED', revoked_at = ?, unpublished_at = ?,
         lifecycle_revision = lifecycle_revision + 1, updated_at = ?
       WHERE design_id = ? AND status IN ('PUBLISHED','UNPUBLISHED')`,
    ).bind(now, now, now, designId),
    env.DB.prepare(
      `UPDATE publication_assets SET revoked_at = COALESCE(revoked_at, ?),
         derivative_status = CASE WHEN derivative_key IS NULL THEN 'DELETED' ELSE 'CLEANUP_PENDING' END,
         updated_at = ?
       WHERE publication_id IN (SELECT id FROM publications WHERE design_id = ? AND status = 'REVOKED')`,
    ).bind(now, now, designId),
  ]);
  for (const derivative of derivatives.results) {
    try {
      await env.STORAGE.deletePublishedDerivative(derivative.derivative_key);
      await env.DB.prepare(
        `UPDATE publication_assets SET derivative_key = NULL, derivative_status = 'DELETED',
           updated_at = ? WHERE id = ? AND derivative_key = ?`,
      ).bind(nowIso(), derivative.id, derivative.derivative_key).run();
    } catch (error) {
      logSafeError("design.published_media_deletion_failed", "storage", error, { request_id: requestId });
      return apiError(requestId, 503, "DELETION_PENDING", "Published media deletion will be retried");
    }
  }

  const assets = await env.DB.prepare(
    "SELECT id, object_key FROM assets WHERE design_id = ? AND customer_id = ? AND status != 'DELETED'",
  ).bind(designId, ownerId).all<{ id: string; object_key: string }>();
  try {
    for (const asset of assets.results) await env.STORAGE.delete(asset.object_key);
  } catch (error) {
    logSafeError("design.media_deletion_failed", "storage", error, { request_id: requestId });
    return apiError(requestId, 503, "DELETION_PENDING", "Design deletion will be retried");
  }
  const statements = assets.results.map((asset) =>
    env.DB.prepare(
      "UPDATE assets SET status = 'DELETED', deleted_at = ?, updated_at = ? WHERE id = ?",
    ).bind(now, now, asset.id),
  );
  statements.push(
    env.DB.prepare(
      "UPDATE designs SET data_json = '{}', status = 'ARCHIVED', updated_at = ? WHERE id = ?",
    ).bind(now, designId),
    env.DB.prepare("DELETE FROM design_revisions WHERE design_id = ?").bind(designId),
    env.DB.prepare("UPDATE preview_tokens SET revoked_at = ? WHERE design_id = ? AND revoked_at IS NULL")
      .bind(now, designId),
  );
  await env.DB.batch(statements);
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

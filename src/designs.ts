import { requireCsrf, requireSession } from "./auth.ts";
import { apiError, jsonResponse, nowIso, randomToken, readJson, safeId, sha256 } from "./http.ts";
import { isJsonWithinLimit, validateUniverseDesign, type UniverseDesign } from "./universe.ts";
import type { Env } from "./types.ts";

const TOKEN_SECONDS = 15 * 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function validateAssetReferences(
  env: Env,
  ownerId: string,
  designId: string,
  data: UniverseDesign,
): Promise<boolean> {
  const ids = data.photos.map((photo) => photo.asset_id);
  if (new Set(ids).size !== ids.length) return false;
  if (!ids.length) return true;
  const placeholders = ids.map(() => "?").join(",");
  const result = await env.DB.prepare(
    `SELECT id FROM assets
     WHERE customer_id = ? AND design_id = ? AND status = 'READY'
       AND id IN (${placeholders})`,
  ).bind(ownerId, designId, ...ids).all<{ id: string }>();
  return result.results.length === ids.length;
}

type CreatePayload =
  | { error: string }
  | { templateId: string; schemaVersion: number; data: unknown };

function validateCreatePayload(value: unknown): CreatePayload {
  if (!isRecord(value)) return { error: "Request body must be an object" };
  const allowed = new Set(["template_id", "schema_version", "data"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return { error: "Unsupported request field" };
  if (value.template_id !== "our-universe") return { error: "Unsupported template" };
  if (value.schema_version !== 1) return { error: "Unsupported schema version" };
  return {
    templateId: value.template_id,
    schemaVersion: value.schema_version,
    data: value.data,
  };
}

function parseDesignData(value: unknown) {
  const validated = validateUniverseDesign(value);
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
      parsed.value.schema_version !== 1 || !Object.hasOwn(parsed.value, "data")) {
    return apiError(requestId, 400, "VALIDATION_ERROR", "Expected schema_version, expected_revision and data");
  }
  const expectedRevision = parsed.value.expected_revision;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    return apiError(requestId, 400, "VALIDATION_ERROR", "Invalid expected revision");
  }
  const validated = parseDesignData(parsed.value.data);
  if (!validated.value) {
    return apiError(requestId, 422, "VALIDATION_ERROR", "Design data is invalid", validated.fields);
  }
  if (!await validateAssetReferences(env, required.session!.customerId, designId, validated.value)) {
    return apiError(requestId, 422, "VALIDATION_ERROR", "One or more photo references are not available");
  }

  const now = nowIso();
  const nextRevision = expectedRevision + 1;
  const batch = await env.DB.batch([
    env.DB.prepare(
      `UPDATE designs
       SET data_json = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND customer_id = ? AND status = 'DRAFT' AND revision = ?
         AND schema_version = 1`,
    ).bind(JSON.stringify(validated.value), now, designId, required.session!.customerId, expectedRevision),
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
  if (!env.MEDIA) return apiError(requestId, 503, "MEDIA_UNAVAILABLE", "Private media storage is unavailable");

  const ownerId = required.session!.customerId;
  const now = nowIso();
  const owned = await env.DB.prepare(
    "SELECT id FROM designs WHERE id = ? AND customer_id = ? AND status IN ('DRAFT','DELETION_PENDING')",
  ).bind(designId, ownerId).first<{ id: string }>();
  if (!owned) return apiError(requestId, 404, "NOT_FOUND", "Design not found");
  await env.DB.prepare(
    "UPDATE designs SET status = 'DELETION_PENDING', updated_at = ? WHERE id = ? AND customer_id = ?",
  ).bind(now, designId, ownerId).run();

  const assets = await env.DB.prepare(
    "SELECT id, object_key FROM assets WHERE design_id = ? AND customer_id = ? AND status != 'DELETED'",
  ).bind(designId, ownerId).all<{ id: string; object_key: string }>();
  try {
    for (const asset of assets.results) await env.MEDIA.delete(asset.object_key);
  } catch (error) {
    console.error("Design media deletion failed", { request_id: requestId, design_id: designId, error });
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
  const validated = parseDesignData(payload.data ?? JSON.parse(template.default_data_json) as unknown);
  if (!validated.value) {
    return apiError(requestId, 422, "VALIDATION_ERROR", "Design data is invalid", validated.fields);
  }

  const id = safeId();
  const now = nowIso();
  const data = JSON.stringify(validated.value);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO designs
       (id, customer_id, template_id, schema_version, data_json, revision, status, created_at, updated_at)
       VALUES (?, ?, 'our-universe', 1, ?, 1, 'DRAFT', ?, ?)`,
    ).bind(id, required.session!.customerId, data, now, now),
    env.DB.prepare(
      "INSERT INTO design_revisions (design_id, revision, data_json, created_at) VALUES (?, 1, ?, ?)",
    ).bind(id, data, now),
  ]);
  return jsonResponse({
    design_id: id,
    template_id: "our-universe",
    schema_version: 1,
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
    `SELECT revision FROM designs
     WHERE id = ? AND customer_id = ? AND status = 'DRAFT'`,
  ).bind(designId, required.session!.customerId).first<{ revision: number }>();
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
    url: `/templates/our-universe/?preview#${encodeURIComponent(token)}`,
    expires_at: expiresAt,
    revision: row.revision,
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
    `SELECT p.design_id, p.customer_id, p.design_revision, r.data_json
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
  }>();
  if (!preview) return apiError(requestId, 404, "NOT_FOUND", "Preview is unavailable");
  if (assetId) {
    const data = JSON.parse(preview.data_json) as UniverseDesign;
    if (!data.photos.some((photo) => photo.asset_id === assetId)) {
      return apiError(requestId, 404, "NOT_FOUND", "Preview asset not found");
    }
    return serveAsset(request, env, requestId, assetId, preview.customer_id, preview.design_id);
  }

  const data = JSON.parse(preview.data_json) as UniverseDesign;
  return jsonResponse({
    template_id: "our-universe",
    schema_version: 1,
    revision: preview.design_revision,
    data: {
      ...data,
      photos: data.photos.map((photo) => ({
        ...photo,
        url: `/api/v1/previews/assets/${encodeURIComponent(photo.asset_id)}`,
      })),
    },
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
  if (!env.MEDIA) return apiError(requestId, 503, "MEDIA_UNAVAILABLE", "Private media storage is unavailable");
  const asset = await env.DB.prepare(
    `SELECT object_key, media_type, byte_size FROM assets
     WHERE id = ? AND customer_id = ? AND design_id = ? AND status = 'READY'`,
  ).bind(assetId, customerId, designId).first<{
    object_key: string;
    media_type: string;
    byte_size: number;
  }>();
  if (!asset) return apiError(requestId, 404, "NOT_FOUND", "Asset not found");
  const object = await env.MEDIA.get(asset.object_key);
  if (!object || object.size !== asset.byte_size) {
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

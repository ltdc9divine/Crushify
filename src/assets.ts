import { requireCsrf, requireSession } from "./auth.ts";
import { logSafeError } from "./logging.ts";
import { apiError, MAX_IMAGE_BYTES, nowIso, randomToken, readBoundedBody, readJson, safeId, sha256, jsonResponse } from "./http.ts";
import { serveAsset } from "./designs.ts";
import type { Env } from "./types.ts";
import { assetReferences, type TemplateData } from "./template-registry.ts";

const UPLOAD_LEASE_MS = 15 * 60 * 1000;

interface ImageInfo {
  contentType: "image/png" | "image/jpeg";
  width: number;
  height: number;
}

export function detectImage(bytes: Uint8Array): ImageInfo | null {
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length >= 45 && pngSignature.every((byte, index) => bytes[index] === byte)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(8) !== 13 || new TextDecoder().decode(bytes.subarray(12, 16)) !== "IHDR") return null;
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    let hasEnd = false;
    for (let index = bytes.length - 8; index >= 33; index--) {
      if (new TextDecoder().decode(bytes.subarray(index + 4, index + 8)) === "IEND") {
        hasEnd = true;
        break;
      }
    }
    if (hasEnd && validDimensions(width, height)) return { contentType: "image/png", width, height };
    return null;
  }

  if (bytes.length < 16 || bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
      bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null;
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (segmentLength < 7) return null;
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return validDimensions(width, height) ? { contentType: "image/jpeg", width, height } : null;
    }
    offset += segmentLength;
  }
  return null;
}

function validDimensions(width: number, height: number): boolean {
  return width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 40_000_000;
}

function uploadMaxBytes(env: Env): number {
  const configured = env.UPLOAD_MAX_BYTES;
  return typeof configured === "number" && Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, MAX_IMAGE_BYTES)
    : MAX_IMAGE_BYTES;
}

function bearerToken(request: Request): string | null {
  const match = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{30,100})$/);
  return match?.[1] ?? null;
}

async function createUpload(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  if (!env.STORAGE) return apiError(requestId, 503, "STORAGE_UNAVAILABLE", "Private media storage is unavailable");
  const required = await requireSession(request, env, requestId);
  if (required.response) return required.response;
  const csrf = await requireCsrf(request, env, required.session!, requestId);
  if (csrf) return csrf;
  const parsed = await readJson(request, requestId);
  if (parsed.response) return parsed.response;
  const value = parsed.value;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 3 ||
      typeof (value as { design_id?: unknown }).design_id !== "string" ||
      !["image/png", "image/jpeg"].includes(String((value as { media_type?: unknown }).media_type)) ||
      !Number.isSafeInteger((value as { size?: unknown }).size)) {
    return apiError(requestId, 400, "VALIDATION_ERROR", "Invalid upload metadata");
  }
  const { design_id: designId, media_type: mediaType, size } = value as {
    design_id: string;
    media_type: string;
    size: number;
  };
  const maxBytes = uploadMaxBytes(env);
  if (size < 1 || size > maxBytes) {
    return apiError(requestId, 413, "PAYLOAD_TOO_LARGE", `Image must be ${Math.floor(maxBytes / (1024 * 1024))} MB or smaller`);
  }
  const design = await env.DB.prepare(
    "SELECT id, template_id FROM designs WHERE id = ? AND customer_id = ? AND status = 'DRAFT'",
  ).bind(designId, required.session!.customerId).first<{ id: string; template_id: string }>();
  if (!design) return apiError(requestId, 404, "NOT_FOUND", "Design not found");
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM assets
     WHERE design_id = ? AND customer_id = ?
       AND status IN ('PENDING','QUARANTINED','READY')`,
  ).bind(designId, required.session!.customerId).first<{ count: number }>();
  const maxAssets = design.template_id === "our-memories" ? 13 : 6;
  if ((count?.count ?? 0) >= maxAssets) {
    return apiError(requestId, 409, "PHOTO_LIMIT", `Design already has ${maxAssets} photos`);
  }

  const id = safeId();
  const uploadSessionId = safeId();
  const key = `private/${randomToken(32)}-${mediaType === "image/png" ? "png" : "jpg"}`;
  const token = randomToken();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const inserted = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO assets
       (id, customer_id, design_id, object_key, visibility, status, media_type, byte_size, sha256, created_at, updated_at)
       SELECT ?, ?, ?, ?, 'PRIVATE', 'PENDING', ?, ?, '', ?, ?
       WHERE EXISTS (
         SELECT 1 FROM designs
         WHERE id = ? AND customer_id = ? AND status = 'DRAFT'
       )
       AND (
         SELECT COUNT(*) FROM assets
         WHERE design_id = ? AND customer_id = ?
           AND status IN ('PENDING','QUARANTINED','READY')
       ) < ?`,
    ).bind(
      id, required.session!.customerId, designId, key, mediaType, size, now, now,
      designId, required.session!.customerId, designId, required.session!.customerId, maxAssets,
    ),
    env.DB.prepare(
      `INSERT INTO asset_upload_sessions
       (id, asset_id, customer_id, token_hash, expires_at, created_at, status)
       SELECT ?, ?, ?, ?, ?, ?, 'PENDING'
       WHERE EXISTS (
         SELECT 1 FROM assets
         WHERE id = ? AND customer_id = ? AND design_id = ? AND status = 'PENDING'
       )
       AND EXISTS (
         SELECT 1 FROM designs
         WHERE id = ? AND customer_id = ? AND status = 'DRAFT'
       )`,
    ).bind(
      uploadSessionId, id, required.session!.customerId, await sha256(token), expiresAt, now,
      id, required.session!.customerId, designId, designId, required.session!.customerId,
    ),
    env.DB.prepare(
      `DELETE FROM assets
       WHERE id = ? AND status = 'PENDING'
         AND NOT EXISTS (
           SELECT 1 FROM asset_upload_sessions WHERE asset_id = ?
         )`,
    ).bind(id, id),
  ]);
  if (inserted[0]?.meta.changes !== 1 || inserted[1]?.meta.changes !== 1) {
    return apiError(requestId, 409, "DESIGN_CHANGED",
      "This design is no longer available for uploads. Reopen an active draft and try again.");
  }
  return jsonResponse({
    asset_id: id,
    upload_url: `/api/v1/assets/${id}/content`,
    upload_token: token,
    expires_at: expiresAt,
    max_bytes: maxBytes,
    method: "PUT",
  }, 201, requestId);
}

async function uploadContent(
  request: Request,
  env: Env,
  requestId: string,
  assetId: string,
): Promise<Response> {
  if (!env.STORAGE) return apiError(requestId, 503, "STORAGE_UNAVAILABLE", "Private media storage is unavailable");
  const token = bearerToken(request);
  if (!token) return apiError(requestId, 401, "UNAUTHENTICATED", "Valid upload capability required");
  const session = await env.DB.prepare(
    `SELECT u.id AS upload_id, u.customer_id, u.status AS upload_status, u.expires_at,
            a.object_key, a.media_type, a.byte_size, a.status AS asset_status,
            d.status AS design_status
     FROM asset_upload_sessions u JOIN assets a ON a.id = u.asset_id
     JOIN designs d ON d.id = a.design_id
     WHERE u.asset_id = ? AND u.token_hash = ?`,
  ).bind(assetId, await sha256(token)).first<{
    upload_id: string;
    customer_id: string;
    upload_status: string;
    expires_at: string;
    object_key: string;
    media_type: string;
    byte_size: number;
    asset_status: string;
    design_status: string;
  }>();
  if (!session) return apiError(requestId, 401, "INVALID_UPLOAD_TOKEN", "Upload capability is invalid or expired");
  if (session.upload_status !== "PENDING" || session.asset_status !== "PENDING" ||
      session.design_status !== "DRAFT") {
    return apiError(requestId, 409, "UPLOAD_CANCELLED",
      "This upload was cancelled because its design is no longer an active draft.");
  }
  if (session.expires_at <= nowIso()) {
    return apiError(requestId, 401, "INVALID_UPLOAD_TOKEN", "Upload capability is invalid or expired");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  const maxBytes = uploadMaxBytes(env);
  if (session.byte_size > maxBytes || declaredLength > maxBytes ||
      (declaredLength > 0 && declaredLength !== session.byte_size)) {
    return apiError(requestId, 413, "PAYLOAD_TOO_LARGE", "Image size does not match the upload request");
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBody(request, maxBytes);
  } catch (error) {
    if (error instanceof RangeError) {
      return apiError(requestId, 413, "PAYLOAD_TOO_LARGE", `Image must be ${Math.floor(maxBytes / (1024 * 1024))} MB or smaller`);
    }
    return apiError(requestId, 400, "INVALID_BODY", "Could not read image data");
  }
  if (bytes.byteLength !== session.byte_size) {
    return apiError(requestId, 422, "UPLOAD_REJECTED", "Image size does not match the upload request");
  }
  const info = detectImage(bytes);
  const headerType = request.headers.get("content-type")?.split(";")[0].trim();
  if (!info || info.contentType !== session.media_type || info.contentType !== headerType) {
    return apiError(requestId, 422, "UPLOAD_REJECTED", "Only valid PNG and JPEG images are accepted");
  }

  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + UPLOAD_LEASE_MS).toISOString();
  const claimed = await env.DB.prepare(
    `UPDATE asset_upload_sessions
     SET status = 'UPLOADING', used_at = ?, lease_expires_at = ?
     WHERE id = ? AND status = 'PENDING' AND used_at IS NULL AND expires_at > ?
       AND EXISTS (
         SELECT 1 FROM assets a JOIN designs d ON d.id = a.design_id
         WHERE a.id = asset_upload_sessions.asset_id AND a.customer_id = ?
           AND a.status = 'PENDING' AND d.status = 'DRAFT'
       )
     RETURNING id`,
  ).bind(now, leaseExpiresAt, session.upload_id, now, session.customer_id).first<{ id: string }>();
  if (!claimed) {
    return apiError(requestId, 409, "UPLOAD_CANCELLED",
      "This upload was cancelled because its design changed or was deleted.");
  }

  const digest = await sha256(bytes);
  try {
    await env.STORAGE.upload(session.object_key, bytes, {
      contentType: info.contentType,
      sha256: digest,
      width: info.width,
      height: info.height,
    });
    const finalizedAt = nowIso();
    const finalized = await env.DB.batch([
      env.DB.prepare(
        `UPDATE assets
         SET sha256 = ?, width = ?, height = ?, status = 'QUARANTINED', updated_at = ?
         WHERE id = ? AND customer_id = ? AND status = 'PENDING'
           AND EXISTS (
             SELECT 1 FROM designs
             WHERE id = assets.design_id AND customer_id = ? AND status = 'DRAFT'
           )
           AND EXISTS (
             SELECT 1 FROM asset_upload_sessions
             WHERE asset_id = assets.id AND status = 'UPLOADING' AND lease_expires_at > ?
           )`,
      ).bind(digest, info.width, info.height, finalizedAt, assetId, session.customer_id,
        session.customer_id, finalizedAt),
      env.DB.prepare(
        `UPDATE asset_upload_sessions SET status = 'COMPLETE', lease_expires_at = NULL
         WHERE id = ? AND status = 'UPLOADING' AND lease_expires_at > ?
           AND EXISTS (
             SELECT 1 FROM assets a JOIN designs d ON d.id = a.design_id
             WHERE a.id = asset_upload_sessions.asset_id AND a.status = 'QUARANTINED'
               AND d.status = 'DRAFT'
           )`,
      ).bind(session.upload_id, finalizedAt),
    ]);
    if (finalized[0]?.meta.changes !== 1 || finalized[1]?.meta.changes !== 1) {
      throw new Error("Uploaded asset metadata could not be persisted for the active design");
    }
  } catch (error) {
    let binaryRemoved = false;
    try {
      await env.STORAGE.delete(session.object_key);
      binaryRemoved = true;
    } catch (cleanupError) {
      logSafeError("asset.incomplete_upload_cleanup_failed", "storage", cleanupError, {
        request_id: requestId,
        environment: env.ENVIRONMENT,
      });
    }
    try {
      if (binaryRemoved) {
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE assets
             SET status = 'PENDING', sha256 = '', width = NULL, height = NULL, updated_at = ?
             WHERE id = ? AND customer_id = ? AND status IN ('PENDING','QUARANTINED')
               AND EXISTS (
                 SELECT 1 FROM designs
                 WHERE id = assets.design_id AND customer_id = ? AND status = 'DRAFT'
               )
               AND EXISTS (
                 SELECT 1 FROM asset_upload_sessions
                 WHERE asset_id = assets.id AND status IN ('UPLOADING','COMPLETE')
               )`,
          ).bind(nowIso(), assetId, session.customer_id, session.customer_id),
          env.DB.prepare(
            `UPDATE asset_upload_sessions
             SET status = 'PENDING', used_at = NULL, lease_expires_at = NULL
             WHERE id = ? AND status IN ('UPLOADING','COMPLETE')
               AND EXISTS (
                 SELECT 1 FROM assets a JOIN designs d ON d.id = a.design_id
                 WHERE a.id = asset_upload_sessions.asset_id AND a.status = 'PENDING'
                   AND d.status = 'DRAFT'
               )`,
          ).bind(session.upload_id),
          env.DB.prepare(
            `UPDATE assets SET status = 'DELETION_PENDING', updated_at = ?
             WHERE id = ? AND customer_id = ? AND status IN ('PENDING','QUARANTINED')
               AND EXISTS (
                 SELECT 1 FROM designs
                 WHERE id = assets.design_id AND customer_id = ? AND status <> 'DRAFT'
               )`,
          ).bind(nowIso(), assetId, session.customer_id, session.customer_id),
          env.DB.prepare(
            `UPDATE asset_upload_sessions SET status = 'CANCELLED', lease_expires_at = NULL
             WHERE id = ? AND status IN ('UPLOADING','COMPLETE')
               AND EXISTS (
                 SELECT 1 FROM designs d JOIN assets a ON a.design_id = d.id
                 WHERE a.id = asset_upload_sessions.asset_id AND d.status <> 'DRAFT'
               )`,
          ).bind(session.upload_id),
        ]);
      } else {
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE assets SET status = 'DELETION_PENDING', updated_at = ?
             WHERE id = ? AND customer_id = ? AND status IN ('PENDING','QUARANTINED')`,
          ).bind(nowIso(), assetId, session.customer_id),
          env.DB.prepare(
            `UPDATE asset_upload_sessions SET status = 'CANCELLED', lease_expires_at = NULL
             WHERE id = ? AND status IN ('UPLOADING','COMPLETE')`,
          ).bind(session.upload_id),
        ]);
      }
    } catch (stateError) {
      logSafeError("asset.incomplete_upload_state_update_failed", "database", stateError, {
        request_id: requestId,
        environment: env.ENVIRONMENT,
      });
    }
    logSafeError("asset.upload_failed", "storage", error, {
      request_id: requestId,
      environment: env.ENVIRONMENT,
    });
    return apiError(requestId, binaryRemoved ? 502 : 503,
      binaryRemoved ? "UPLOAD_FAILED" : "UPLOAD_CLEANUP_PENDING",
      binaryRemoved
        ? "The image could not be saved. You can safely retry the upload."
        : "The image was not saved and cleanup is pending; retry removing this photo before uploading again.");
  }
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store", "X-Request-ID": requestId },
  });
}

async function completeUpload(
  request: Request,
  env: Env,
  requestId: string,
  assetId: string,
): Promise<Response> {
  if (!env.STORAGE) return apiError(requestId, 503, "STORAGE_UNAVAILABLE", "Private media storage is unavailable");
  const required = await requireSession(request, env, requestId);
  if (required.response) return required.response;
  const csrf = await requireCsrf(request, env, required.session!, requestId);
  if (csrf) return csrf;
  const asset = await env.DB.prepare(
    `SELECT a.object_key, a.media_type, a.byte_size, a.sha256, a.width, a.height,
            a.status, d.status AS design_status, u.status AS upload_status
     FROM assets a JOIN designs d ON d.id = a.design_id
     LEFT JOIN asset_upload_sessions u ON u.asset_id = a.id
     WHERE a.id = ? AND a.customer_id = ?`,
  ).bind(assetId, required.session!.customerId).first<{
    object_key: string;
    media_type: string;
    byte_size: number;
    sha256: string;
    width: number | null;
    height: number | null;
    status: string;
    design_status: string;
    upload_status: string | null;
  }>();
  if (!asset) return apiError(requestId, 404, "NOT_FOUND", "Asset not found");
  if (asset.status !== "QUARANTINED" || asset.upload_status !== "COMPLETE" ||
      asset.design_status !== "DRAFT") {
    return apiError(requestId, 409, "UPLOAD_CANCELLED",
      "This upload cannot be finalized because its design is no longer an active draft.");
  }
  const object = await env.STORAGE.get(asset.object_key);
  if (!object || object.size !== asset.byte_size || object.contentType !== asset.media_type) {
    return apiError(requestId, 409, "UPLOAD_NOT_READY", "Uploaded image is unavailable");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  const info = detectImage(bytes);
  if (!info || info.contentType !== asset.media_type || await sha256(bytes) !== asset.sha256 ||
      info.width !== asset.width || info.height !== asset.height) {
    await env.STORAGE.delete(asset.object_key);
    const rejected = await env.DB.prepare(
      `UPDATE assets SET status = 'REJECTED', updated_at = ?
       WHERE id = ? AND customer_id = ? AND status = 'QUARANTINED'
         AND EXISTS (
           SELECT 1 FROM designs
           WHERE id = assets.design_id AND customer_id = ? AND status = 'DRAFT'
         )
         AND EXISTS (
           SELECT 1 FROM asset_upload_sessions
           WHERE asset_id = assets.id AND status = 'COMPLETE'
         )`,
    ).bind(nowIso(), assetId, required.session!.customerId, required.session!.customerId).run();
    if (rejected.meta.changes !== 1) {
      return apiError(requestId, 409, "UPLOAD_CANCELLED",
        "This upload was cancelled because its design changed or was deleted.");
    }
    return apiError(requestId, 422, "UPLOAD_REJECTED", "Uploaded image failed verification");
  }
  const result = await env.DB.prepare(
    `UPDATE assets SET status = 'READY', updated_at = ?
     WHERE id = ? AND customer_id = ? AND status = 'QUARANTINED'
       AND EXISTS (
         SELECT 1 FROM designs
         WHERE id = assets.design_id AND customer_id = ? AND status = 'DRAFT'
       )
       AND EXISTS (
         SELECT 1 FROM asset_upload_sessions
         WHERE asset_id = assets.id AND status = 'COMPLETE'
       )`,
  ).bind(nowIso(), assetId, required.session!.customerId, required.session!.customerId).run();
  if (result.meta.changes !== 1) {
    return apiError(requestId, 409, "UPLOAD_CANCELLED",
      "This upload was cancelled because its design changed or was deleted.");
  }
  return jsonResponse({
    asset_id: assetId,
    media_type: asset.media_type,
    byte_size: asset.byte_size,
    width: asset.width,
    height: asset.height,
    status: "READY",
  }, 200, requestId);
}

async function deleteAsset(
  request: Request,
  env: Env,
  requestId: string,
  assetId: string,
): Promise<Response> {
  if (!env.STORAGE) return apiError(requestId, 503, "STORAGE_UNAVAILABLE", "Private media storage is unavailable");
  const required = await requireSession(request, env, requestId);
  if (required.response) return required.response;
  const csrf = await requireCsrf(request, env, required.session!, requestId);
  if (csrf) return csrf;
  const asset = await env.DB.prepare(
    `SELECT a.object_key, a.design_id, a.status, d.data_json, d.template_id,
            EXISTS (
              SELECT 1 FROM asset_upload_sessions u
              WHERE u.asset_id = a.id AND u.status = 'UPLOADING'
                AND u.lease_expires_at > ?
            ) AS upload_in_progress
     FROM assets a JOIN designs d ON d.id = a.design_id
     WHERE a.id = ? AND a.customer_id = ?`,
  ).bind(nowIso(), assetId, required.session!.customerId).first<{
    object_key: string;
    design_id: string;
    status: string;
    data_json: string;
    template_id: string;
    upload_in_progress: number;
  }>();
  if (!asset) return apiError(requestId, 404, "NOT_FOUND", "Asset not found");
  if (asset.status === "DELETED") {
    try {
      await env.STORAGE.delete(asset.object_key);
    } catch (error) {
      logSafeError("asset.deletion_failed", "storage", error, {
        request_id: requestId,
        environment: env.ENVIRONMENT,
      });
      return apiError(requestId, 503, "DELETION_PENDING", "Asset deletion will be retried");
    }
    return jsonResponse({ deleted: true }, 200, requestId);
  }
  if (asset.upload_in_progress) {
    return apiError(requestId, 409, "UPLOAD_IN_PROGRESS",
      "This photo is still uploading. Try removing it again after the upload finishes.");
  }
  if (asset.status === "READY") {
    const design = JSON.parse(asset.data_json) as TemplateData;
    if (assetReferences(asset.template_id, design).includes(assetId)) {
      return apiError(requestId, 409, "ASSET_IN_USE", "Remove this photo from the design before deleting it");
    }
  }
  const activeConsent = await env.DB.prepare(
    `SELECT pa.id FROM publication_assets pa
     JOIN publications p ON p.id = pa.publication_id
     WHERE pa.asset_id = ? AND pa.customer_id = ? AND pa.revoked_at IS NULL
       AND p.status IN ('PUBLISHED','UNPUBLISHED') LIMIT 1`,
  ).bind(assetId, required.session!.customerId).first<{ id: string }>();
  if (activeConsent) {
    return apiError(requestId, 409, "ASSET_IN_USE", "Revoke publication consent before deleting this photo");
  }
  const claimTime = nowIso();
  const deletionClaim = await env.DB.batch([
    env.DB.prepare(
      `UPDATE assets SET status = 'DELETION_PENDING', updated_at = ?
       WHERE id = ? AND customer_id = ? AND status = ?
         AND NOT EXISTS (
           SELECT 1 FROM asset_upload_sessions
           WHERE asset_id = assets.id AND status = 'UPLOADING'
             AND lease_expires_at > ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM publication_assets pa
           JOIN publications p ON p.id = pa.publication_id
           WHERE pa.asset_id = assets.id AND pa.revoked_at IS NULL
             AND p.status IN ('PUBLISHED','UNPUBLISHED')
         )`,
    ).bind(claimTime, assetId, required.session!.customerId, asset.status, claimTime),
    env.DB.prepare(
      `UPDATE asset_upload_sessions
       SET status = 'CANCELLED', lease_expires_at = NULL, used_at = COALESCE(used_at, ?)
       WHERE asset_id = ? AND status IN ('PENDING','UPLOADING')
         AND (status = 'PENDING' OR lease_expires_at <= ?)
         AND EXISTS (
           SELECT 1 FROM assets
           WHERE id = ? AND customer_id = ? AND status = 'DELETION_PENDING'
         )`,
    ).bind(claimTime, assetId, claimTime, assetId, required.session!.customerId),
  ]);
  if (deletionClaim[0]?.meta.changes !== 1) {
    return apiError(requestId, 409, "ASSET_IN_USE",
      "This photo changed or is still in use; reload the design before removing it.");
  }
  try {
    await env.STORAGE.delete(asset.object_key);
  } catch (error) {
    logSafeError("asset.deletion_failed", "storage", error, {
      request_id: requestId,
      environment: env.ENVIRONMENT,
    });
    return apiError(requestId, 503, "DELETION_PENDING", "Asset deletion will be retried");
  }
  const now = nowIso();
  const finalized = await env.DB.batch([
    env.DB.prepare(
      `UPDATE assets SET status = 'DELETED', deleted_at = ?, updated_at = ?
       WHERE id = ? AND customer_id = ? AND status = 'DELETION_PENDING'`,
    ).bind(now, now, assetId, required.session!.customerId),
    env.DB.prepare(
      "UPDATE preview_tokens SET revoked_at = ? WHERE design_id = ? AND revoked_at IS NULL",
    ).bind(now, asset.design_id),
  ]);
  if (finalized[0]?.meta.changes !== 1) {
    const current = await env.DB.prepare(
      "SELECT status FROM assets WHERE id = ? AND customer_id = ?",
    ).bind(assetId, required.session!.customerId).first<{ status: string }>();
    if (current?.status !== "DELETED") {
      return apiError(requestId, 503, "DELETION_PENDING", "Asset deletion will be retried");
    }
  }
  return jsonResponse({ deleted: true }, 200, requestId);
}

export async function handleAssetRoutes(
  request: Request,
  env: Env,
  path: string,
  requestId: string,
): Promise<Response | null> {
  if (path === "/api/v1/assets/upload-url" && request.method === "POST") {
    return createUpload(request, env, requestId);
  }
  const match = path.match(/^\/api\/v1\/assets\/([0-9a-f-]{36})(?:\/(content|complete))?$/i);
  if (!match) return null;
  const [, assetId, action] = match;
  if (action === "content" && request.method === "PUT") {
    return uploadContent(request, env, requestId, assetId);
  }
  if (action === "complete" && request.method === "POST") {
    return completeUpload(request, env, requestId, assetId);
  }
  if (action) return apiError(requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
  const required = await requireSession(request, env, requestId);
  if (required.response) return required.response;
  if (request.method === "GET") {
    const asset = await env.DB.prepare(
      "SELECT design_id FROM assets WHERE id = ? AND customer_id = ? AND status = 'READY'",
    ).bind(assetId, required.session!.customerId).first<{ design_id: string }>();
    if (!asset) return apiError(requestId, 404, "NOT_FOUND", "Asset not found");
    return serveAsset(request, env, requestId, assetId, required.session!.customerId, asset.design_id);
  }
  if (request.method === "DELETE") return deleteAsset(request, env, requestId, assetId);
  return apiError(requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
}

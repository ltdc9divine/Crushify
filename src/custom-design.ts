import { requireCsrf, requireSession } from "./auth.ts";
import {
  apiError,
  jsonResponse,
  nowIso,
  readJson,
  safeId,
  sha256,
} from "./http.ts";
import type { Env } from "./types.ts";

const REQUEST_PATH = "/api/v1/custom-design/requests";
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const PREFERRED_TEMPLATES = new Set([
  "not_sure",
  "custom",
  "our-universe",
  "love-letter",
  "our-memories",
  "say-yes",
  "distance-means-nothing",
]);

interface CustomDesignRequestRow {
  id: string;
  preferred_template: string;
  brief: string;
  requirements: string;
  requested_delivery_date: string | null;
  reference_urls_json: string;
  status: string;
  communication_status: string;
  customer_message: string | null;
  customer_reply: string | null;
  customer_reply_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ValidatedRequest {
  preferred_template: string;
  brief: string;
  requirements: string;
  requested_delivery_date: string | null;
  reference_urls: string[];
  assets_rights_confirmed: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateRequest(value: unknown): { value?: ValidatedRequest; fields?: Record<string, string> } {
  const keys = [
    "preferred_template",
    "brief",
    "requirements",
    "requested_delivery_date",
    "reference_urls",
    "assets_rights_confirmed",
  ];
  if (!isRecord(value) || Object.keys(value).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(value, key))) {
    return { fields: { request: "Thông tin yêu cầu không hợp lệ." } };
  }

  const preferredTemplate = value.preferred_template;
  const brief = value.brief;
  const requirements = value.requirements;
  const requestedDate = value.requested_delivery_date;
  const urls = value.reference_urls;
  if (typeof preferredTemplate !== "string" || !PREFERRED_TEMPLATES.has(preferredTemplate)) {
    return { fields: { preferred_template: "Hãy chọn một mẫu có sẵn hoặc yêu cầu thiết kế riêng." } };
  }
  if (typeof brief !== "string" || !brief.trim() || brief.length > 5000) {
    return { fields: { brief: "Mô tả ý tưởng là bắt buộc và tối đa 5.000 ký tự." } };
  }
  if (typeof requirements !== "string" || requirements.length > 5000) {
    return { fields: { requirements: "Yêu cầu bổ sung tối đa 5.000 ký tự." } };
  }
  if (typeof requestedDate !== "string" ||
      (requestedDate !== "" && !validDate(requestedDate))) {
    return { fields: { requested_delivery_date: "Ngày mong muốn không hợp lệ." } };
  }
  if (!Array.isArray(urls) || urls.length > 5 ||
      !urls.every((item) => typeof item === "string")) {
    return { fields: { reference_urls: "Tối đa 5 đường dẫn tham khảo được hỗ trợ." } };
  }
  const normalizedUrls: string[] = [];
  for (const rawUrl of urls as string[]) {
    const trimmed = rawUrl.trim();
    if (!trimmed) continue;
    if (trimmed.length > 2048) {
      return { fields: { reference_urls: "Mỗi đường dẫn tối đa 2.048 ký tự." } };
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return { fields: { reference_urls: "Đường dẫn tham khảo phải là URL HTTPS hợp lệ." } };
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      return { fields: { reference_urls: "Đường dẫn tham khảo phải dùng HTTPS và không chứa thông tin đăng nhập." } };
    }
    if (!normalizedUrls.includes(parsed.href)) normalizedUrls.push(parsed.href);
  }
  if (value.assets_rights_confirmed !== true) {
    return { fields: { assets_rights_confirmed: "Cần xác nhận quyền sử dụng tài liệu bạn gửi." } };
  }

  return {
    value: {
      preferred_template: preferredTemplate,
      brief: brief.trim(),
      requirements: requirements.trim(),
      requested_delivery_date: requestedDate || null,
      reference_urls: normalizedUrls,
      assets_rights_confirmed: true,
    },
  };
}

function responseRequest(row: CustomDesignRequestRow) {
  return {
    request_id: row.id,
    preferred_template: row.preferred_template,
    brief: row.brief,
    requirements: row.requirements,
    requested_delivery_date: row.requested_delivery_date,
    reference_urls: JSON.parse(row.reference_urls_json) as string[],
    status: row.status,
    communication_status: row.communication_status,
    customer_message: row.customer_message,
    customer_reply: row.customer_reply,
    customer_reply_at: row.customer_reply_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function handleCustomDesignRoutes(
  request: Request,
  env: Env,
  path: string,
  requestId: string,
): Promise<Response | null> {
  if (path === REQUEST_PATH && request.method === "GET") {
    const required = await requireSession(request, env, requestId);
    if (required.response) return required.response;
    const result = await env.DB.prepare(
      `SELECT id, preferred_template, brief, requirements, requested_delivery_date,
              reference_urls_json, status, communication_status, customer_message,
              (SELECT message FROM custom_design_customer_replies reply
               WHERE reply.request_id = custom_design_requests.id
               ORDER BY reply.created_at DESC, reply.id DESC LIMIT 1) AS customer_reply,
              (SELECT created_at FROM custom_design_customer_replies reply
               WHERE reply.request_id = custom_design_requests.id
               ORDER BY reply.created_at DESC, reply.id DESC LIMIT 1) AS customer_reply_at,
              created_at, updated_at
       FROM custom_design_requests
       WHERE customer_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 50`,
    ).bind(required.session!.customerId).all<CustomDesignRequestRow>();
    return jsonResponse({ requests: result.results.map(responseRequest) }, 200, requestId);
  }

  if (path === REQUEST_PATH && request.method === "POST") {
    const required = await requireSession(request, env, requestId);
    if (required.response) return required.response;
    const csrf = await requireCsrf(request, env, required.session!, requestId);
    if (csrf) return csrf;
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
      return apiError(requestId, 400, "IDEMPOTENCY_KEY_REQUIRED", "A valid idempotency key is required");
    }
    const parsed = await readJson(request, requestId);
    if (parsed.response) return parsed.response;
    const validated = validateRequest(parsed.value);
    if (!validated.value) {
      return apiError(requestId, 422, "VALIDATION_ERROR", "Please review the request details", validated.fields);
    }

    const customerId = required.session!.customerId;
    const normalized = validated.value;
    const requestHash = await sha256(JSON.stringify(normalized));
    const existing = await env.DB.prepare(
      `SELECT id, request_hash FROM custom_design_requests
       WHERE customer_id = ? AND idempotency_key = ?`,
    ).bind(customerId, idempotencyKey).first<{ id: string; request_hash: string }>();
    if (existing) {
      if (existing.request_hash !== requestHash) {
        return apiError(requestId, 409, "IDEMPOTENCY_CONFLICT", "This request key was already used for different content");
      }
      const row = await loadRequest(env, customerId, existing.id);
      if (!row) throw new Error("Custom design request disappeared after idempotent lookup");
      return jsonResponse(responseRequest(row), 200, requestId);
    }

    const limitStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recent = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM custom_design_requests
       WHERE customer_id = ? AND created_at >= ?`,
    ).bind(customerId, limitStart).first<{ count: number }>();
    if ((recent?.count ?? 0) >= 5) {
      return apiError(requestId, 429, "REQUEST_LIMIT_REACHED", "Too many custom design requests; try again later");
    }

    const id = safeId();
    const now = nowIso();
    const inserted = await env.DB.prepare(
      `INSERT INTO custom_design_requests (
         id, customer_id, idempotency_key, request_hash, preferred_template, brief,
         requirements, requested_delivery_date, reference_urls_json,
         assets_rights_confirmed, status, communication_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'QUOTE_PENDING', 'AWAITING_REVIEW', ?, ?)
       ON CONFLICT(customer_id, idempotency_key) DO NOTHING`,
    ).bind(
      id,
      customerId,
      idempotencyKey,
      requestHash,
      normalized.preferred_template,
      normalized.brief,
      normalized.requirements,
      normalized.requested_delivery_date,
      JSON.stringify(normalized.reference_urls),
      now,
      now,
    ).run();
    const row = await loadRequestByKey(env, customerId, idempotencyKey);
    if (!row) throw new Error("Custom design request could not be reloaded after insert");
    if (row.id !== id && row.request_hash !== requestHash) {
      return apiError(requestId, 409, "IDEMPOTENCY_CONFLICT", "This request key was already used for different content");
    }
    return jsonResponse(responseRequest(row), inserted.meta.changes === 1 ? 201 : 200, requestId);
  }

  const replyMatch = path.match(
    /^\/api\/v1\/custom-design\/requests\/([0-9a-f-]{36})\/replies$/i,
  );
  if (replyMatch && request.method === "POST") {
    return submitCustomerReply(request, env, requestId, replyMatch[1]);
  }

  const match = path.match(/^\/api\/v1\/custom-design\/requests\/([0-9a-f-]{36})$/i);
  if (match && request.method === "GET") {
    if (!REQUEST_ID.test(match[1])) {
      return apiError(requestId, 400, "INVALID_REQUEST_ID", "Request ID is invalid");
    }
    const required = await requireSession(request, env, requestId);
    if (required.response) return required.response;
    const row = await loadRequest(env, required.session!.customerId, match[1]);
    if (!row) return apiError(requestId, 404, "NOT_FOUND", "Custom design request not found");
    return jsonResponse(responseRequest(row), 200, requestId);
  }

  return null;
}

async function loadRequest(
  env: Env,
  customerId: string,
  requestId: string,
): Promise<CustomDesignRequestRow | null> {
  return env.DB.prepare(
    `SELECT id, preferred_template, brief, requirements, requested_delivery_date,
            reference_urls_json, status, communication_status, customer_message,
            (SELECT message FROM custom_design_customer_replies reply
             WHERE reply.request_id = custom_design_requests.id
             ORDER BY reply.created_at DESC, reply.id DESC LIMIT 1) AS customer_reply,
            (SELECT created_at FROM custom_design_customer_replies reply
             WHERE reply.request_id = custom_design_requests.id
             ORDER BY reply.created_at DESC, reply.id DESC LIMIT 1) AS customer_reply_at,
            created_at, updated_at
     FROM custom_design_requests WHERE id = ? AND customer_id = ?`,
  ).bind(requestId, customerId).first<CustomDesignRequestRow>();
}

async function submitCustomerReply(
  request: Request,
  env: Env,
  requestId: string,
  customRequestId: string,
): Promise<Response> {
  if (!REQUEST_ID.test(customRequestId)) {
    return apiError(requestId, 400, "INVALID_REQUEST_ID", "Request ID is invalid");
  }
  const required = await requireSession(request, env, requestId);
  if (required.response) return required.response;
  const csrf = await requireCsrf(request, env, required.session!, requestId);
  if (csrf) return csrf;

  const idempotencyKey = request.headers.get("idempotency-key") ?? "";
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
    return apiError(requestId, 400, "IDEMPOTENCY_KEY_REQUIRED", "A valid idempotency key is required");
  }
  const parsed = await readJson(request, requestId);
  if (parsed.response) return parsed.response;
  if (!isRecord(parsed.value) || Object.keys(parsed.value).length !== 1 ||
      typeof parsed.value.message !== "string") {
    return apiError(requestId, 422, "VALIDATION_ERROR", "Customer reply is invalid");
  }
  const message = parsed.value.message.trim();
  if (!message || message.length > 2000) {
    return apiError(requestId, 422, "VALIDATION_ERROR", "Customer reply must be 1–2,000 characters");
  }

  const customerId = required.session!.customerId;
  const replyHash = await sha256(message);
  const existing = await env.DB.prepare(
    `SELECT reply_hash FROM custom_design_customer_replies
     WHERE request_id = ? AND customer_id = ? AND idempotency_key = ?`,
  ).bind(customRequestId, customerId, idempotencyKey).first<{ reply_hash: string }>();
  if (existing) {
    if (existing.reply_hash !== replyHash) {
      return apiError(requestId, 409, "IDEMPOTENCY_CONFLICT", "This reply key was already used for different content");
    }
    const row = await loadRequest(env, customerId, customRequestId);
    if (!row) return apiError(requestId, 404, "NOT_FOUND", "Custom design request not found");
    return jsonResponse(responseRequest(row), 200, requestId);
  }

  const current = await env.DB.prepare(
    `SELECT status, communication_status FROM custom_design_requests
     WHERE id = ? AND customer_id = ?`,
  ).bind(customRequestId, customerId).first<{
    status: string;
    communication_status: string;
  }>();
  if (!current) return apiError(requestId, 404, "NOT_FOUND", "Custom design request not found");
  if (current.status !== "CUSTOMER_ACTION_REQUIRED" ||
      current.communication_status !== "CUSTOMER_ACTION_REQUIRED") {
    return apiError(requestId, 409, "INVALID_STATE_TRANSITION", "This request is not waiting for a customer reply");
  }

  const now = nowIso();
  const replyId = safeId();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE custom_design_requests
       SET status = 'IN_REVIEW', communication_status = 'RESPONDED',
           customer_reply_submission_token = ?, updated_at = ?
       WHERE id = ? AND customer_id = ? AND status = 'CUSTOMER_ACTION_REQUIRED'
         AND communication_status = 'CUSTOMER_ACTION_REQUIRED'`,
    ).bind(replyId, now, customRequestId, customerId),
    env.DB.prepare(
      `INSERT INTO custom_design_customer_replies (
         id, request_id, customer_id, idempotency_key, reply_hash, message,
         from_status, to_status, from_communication_status, to_communication_status,
         created_at
       )
       SELECT ?, ?, ?, ?, ?, ?, 'CUSTOMER_ACTION_REQUIRED', 'IN_REVIEW',
              'CUSTOMER_ACTION_REQUIRED', 'RESPONDED', ?
       WHERE EXISTS (
         SELECT 1 FROM custom_design_requests
         WHERE id = ? AND customer_id = ? AND status = 'IN_REVIEW'
           AND communication_status = 'RESPONDED'
           AND customer_reply_submission_token = ?
       )
       ON CONFLICT(request_id, idempotency_key) DO NOTHING`,
    ).bind(
      replyId,
      customRequestId,
      customerId,
      idempotencyKey,
      replyHash,
      message,
      now,
      customRequestId,
      customerId,
      replyId,
    ),
    env.DB.prepare(
      `UPDATE custom_design_requests SET customer_reply_submission_token = NULL
       WHERE id = ? AND customer_id = ? AND customer_reply_submission_token = ?`,
    ).bind(customRequestId, customerId, replyId),
  ]);
  if (results[0]?.meta.changes !== 1) {
    const raced = await env.DB.prepare(
      `SELECT reply_hash FROM custom_design_customer_replies
       WHERE request_id = ? AND customer_id = ? AND idempotency_key = ?`,
    ).bind(customRequestId, customerId, idempotencyKey).first<{ reply_hash: string }>();
    if (raced?.reply_hash === replyHash) {
      const row = await loadRequest(env, customerId, customRequestId);
      if (row) return jsonResponse(responseRequest(row), 200, requestId);
    }
    return apiError(requestId, 409, "INVALID_STATE_TRANSITION", "The request changed; reload before replying");
  }
  if (results[1]?.meta.changes !== 1) {
    throw new Error("Custom design customer reply was not recorded");
  }
  if (results[2]?.meta.changes !== 1) {
    throw new Error("Custom design customer reply submission token was not cleared");
  }
  const row = await loadRequest(env, customerId, customRequestId);
  if (!row) throw new Error("Custom design request disappeared after customer reply");
  return jsonResponse(responseRequest(row), 201, requestId);
}

async function loadRequestByKey(
  env: Env,
  customerId: string,
  idempotencyKey: string,
): Promise<(CustomDesignRequestRow & { request_hash: string }) | null> {
  return env.DB.prepare(
    `SELECT id, request_hash, preferred_template, brief, requirements,
            requested_delivery_date, reference_urls_json, status,
          communication_status, customer_message,
            (SELECT message FROM custom_design_customer_replies reply
             WHERE reply.request_id = custom_design_requests.id
             ORDER BY reply.created_at DESC, reply.id DESC LIMIT 1) AS customer_reply,
            (SELECT created_at FROM custom_design_customer_replies reply
             WHERE reply.request_id = custom_design_requests.id
             ORDER BY reply.created_at DESC, reply.id DESC LIMIT 1) AS customer_reply_at,
            created_at, updated_at
     FROM custom_design_requests WHERE customer_id = ? AND idempotency_key = ?`,
  ).bind(customerId, idempotencyKey).first<CustomDesignRequestRow & { request_hash: string }>();
}

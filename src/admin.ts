import { requireCsrf, requireSession } from "./auth.ts";
import { apiError, jsonResponse, nowIso, readJson, safeId } from "./http.ts";
import {
  reconcilePublicationDerivativeCleanup,
  recoverPendingFulfillments,
} from "./publications.ts";
import { confirmManualPayment } from "./payments/manual-settlement.ts";
import { resolvePaymentEnvironmentPolicy } from "./payments/policy.ts";
import type { Env, Session } from "./types.ts";

const ADMIN_EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
const CUSTOM_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CUSTOMER_MESSAGE_LENGTH = 2000;

interface AdminSession {
  session: Session;
}

interface ReviewInput {
  action: "start_review" | "request_information" | "reply";
  customer_message?: string;
}

type AdminActivityAction =
  | "OPERATIONS_VIEWED"
  | "CUSTOM_DESIGN_START_REVIEW"
  | "CUSTOM_DESIGN_REQUEST_INFORMATION"
  | "CUSTOM_DESIGN_REPLY"
  | "FULFILLMENT_RECOVERY"
  | "PUBLICATION_DERIVATIVE_RECONCILIATION";

type AdminActivityOutcome = "STARTED" | "COMPLETED" | "FAILED";
type AdminActivityTarget =
  | "ADMIN_OPERATIONS"
  | "CUSTOM_DESIGN_REQUEST"
  | "FULFILLMENT_JOBS"
  | "PUBLICATION_DERIVATIVE_OPERATIONS";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function recordAdminActivity(
  env: Env,
  admin: AdminSession,
  requestId: string,
  action: AdminActivityAction,
  outcome: AdminActivityOutcome,
  targetType: AdminActivityTarget,
  targetId: string | null = null,
): Promise<void> {
  const result = await env.DB.prepare(
    `INSERT INTO admin_activity_events (
       id, actor_customer_id, request_id, action, outcome, target_type, target_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    safeId(),
    admin.session.customerId,
    requestId,
    action,
    outcome,
    targetType,
    targetId,
    nowIso(),
  ).run();
  if (result.meta.changes !== 1) throw new Error("Admin activity event was not recorded");
}

async function runAuditedAdminAction(
  env: Env,
  admin: AdminSession,
  requestId: string,
  action: AdminActivityAction,
  targetType: AdminActivityTarget,
  run: () => Promise<Response>,
): Promise<Response> {
  await recordAdminActivity(env, admin, requestId, action, "STARTED", targetType);
  try {
    const response = await run();
    await recordAdminActivity(env, admin, requestId, action, "COMPLETED", targetType);
    return response;
  } catch (error) {
    try {
      await recordAdminActivity(env, admin, requestId, action, "FAILED", targetType);
    } catch (auditError) {
      throw new AggregateError(
        [error, auditError],
        "Admin operation failed and its failure audit could not be recorded",
      );
    }
    throw error;
  }
}

function adminEmails(env: Env): Set<string> | null {
  const configured = env.ADMIN_EMAILS?.split(",").map((email) => email.trim().toLowerCase());
  if (!configured?.length || configured.some((email) => !email || !ADMIN_EMAIL.test(email))) {
    return null;
  }
  return new Set(configured);
}

async function requireAdmin(
  request: Request,
  env: Env,
  requestId: string,
): Promise<{ admin?: AdminSession; response?: Response }> {
  const required = await requireSession(request, env, requestId);
  if (required.response) return { response: required.response };

  const allowedEmails = adminEmails(env);
  if (!allowedEmails) {
    return {
      response: apiError(requestId, 503, "ADMIN_DISABLED", "Admin access is not configured"),
    };
  }

  const customer = await env.DB.prepare(
    "SELECT email_normalized FROM customers WHERE id = ? AND status = 'ACTIVE'",
  ).bind(required.session!.customerId).first<{ email_normalized: string }>();
  if (!customer || !allowedEmails.has(customer.email_normalized)) {
    return { response: apiError(requestId, 403, "FORBIDDEN", "Administrator access is required") };
  }
  return { admin: { session: required.session! } };
}

async function requireAdminMutation(
  request: Request,
  env: Env,
  requestId: string,
): Promise<{ admin?: AdminSession; response?: Response }> {
  const required = await requireAdmin(request, env, requestId);
  if (required.response) return required;
  const csrf = await requireCsrf(request, env, required.admin!.session, requestId);
  return csrf ? { response: csrf } : required;
}

async function operationsSnapshot(
  env: Env,
  requestId: string,
  admin: AdminSession,
): Promise<Response> {
  const [
    orders,
    payments,
    settlementEvidence,
    webhookReviews,
    fulfillmentJobs,
    publications,
    derivativeOperations,
    customRequests,
    pendingManualPayments,
    manualPaymentConfirmations,
  ] =
    await Promise.all([
      env.DB.prepare(
        `SELECT o.id, o.order_reference, o.order_type, o.status, o.currency,
                o.total_minor, o.payment_review_required, o.renewal_publication_id,
                o.created_at, o.expires_at, d.template_id, c.email
         FROM orders o
         JOIN customers c ON c.id = o.customer_id
         LEFT JOIN designs d ON d.id = o.design_id
         ORDER BY o.created_at DESC, o.id DESC
         LIMIT 50`,
      ).all<{
        id: string;
        order_reference: string | null;
        order_type: string;
        status: string;
        currency: string;
        total_minor: number;
        payment_review_required: number;
        renewal_publication_id: string | null;
        created_at: string;
        expires_at: string | null;
        template_id: string | null;
        email: string;
      }>(),
      env.DB.prepare(
        `SELECT p.id, p.order_id, o.order_reference, o.status AS order_status,
                c.email, p.provider, p.status, p.amount_minor, p.currency,
                p.review_required, p.provider_payment_id, p.created_at, p.updated_at
         FROM payments p
         JOIN orders o ON o.id = p.order_id
         JOIN customers c ON c.id = o.customer_id
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT 50`,
      ).all(),
      env.DB.prepare(
        `SELECT evidence.id, evidence.payment_id, payment.order_id,
                order_row.order_reference, evidence.provider, evidence.evidence_source,
                evidence.source_transaction_id, evidence.receiving_bank_account_id,
                evidence.amount_minor, evidence.currency, evidence.status,
                evidence.verified_at, evidence.created_at
         FROM payment_settlement_evidence evidence
         JOIN payments payment ON payment.id = evidence.payment_id
         JOIN orders order_row ON order_row.id = payment.order_id
         ORDER BY evidence.created_at DESC, evidence.id DESC
         LIMIT 50`,
      ).all(),
      env.DB.prepare(
        `SELECT id, provider, event_id, order_reference, expected_amount_minor,
                actual_amount_minor, outcome, review_reason, received_at, processed_at
         FROM payment_webhook_events
         WHERE outcome = 'MANUAL_REVIEW' OR review_reason IS NOT NULL
         ORDER BY received_at DESC, id DESC
         LIMIT 50`,
      ).all(),
      env.DB.prepare(
        `SELECT job.id, job.order_id, o.order_reference, o.status AS order_status,
                c.email, job.status, job.attempts, job.last_error_code,
                job.next_attempt_at, job.lease_expires_at, job.created_at, job.updated_at
         FROM fulfillment_jobs job
         JOIN orders o ON o.id = job.order_id
         JOIN customers c ON c.id = o.customer_id
         ORDER BY job.updated_at DESC, job.id DESC
         LIMIT 50`,
      ).all(),
      env.DB.prepare(
        `SELECT p.id, p.order_id, o.order_reference, c.email, p.template_id,
                p.status, p.lifecycle_revision, p.activated_at, p.expires_at,
                p.retention_delete_after_at, entitlement.status AS entitlement_status,
                entitlement.expires_at AS entitlement_expires_at
         FROM publications p
         LEFT JOIN orders o ON o.id = p.order_id
         LEFT JOIN customers c ON c.id = o.customer_id
         LEFT JOIN storage_entitlements entitlement ON entitlement.publication_id = p.id
         ORDER BY p.updated_at DESC, p.id DESC
         LIMIT 50`,
      ).all(),
      env.DB.prepare(
        `SELECT operation.id, operation.publication_id, operation.publication_asset_id,
                operation.status, operation.cleanup_attempts, operation.last_cleanup_error_code,
                operation.next_cleanup_at, operation.cleanup_lease_expires_at,
                operation.updated_at
         FROM publication_derivative_operations operation
         WHERE operation.status IN ('CLEANUP_PENDING','MANUAL_REVIEW','CREATING')
         ORDER BY operation.next_cleanup_at, operation.id
         LIMIT 50`,
      ).all(),
      env.DB.prepare(
        `SELECT request.id, request.preferred_template, request.brief,
                request.requirements, request.requested_delivery_date,
                request.reference_urls_json, request.status, request.communication_status,
                request.customer_message, request.created_at, request.updated_at,
                (SELECT message FROM custom_design_customer_replies reply
                 WHERE reply.request_id = request.id
                 ORDER BY reply.created_at DESC, reply.id DESC LIMIT 1) AS customer_reply,
                customer.email
         FROM custom_design_requests request
         JOIN customers customer ON customer.id = request.customer_id
         ORDER BY request.created_at DESC, request.id DESC
         LIMIT 50`,
      ).all(),
      env.DB.prepare(
        `SELECT order_row.id, order_row.order_reference, order_row.total_minor,
                order_row.currency, order_row.expires_at, order_row.created_at,
                design.template_id, customer.email, payment.id AS payment_id
         FROM orders order_row
         JOIN payments payment ON payment.order_id = order_row.id
           AND payment.provider = 'MANUAL_BANK_TRANSFER'
         JOIN customers customer ON customer.id = order_row.customer_id
         LEFT JOIN designs design ON design.id = order_row.design_id
         WHERE order_row.status = 'AWAITING_PAYMENT'
           AND order_row.payment_review_required = 0
           AND payment.status = 'PENDING' AND payment.review_required = 0
           AND order_row.expires_at > ?
         ORDER BY order_row.created_at, order_row.id
         LIMIT 50`,
      ).bind(nowIso()).all(),
      env.DB.prepare(
        `SELECT confirmation.id, confirmation.order_id, order_row.order_reference,
                confirmation.transaction_reference, confirmation.amount_minor,
                confirmation.currency, confirmation.confirmed_at, confirmation.request_id,
                customer.email AS actor_email
         FROM manual_payment_confirmations confirmation
         JOIN orders order_row ON order_row.id = confirmation.order_id
         JOIN customers customer ON customer.id = confirmation.actor_customer_id
         ORDER BY confirmation.confirmed_at DESC, confirmation.id DESC
         LIMIT 50`,
      ).all(),
    ]);

  await recordAdminActivity(
    env,
    admin,
    requestId,
    "OPERATIONS_VIEWED",
    "COMPLETED",
    "ADMIN_OPERATIONS",
  );
  const activityEvents = await env.DB.prepare(
    `SELECT event.id, event.request_id, event.action, event.outcome,
            event.target_type, event.target_id, event.created_at, customer.email AS actor_email
     FROM admin_activity_events event
     JOIN customers customer ON customer.id = event.actor_customer_id
     ORDER BY event.created_at DESC, event.id DESC
     LIMIT 50`,
  ).all();

  return jsonResponse({
    orders: orders.results,
    payments: payments.results,
    settlement_evidence: settlementEvidence.results,
    webhook_reviews: webhookReviews.results,
    fulfillment_jobs: fulfillmentJobs.results,
    publications: publications.results,
    derivative_operations: derivativeOperations.results,
    pending_manual_payments: pendingManualPayments.results,
    manual_payment_confirmations: manualPaymentConfirmations.results,
    admin_activity_events: activityEvents.results,
    custom_design_requests: customRequests.results.map((row) => ({
      ...row,
      reference_urls: JSON.parse(row.reference_urls_json as string) as string[],
      reference_urls_json: undefined,
    })),
  }, 200, requestId, { "Cache-Control": "no-store" });
}

function validateReviewInput(value: unknown): ReviewInput | null {
  if (!isRecord(value) || typeof value.action !== "string") return null;
  if (value.action === "start_review" && Object.keys(value).length === 1) {
    return { action: "start_review" };
  }
  if ((value.action === "request_information" || value.action === "reply") &&
      Object.keys(value).length === 2 &&
      typeof value.customer_message === "string") {
    const customerMessage = value.customer_message.trim();
    if (customerMessage.length < 1 || customerMessage.length > MAX_CUSTOMER_MESSAGE_LENGTH) {
      return null;
    }
    return { action: value.action, customer_message: customerMessage };
  }
  return null;
}

async function updateCustomDesignRequest(
  request: Request,
  env: Env,
  requestId: string,
  requestIdParam: string,
  admin: AdminSession,
): Promise<Response> {
  if (!CUSTOM_REQUEST_ID.test(requestIdParam)) {
    return apiError(requestId, 400, "INVALID_REQUEST_ID", "Request ID is invalid");
  }
  const parsed = await readJson(request, requestId);
  if (parsed.response) return parsed.response;
  const input = validateReviewInput(parsed.value);
  if (!input) {
    return apiError(requestId, 422, "VALIDATION_ERROR", "Review action is invalid");
  }

  const current = await env.DB.prepare(
    `SELECT status, communication_status, updated_at
     FROM custom_design_requests WHERE id = ?`,
  ).bind(requestIdParam).first<{
    status: string;
    communication_status: string;
    updated_at: string;
  }>();
  if (!current) return apiError(requestId, 404, "NOT_FOUND", "Custom design request not found");

  const transition = input.action === "start_review"
    ? { from: ["QUOTE_PENDING"], status: "IN_REVIEW", communication: current.communication_status }
    : input.action === "request_information"
      ? {
          from: ["QUOTE_PENDING", "IN_REVIEW"],
          status: "CUSTOMER_ACTION_REQUIRED",
          communication: "CUSTOMER_ACTION_REQUIRED",
        }
      : {
          from: ["CUSTOMER_ACTION_REQUIRED"],
          status: "IN_REVIEW",
          communication: "RESPONDED",
        };
  if (!transition.from.includes(current.status)) {
    return apiError(requestId, 409, "INVALID_STATE_TRANSITION", "The request is no longer in a reviewable state");
  }

  const now = nowIso();
  const eventId = safeId();
  const message = input.customer_message ?? null;
  const activityAction: AdminActivityAction = input.action === "start_review"
    ? "CUSTOM_DESIGN_START_REVIEW"
    : input.action === "request_information"
      ? "CUSTOM_DESIGN_REQUEST_INFORMATION"
      : "CUSTOM_DESIGN_REPLY";
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE custom_design_requests
       SET status = ?, communication_status = ?,
           customer_message = CASE WHEN ? IS NULL THEN customer_message ELSE ? END,
           customer_message_at = CASE WHEN ? IS NULL THEN customer_message_at ELSE ? END,
           customer_message_by = CASE WHEN ? IS NULL THEN customer_message_by ELSE ? END,
           last_admin_event_id = ?, updated_at = ?
       WHERE id = ? AND status = ? AND updated_at = ?`,
    ).bind(
      transition.status,
      transition.communication,
      message,
      message,
      message,
      now,
      message,
      admin.session.customerId,
      eventId,
      now,
      requestIdParam,
      current.status,
      current.updated_at,
    ),
    env.DB.prepare(
      `INSERT INTO custom_design_request_events (
         id, request_id, actor_customer_id, action, from_status, to_status,
         from_communication_status, to_communication_status, customer_message, created_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM custom_design_requests
         WHERE id = ? AND last_admin_event_id = ? AND updated_at = ?
       )`,
    ).bind(
      eventId,
      requestIdParam,
      admin.session.customerId,
      input.action,
      current.status,
      transition.status,
      current.communication_status,
      transition.communication,
      message,
      now,
      requestIdParam,
      eventId,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO admin_activity_events (
         id, actor_customer_id, request_id, action, outcome, target_type, target_id, created_at
       ) VALUES (?, ?, ?, ?, 'COMPLETED', 'CUSTOM_DESIGN_REQUEST', ?, ?)`,
    ).bind(
      safeId(),
      admin.session.customerId,
      requestId,
      activityAction,
      requestIdParam,
      now,
    ),
  ]);
  if (results[0]?.meta.changes !== 1) {
    return apiError(requestId, 409, "INVALID_STATE_TRANSITION", "The request changed; reload before reviewing it");
  }
  if (results[1]?.meta.changes !== 1) {
    throw new Error("Custom design review event was not recorded");
  }
  if (results[2]?.meta.changes !== 1) {
    throw new Error("Admin activity event was not recorded");
  }
  return jsonResponse({
    request_id: requestIdParam,
    status: transition.status,
    communication_status: transition.communication,
    customer_message: message,
    updated_at: now,
  }, 200, requestId, { "Cache-Control": "no-store" });
}

async function requireEmptyJsonBody(
  request: Request,
  requestId: string,
): Promise<Response | null> {
  const parsed = await readJson(request, requestId);
  if (parsed.response) return parsed.response;
  if (!isRecord(parsed.value) || Object.keys(parsed.value).length !== 0) {
    return apiError(requestId, 400, "VALIDATION_ERROR", "Request body must be an empty object");
  }
  return null;
}

async function confirmManualOrderPayment(
  request: Request,
  env: Env,
  requestId: string,
  orderId: string,
  admin: AdminSession,
): Promise<Response> {
  const policy = resolvePaymentEnvironmentPolicy(env);
  if (policy.provider !== "MANUAL_BANK_TRANSFER" ||
      policy.mode !== "manual-bank-transfer" || !policy.fulfillmentEnabled) {
    return apiError(requestId, 503, "MANUAL_PAYMENTS_DISABLED",
      "Manual bank-transfer confirmation is not enabled for this runtime");
  }
  const parsed = await readJson(request, requestId);
  if (parsed.response) return parsed.response;
  if (!isRecord(parsed.value) ||
      Object.keys(parsed.value).some((key) =>
        key !== "amount_minor" && key !== "transaction_reference") ||
      !Number.isSafeInteger(parsed.value.amount_minor) ||
      (parsed.value.amount_minor as number) <= 0 ||
      (parsed.value.transaction_reference !== undefined &&
        parsed.value.transaction_reference !== null &&
        (typeof parsed.value.transaction_reference !== "string" ||
          parsed.value.transaction_reference.trim().length > 128 ||
          /[^\x20-\x7e]/.test(parsed.value.transaction_reference)))) {
    return apiError(requestId, 422, "VALIDATION_ERROR", "Manual payment confirmation details are invalid");
  }
  const referenceValue = parsed.value.transaction_reference;
  const transactionReference = typeof referenceValue === "string" && referenceValue.trim()
    ? referenceValue.trim()
    : null;
  const result = await confirmManualPayment(env, {
    orderId,
    actorCustomerId: admin.session.customerId,
    requestId,
    amountMinor: parsed.value.amount_minor as number,
    transactionReference,
  });
  if (result.kind === "disabled") {
    return apiError(requestId, 503, "MANUAL_PAYMENTS_DISABLED",
      "Manual bank-transfer confirmation is not enabled for this runtime");
  }
  if (result.kind === "not_found") {
    return apiError(requestId, 404, "NOT_FOUND", "Manual payment order not found");
  }
  if (result.kind === "conflict") {
    return apiError(requestId, 409, "PAYMENT_CONFIRMATION_CONFLICT",
      "Order, amount, reference, or payment status no longer matches");
  }
  return jsonResponse({
    order_id: orderId,
    confirmed: true,
    replayed: result.replayed,
    fulfillment: result.fulfillment,
  }, 200, requestId, { "Cache-Control": "no-store" });
}

export async function handleAdminRoutes(
  request: Request,
  env: Env,
  path: string,
  requestId: string,
): Promise<Response | null> {
  if (!path.startsWith("/api/v1/admin/")) return null;

  if (path === "/api/v1/admin/operations") {
    if (request.method !== "GET") return apiError(requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
    const required = await requireAdmin(request, env, requestId);
    if (required.response) return required.response;
    return operationsSnapshot(env, requestId, required.admin!);
  }

  const reviewMatch = path.match(/^\/api\/v1\/admin\/custom-design\/requests\/([0-9a-f-]{36})$/i);
  if (reviewMatch) {
    if (request.method !== "PATCH") return apiError(requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
    const required = await requireAdminMutation(request, env, requestId);
    if (required.response) return required.response;
    return updateCustomDesignRequest(request, env, requestId, reviewMatch[1], required.admin!);
  }

  const manualPaymentMatch = path.match(
    /^\/api\/v1\/admin\/orders\/([0-9a-f-]{36})\/manual-payment-confirmation$/i,
  );
  if (manualPaymentMatch) {
    if (request.method !== "POST") {
      return apiError(requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
    }
    const required = await requireAdminMutation(request, env, requestId);
    if (required.response) return required.response;
    return confirmManualOrderPayment(
      request, env, requestId, manualPaymentMatch[1], required.admin!,
    );
  }

  if (path === "/api/v1/admin/fulfillments/recover" ||
      path === "/api/v1/admin/publication-derivatives/reconcile") {
    if (request.method !== "POST") return apiError(requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
    const required = await requireAdminMutation(request, env, requestId);
    if (required.response) return required.response;
    const invalidBody = await requireEmptyJsonBody(request, requestId);
    if (invalidBody) return invalidBody;

    const admin = required.admin!;
    if (path === "/api/v1/admin/fulfillments/recover") {
      return runAuditedAdminAction(
        env,
        admin,
        requestId,
        "FULFILLMENT_RECOVERY",
        "FULFILLMENT_JOBS",
        async () => {
          const result = await recoverPendingFulfillments(env, 10);
          return jsonResponse({ result }, 200, requestId, { "Cache-Control": "no-store" });
        },
      );
    }
    if (!env.STORAGE) {
      return apiError(requestId, 503, "STORAGE_UNAVAILABLE", "Publication cleanup is not configured");
    }
    return runAuditedAdminAction(
      env,
      admin,
      requestId,
      "PUBLICATION_DERIVATIVE_RECONCILIATION",
      "PUBLICATION_DERIVATIVE_OPERATIONS",
      async () => {
        const result = await reconcilePublicationDerivativeCleanup(env, {
          limit: 10,
          timeBudgetMs: 1000,
        });
        return jsonResponse({ result }, 200, requestId, { "Cache-Control": "no-store" });
      },
    );
  }

  return apiError(requestId, 404, "NOT_FOUND", "Route not found");
}

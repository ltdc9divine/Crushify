import { requireCsrf, requireSession } from "./auth.ts";
import { DatabaseError } from "./database.ts";
import { apiError, jsonResponse, nowIso, readBoundedBody, readJson, safeId, sha256 } from "./http.ts";
import {
  createOrderId,
  createOrderReference,
  createPaymentReference,
  sepayPaymentProvider,
  SEPAY_WEBHOOK_MAX_BYTES,
  type SePayWebhookPayload,
} from "./payments/sepay.ts";
import type { NormalizedPaymentTransaction } from "./payments/provider.ts";
import type { Env } from "./types.ts";

const ORDER_LIFETIME_MINUTES = 15;
const PAYMENT_PROVIDER = sepayPaymentProvider.id;

interface OrderRow {
  id: string;
  order_reference: string;
  status: string;
  payment_review_required: number;
  currency: string;
  total_minor: number;
  expires_at: string | null;
  created_at: string;
  payment_id: string;
  payment_reference: string;
  payment_status: string;
  payment_review_required_item: number;
  design_id: string | null;
  template_id: string;
  schema_version: number;
  revision: number | null;
}

interface PaymentRow {
  id: string;
  order_id: string;
  order_reference: string;
  order_status: string;
  payment_review_required: number;
  payment_status: string;
  review_required: number;
  amount_minor: number;
  currency: string;
  payment_reference: string;
  provider_payment_id: string | null;
  expires_at: string | null;
}

interface WebhookReviewDetails {
  expectedAmountMinor?: number | null;
  actualAmountMinor?: number | null;
  orderReference?: string | null;
  preserveOutcome?: boolean;
}

function isLocalPaymentEnabled(env: Env): boolean {
  return env.LOCAL_TEST_MODE === "true" &&
    env.ENVIRONMENT === "local" &&
    (env.PAYMENT_MODE === "mock" || env.PAYMENT_MODE === "sepay-test");
}

function paymentModeError(requestId: string, env: Env): Response | null {
  if (!isLocalPaymentEnabled(env)) {
    return apiError(requestId, 503, "PAYMENTS_DISABLED", "Payments are available only in local test mode");
  }
  if (!env.SEPAY_WEBHOOK_SECRET || env.SEPAY_WEBHOOK_SECRET.length < 16) {
    return apiError(requestId, 503, "PAYMENT_CONFIGURATION_ERROR", "Local webhook verification is not configured");
  }
  if (env.PAYMENT_MODE === "sepay-test" &&
      (!env.SEPAY_BANK_CODE || !/^[A-Z0-9]{2,20}$/i.test(env.SEPAY_BANK_CODE) ||
       !env.SEPAY_BANK_ACCOUNT || !/^\d{5,20}$/.test(env.SEPAY_BANK_ACCOUNT))) {
    return apiError(requestId, 503, "PAYMENT_CONFIGURATION_ERROR", "SePay Test mode bank settings are incomplete");
  }
  return null;
}

function paymentInstructions(env: Env, amount: number, reference: string) {
  if (env.PAYMENT_MODE !== "mock" && env.PAYMENT_MODE !== "sepay-test") return null;
  return sepayPaymentProvider.createInstructions({
    mode: env.PAYMENT_MODE,
    amountMinor: amount,
    reference,
    bankCode: env.SEPAY_BANK_CODE,
    bankAccount: env.SEPAY_BANK_ACCOUNT,
    accountName: env.SEPAY_ACCOUNT_NAME,
  });
}

function responseOrder(row: OrderRow, env: Env) {
  const status = row.payment_review_required || row.payment_review_required_item
    ? "MANUAL_REVIEW"
    : row.status;
  const paymentStatus = row.payment_review_required_item
    ? "MANUAL_REVIEW"
    : row.payment_status;
  const instructions = status === "AWAITING_PAYMENT" && paymentStatus === "PENDING"
    ? paymentInstructions(env, row.total_minor, row.payment_reference)
    : null;
  return {
    order_id: row.id,
    order_reference: row.order_reference,
    status,
    currency: row.currency,
    total_minor: row.total_minor,
    expires_at: row.expires_at,
    created_at: row.created_at,
    design_id: row.design_id,
    template_id: row.template_id,
    schema_version: row.schema_version,
    design_revision: row.revision,
    payment: {
      provider: PAYMENT_PROVIDER,
      status: paymentStatus,
      reference: row.payment_reference,
      mock_mode: env.PAYMENT_MODE === "mock",
      qr_url: instructions?.qrUrl ?? null,
      instructions: instructions
        ? {
          bank_code: instructions.bankCode,
          bank_account: instructions.bankAccount,
          account_name: instructions.accountName,
          amount_minor: instructions.amountMinor,
          reference: instructions.reference,
          qr_url: instructions.qrUrl,
        }
        : null,
    },
  };
}

async function loadOrder(
  env: Env,
  customerId: string,
  orderId: string,
): Promise<OrderRow | null> {
  return env.DB.prepare(
    `SELECT o.id, o.order_reference, o.status, o.payment_review_required,
            o.currency, o.total_minor, o.expires_at, o.created_at, o.design_id,
            i.reference_id AS template_id, CAST(json_extract(i.metadata_json, '$.schema_version') AS INTEGER) AS schema_version,
            o.design_revision AS revision,
            p.id AS payment_id, p.payment_reference, p.status AS payment_status,
            p.review_required AS payment_review_required_item
     FROM orders o
     JOIN order_items i ON i.order_id = o.id AND i.item_type = 'TEMPLATE_LICENSE'
     JOIN payments p ON p.order_id = o.id AND p.provider = ?
     WHERE o.id = ? AND o.customer_id = ?`,
  ).bind(PAYMENT_PROVIDER, orderId, customerId).first<OrderRow>();
}

async function loadOwnedOrderFromRoute(
  request: Request,
  env: Env,
  requestId: string,
  orderId: string,
): Promise<Response> {
  const required = await requireSession(request, env, requestId);
  if (required.response) return required.response;
  const row = await loadOrder(env, required.session!.customerId, orderId);
  if (!row) return apiError(requestId, 404, "NOT_FOUND", "Order not found");
  const updated = await expireOrderIfNeeded(env, required.session!.customerId, row);
  return jsonResponse(responseOrder(updated, env), 200, requestId);
}

async function expireOrderIfNeeded(env: Env, customerId: string, row: OrderRow): Promise<OrderRow> {
  if (row.status !== "AWAITING_PAYMENT" || !row.expires_at || row.expires_at > nowIso()) return row;
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE orders SET status = 'EXPIRED', updated_at = ?
       WHERE id = ? AND status = 'AWAITING_PAYMENT' AND expires_at <= ?`,
    ).bind(now, row.id, now),
    env.DB.prepare(
      `UPDATE payments SET status = 'CANCELLED', updated_at = ?
       WHERE id = ? AND status = 'PENDING'`,
    ).bind(now, row.payment_id),
  ]);
  return await loadOrder(env, customerId, row.id) ?? { ...row, status: "EXPIRED", payment_status: "CANCELLED" };
}

function validIdempotencyKey(value: string | null): value is string {
  return Boolean(value && value.length <= 128 && /^[A-Za-z0-9._:-]{16,128}$/.test(value));
}

async function createOrder(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  const unavailable = paymentModeError(requestId, env);
  if (unavailable) return unavailable;
  const required = await requireSession(request, env, requestId);
  if (required.response) return required.response;
  const csrf = await requireCsrf(request, env, required.session!, requestId);
  if (csrf) return csrf;
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!validIdempotencyKey(idempotencyKey)) {
    return apiError(requestId, 400, "VALIDATION_ERROR", "A valid Idempotency-Key header is required");
  }
  const parsed = await readJson(request, requestId);
  if (parsed.response) return parsed.response;
  if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return apiError(requestId, 400, "VALIDATION_ERROR", "Request body must be an object");
  }
  const body = parsed.value as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || typeof body.design_id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(body.design_id)) {
    return apiError(requestId, 400, "VALIDATION_ERROR", "Expected design_id");
  }
  const ownerId = required.session!.customerId;
  const fingerprint = await sha256(`${body.design_id}`);
  const prior = await env.DB.prepare(
    `SELECT id, request_hash FROM orders
     WHERE customer_id = ? AND idempotency_key = ?`,
  ).bind(ownerId, idempotencyKey).first<{ id: string; request_hash: string | null }>();
  if (prior) {
    if (prior.request_hash !== fingerprint) {
      return apiError(requestId, 409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for another request");
    }
    const row = await loadOrder(env, ownerId, prior.id);
    if (!row) return apiError(requestId, 409, "ORDER_UNAVAILABLE", "The prior order is unavailable");
    return jsonResponse(responseOrder(row, env), 200, requestId);
  }

  const design = await env.DB.prepare(
    `SELECT d.id, d.template_id, d.schema_version, d.revision,
            t.title, t.status AS template_status, v.status AS version_status,
            pr.amount_minor, pr.currency
     FROM designs d
     JOIN templates t ON t.id = d.template_id
     JOIN template_versions v ON v.template_id = d.template_id AND v.schema_version = d.schema_version
     JOIN template_prices pr ON pr.template_id = d.template_id
       AND pr.schema_version = d.schema_version AND pr.is_active = 1
     WHERE d.id = ? AND d.customer_id = ? AND d.status = 'DRAFT'
       AND t.status = 'ACTIVE' AND v.status = 'ACTIVE'`,
  ).bind(body.design_id, ownerId).first<{
    id: string;
    template_id: string;
    schema_version: number;
    revision: number;
    title: string;
    template_status: string;
    version_status: string;
    amount_minor: number;
    currency: string;
  }>();
  if (!design) {
    const ownedDesign = await env.DB.prepare(
      "SELECT id FROM designs WHERE id = ? AND customer_id = ? AND status = 'DRAFT'",
    ).bind(body.design_id, ownerId).first<{ id: string }>();
    return ownedDesign
      ? apiError(requestId, 422, "PRICE_UNAVAILABLE", "This template has no active server-side price")
      : apiError(requestId, 404, "NOT_FOUND", "Design not found");
  }
  if (!Number.isSafeInteger(design.amount_minor) || design.amount_minor <= 0 ||
      design.currency !== "VND") {
    return apiError(requestId, 503, "CATALOG_CONFIGURATION_ERROR", "Template price configuration is invalid");
  }

  const orderId = createOrderId();
  const paymentId = safeId();
  const orderReference = createOrderReference();
  const paymentReference = createPaymentReference();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + ORDER_LIFETIME_MINUTES * 60_000).toISOString();
  const amount = design.amount_minor;
  const statements = [
    env.DB.prepare(
      `INSERT INTO orders (
         id, customer_id, order_type, status, currency, subtotal_minor, discount_minor,
         total_minor, design_id, idempotency_key, created_at, updated_at, expires_at,
         order_reference, design_revision, request_hash, payment_review_required
       )
       SELECT ?, ?, 'SELF_SERVICE', 'AWAITING_PAYMENT', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0
       WHERE EXISTS (
         SELECT 1
         FROM designs d
         JOIN templates t ON t.id = d.template_id AND t.status = 'ACTIVE'
         JOIN template_versions v ON v.template_id = d.template_id
           AND v.schema_version = d.schema_version AND v.status = 'ACTIVE'
         JOIN template_prices pr ON pr.template_id = d.template_id
           AND pr.schema_version = d.schema_version AND pr.is_active = 1
         WHERE d.id = ? AND d.customer_id = ? AND d.status = 'DRAFT'
           AND d.revision = ? AND d.template_id = ? AND d.schema_version = ?
           AND pr.amount_minor = ? AND pr.currency = ?
       )`,
    ).bind(orderId, ownerId, design.currency, amount, amount, design.id, idempotencyKey,
      now, now, expiresAt, orderReference, design.revision, fingerprint,
      design.id, ownerId, design.revision, design.template_id, design.schema_version,
      amount, design.currency),
    env.DB.prepare(
      `INSERT INTO order_items (
         id, order_id, item_type, reference_id, description_snapshot, quantity,
         unit_amount_minor, line_total_minor, metadata_json, created_at
       )
       SELECT ?, ?, 'TEMPLATE_LICENSE', ?, ?, 1, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?)`,
    ).bind(safeId(), orderId, design.template_id, design.title, amount, amount,
      JSON.stringify({ schema_version: design.schema_version }), now, orderId),
    env.DB.prepare(
      `INSERT INTO payments (
         id, order_id, provider, status, amount_minor, currency, idempotency_key,
         created_at, updated_at, payment_reference, review_required
       )
       SELECT ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, 0
       WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?)`,
    ).bind(paymentId, orderId, PAYMENT_PROVIDER, amount, design.currency, `order:${orderId}`,
      now, now, paymentReference, orderId),
  ];
  try {
    const results = await env.DB.batch(statements);
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      return apiError(requestId, 409, "PRICE_CHANGED", "Design or template price changed; reload before checkout");
    }
  } catch (error) {
    if (!(error instanceof DatabaseError) || error.code !== "CONSTRAINT") throw error;
    const raced = await env.DB.prepare(
      "SELECT id, request_hash FROM orders WHERE customer_id = ? AND idempotency_key = ?",
    ).bind(ownerId, idempotencyKey).first<{ id: string; request_hash: string | null }>();
    if (!raced) throw error;
    if (raced.request_hash !== fingerprint) {
      return apiError(requestId, 409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for another request");
    }
    const row = await loadOrder(env, ownerId, raced.id);
    if (!row) throw error;
    return jsonResponse(responseOrder(row, env), 200, requestId);
  }
  const row = await loadOrder(env, ownerId, orderId);
  if (!row) throw new Error("New order was not readable after creation");
  return jsonResponse(responseOrder(row, env), 201, requestId);
}

async function listOrders(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  const unavailable = paymentModeError(requestId, env);
  if (unavailable) return unavailable;
  const required = await requireSession(request, env, requestId);
  if (required.response) return required.response;
  const rows = await env.DB.prepare(
    `SELECT o.id FROM orders o
     WHERE o.customer_id = ? AND o.order_type = 'SELF_SERVICE'
     ORDER BY o.created_at DESC LIMIT 50`,
  ).bind(required.session!.customerId).all<{ id: string }>();
  const orders = [];
  for (const row of rows.results) {
    const order = await loadOrder(env, required.session!.customerId, row.id);
    if (order) orders.push(responseOrder(await expireOrderIfNeeded(env, required.session!.customerId, order), env));
  }
  return jsonResponse({ orders }, 200, requestId);
}

function webhookMismatch(
  transaction: NormalizedPaymentTransaction,
  payment: PaymentRow,
  env: Env,
): string | null {
  if (sepayPaymentProvider.mapStatus(transaction) !== "SUCCEEDED") {
    return "Transfer is not incoming";
  }
  if (!env.SEPAY_BANK_ACCOUNT || transaction.receivingAccount !== env.SEPAY_BANK_ACCOUNT) {
    return "Receiving account does not match";
  }
  if (!transaction.paymentReference || transaction.paymentReference !== payment.payment_reference) {
    return "Payment reference does not match";
  }
  if (transaction.amountMinor !== payment.amount_minor) {
    return "Transfer amount does not match";
  }
  return null;
}

async function markWebhookReview(
  env: Env,
  eventId: string,
  reason: string,
  payment?: PaymentRow,
  details: WebhookReviewDetails = {},
): Promise<void> {
  const now = nowIso();
  const statements = [];
  if (payment && payment.payment_status !== "SUCCEEDED" && payment.order_status !== "PAID") {
    statements.push(
      env.DB.prepare(
        `UPDATE payments SET review_required = 1, updated_at = ?
         WHERE id = ? AND status IN ('PENDING', 'CANCELLED', 'FAILED')`,
      ).bind(now, payment.id),
      env.DB.prepare(
        `UPDATE orders SET payment_review_required = 1, updated_at = ?
         WHERE id = ? AND status IN ('AWAITING_PAYMENT', 'EXPIRED', 'CANCELLED')`,
      ).bind(now, payment.order_id),
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE payment_webhook_events
       SET outcome = CASE WHEN ? = 1 THEN outcome ELSE 'MANUAL_REVIEW' END,
           review_reason = ?, processed_at = ?,
           order_reference = COALESCE(?, order_reference),
           expected_amount_minor = COALESCE(?, expected_amount_minor),
           actual_amount_minor = COALESCE(?, actual_amount_minor)
       WHERE provider = ? AND event_id = ?
         AND (? = 1 OR outcome = 'RECEIVED')`,
    ).bind(details.preserveOutcome ? 1 : 0, reason, now,
      details.orderReference ?? payment?.order_reference ?? null,
      details.expectedAmountMinor ?? payment?.amount_minor ?? null,
      details.actualAmountMinor ?? null,
      PAYMENT_PROVIDER, eventId, details.preserveOutcome ? 1 : 0),
  );
  await env.DB.batch(statements);
}

async function processWebhookEvent(
  env: Env,
  eventId: string,
  transactionId: string | null,
  payload: SePayWebhookPayload | null,
  reviewReason: string | null,
): Promise<void> {
  const attemptAt = nowIso();
  const attempt = await env.DB.prepare(
    `UPDATE payment_webhook_events
     SET processing_attempts = processing_attempts + 1, last_attempt_at = ?
     WHERE provider = ? AND event_id = ? AND outcome = 'RECEIVED'`,
  ).bind(attemptAt, PAYMENT_PROVIDER, eventId).run();
  if (attempt.meta.changes !== 1) return;
  const stored = await env.DB.prepare(
    `SELECT outcome, raw_payload FROM payment_webhook_events
     WHERE provider = ? AND event_id = ?`,
  ).bind(PAYMENT_PROVIDER, eventId).first<{ outcome: string | null; raw_payload: string }>();
  if (!stored || stored.outcome !== "RECEIVED") return;
  if (!transactionId || !payload || reviewReason) {
    await markWebhookReview(env, eventId, reviewReason ?? "Webhook payload is incomplete", undefined, {
      actualAmountMinor: payload && Number.isSafeInteger(payload.transferAmount)
        ? payload.transferAmount
        : null,
    });
    return;
  }

  const parsed = JSON.parse(stored.raw_payload) as SePayWebhookPayload;
  const transaction = sepayPaymentProvider.normalizeTransaction(parsed);
  const payment = transaction.paymentReference
    ? await env.DB.prepare(
      `SELECT p.id, p.order_id, o.order_reference, o.status AS order_status,
              o.payment_review_required, p.status AS payment_status,
              p.review_required, p.amount_minor, p.currency, p.payment_reference,
              p.provider_payment_id, o.expires_at
       FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE p.provider = ? AND p.payment_reference = ?`,
    ).bind(PAYMENT_PROVIDER, transaction.paymentReference).first<PaymentRow>()
    : null;
  if (!payment) {
    await markWebhookReview(env, eventId, "No order matches this payment reference", undefined, {
      actualAmountMinor: transaction.amountMinor,
    });
    return;
  }

  const mismatch = webhookMismatch(transaction, payment, env);
  if (mismatch) {
    await markWebhookReview(env, eventId, mismatch, payment, {
      actualAmountMinor: transaction.amountMinor,
    });
    return;
  }
  const now = nowIso();
  if (payment.order_status !== "AWAITING_PAYMENT" || payment.payment_status !== "PENDING" ||
      payment.review_required || payment.payment_review_required || !payment.expires_at ||
      payment.expires_at <= now || payment.provider_payment_id) {
    await markWebhookReview(env, eventId, "Order is expired, already paid, or not awaiting payment", payment, {
      actualAmountMinor: transaction.amountMinor,
    });
    return;
  }

  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE payments SET status = 'SUCCEEDED', provider_payment_id = ?,
           succeeded_at = ?, updated_at = ?
         WHERE id = ? AND status = 'PENDING' AND provider_payment_id IS NULL
           AND review_required = 0 AND amount_minor = ?
           AND EXISTS (
             SELECT 1 FROM orders WHERE id = ? AND status = 'AWAITING_PAYMENT'
               AND payment_review_required = 0 AND expires_at > ?
           )`,
      ).bind(transactionId, now, now, payment.id, payment.amount_minor, payment.order_id, now),
      env.DB.prepare(
        `UPDATE orders SET status = 'PAID', paid_at = ?, updated_at = ?
         WHERE id = ? AND status = 'AWAITING_PAYMENT' AND payment_review_required = 0
           AND EXISTS (
             SELECT 1 FROM payments WHERE id = ? AND status = 'SUCCEEDED'
               AND provider_payment_id = ?
           )`,
      ).bind(now, now, payment.order_id, payment.id, transactionId),
      env.DB.prepare(
        `UPDATE payment_webhook_events
         SET outcome = CASE WHEN EXISTS (
             SELECT 1 FROM orders o JOIN payments p ON p.order_id = o.id
             WHERE o.id = ? AND o.status = 'PAID' AND p.id = ?
               AND p.status = 'SUCCEEDED' AND p.provider_payment_id = ?
           ) THEN 'PROCESSED' ELSE 'MANUAL_REVIEW' END,
           review_reason = CASE WHEN EXISTS (
             SELECT 1 FROM orders o JOIN payments p ON p.order_id = o.id
             WHERE o.id = ? AND o.status = 'PAID' AND p.id = ?
               AND p.status = 'SUCCEEDED' AND p.provider_payment_id = ?
           ) THEN NULL ELSE 'Order or payment state changed while processing webhook' END,
           processed_at = ?, order_reference = ?, expected_amount_minor = ?,
           actual_amount_minor = ?
         WHERE provider = ? AND event_id = ? AND outcome = 'RECEIVED'`,
      ).bind(payment.order_id, payment.id, transactionId,
        payment.order_id, payment.id, transactionId, now, payment.order_reference,
        payment.amount_minor, transaction.amountMinor, PAYMENT_PROVIDER, eventId),
    ]);
  } catch (error) {
    if (!(error instanceof DatabaseError) || error.code !== "CONSTRAINT") throw error;
    const existingTransaction = await env.DB.prepare(
      "SELECT id FROM payments WHERE provider = ? AND provider_payment_id = ?",
    ).bind(PAYMENT_PROVIDER, transactionId).first<{ id: string }>();
    if (!existingTransaction) throw error;
    await markWebhookReview(
      env,
      eventId,
      "Provider transaction is already linked to another payment",
      payment,
      { actualAmountMinor: transaction.amountMinor },
    );
  }
}

async function reviewWebhookCollision(
  env: Env,
  eventId: string,
  parsed: SePayWebhookPayload | null,
): Promise<void> {
  const transaction = parsed ? sepayPaymentProvider.normalizeTransaction(parsed) : null;
  const payment = transaction?.paymentReference
    ? await env.DB.prepare(
      `SELECT p.id, p.order_id, o.order_reference, o.status AS order_status,
              o.payment_review_required, p.status AS payment_status,
              p.review_required, p.amount_minor, p.currency, p.payment_reference,
              p.provider_payment_id, o.expires_at
       FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE p.provider = ? AND p.payment_reference = ?`,
    ).bind(PAYMENT_PROVIDER, transaction.paymentReference).first<PaymentRow>()
    : null;
  await markWebhookReview(
    env,
    eventId,
    "Duplicate provider transaction ID has a different payload",
    payment ?? undefined,
    {
      actualAmountMinor: transaction?.amountMinor,
      preserveOutcome: true,
    },
  );
}

export async function recoverPendingSePayWebhookEvents(
  env: Env,
  limit = 50,
): Promise<{ attempted: number; pending: number }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Recovery batch size must be between 1 and 100");
  }
  const events = await env.DB.prepare(
    `SELECT event_id, raw_payload FROM payment_webhook_events
     WHERE provider = ? AND outcome = 'RECEIVED'
     ORDER BY received_at LIMIT ?`,
  ).bind(PAYMENT_PROVIDER, limit).all<{ event_id: string; raw_payload: string }>();
  for (const event of events.results) {
    const parsed = await sepayPaymentProvider.parseWebhook(new TextEncoder().encode(event.raw_payload));
    await processWebhookEvent(
      env,
      event.event_id,
      parsed.transactionId,
      parsed.payload,
      parsed.reviewReason,
    );
  }
  const pending = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM payment_webhook_events
     WHERE provider = ? AND outcome = 'RECEIVED'`,
  ).bind(PAYMENT_PROVIDER).first<{ count: number }>();
  return { attempted: events.results.length, pending: Number(pending?.count ?? 0) };
}

async function handleSepayWebhook(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  const unavailable = paymentModeError(requestId, env);
  if (unavailable) return unavailable;
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return apiError(requestId, 415, "UNSUPPORTED_MEDIA_TYPE", "Expected application/json");
  }
  const secret = env.SEPAY_WEBHOOK_SECRET!;
  let rawBody: Uint8Array;
  try {
    rawBody = await readBoundedBody(request, SEPAY_WEBHOOK_MAX_BYTES);
  } catch (error) {
    const tooLarge = error instanceof RangeError;
    return apiError(
      requestId,
      tooLarge ? 413 : 400,
      tooLarge ? "PAYLOAD_TOO_LARGE" : "INVALID_BODY",
      tooLarge ? "Webhook payload is too large" : "Could not read webhook payload",
    );
  }
  if (!await sepayPaymentProvider.verifyWebhook(request.headers, rawBody, secret)) {
    return apiError(requestId, 401, "INVALID_WEBHOOK_SIGNATURE", "Webhook signature is invalid or expired");
  }

  const parsed = await sepayPaymentProvider.parseWebhook(rawBody);
  if (parsed.reviewReason === "Payload is not valid UTF-8") {
    return apiError(requestId, 400, "INVALID_ENCODING", "Webhook payload must be valid UTF-8");
  }
  const payloadHash = await sha256(rawBody);
  await env.DB.prepare(
    `INSERT INTO payment_webhook_events (
       id, provider, event_id, payload_hash, received_at, outcome, raw_payload, review_reason,
       provider_transaction_id, actual_amount_minor
     ) VALUES (?, ?, ?, ?, ?, 'RECEIVED', ?, NULL, ?, ?)
     ON CONFLICT(provider, event_id) DO NOTHING`,
  ).bind(safeId(), PAYMENT_PROVIDER, parsed.eventId, payloadHash, nowIso(),
    new TextDecoder().decode(rawBody), parsed.transactionId,
    typeof parsed.payload?.transferAmount === "number" &&
        Number.isSafeInteger(parsed.payload.transferAmount)
      ? parsed.payload.transferAmount
      : null).run();

  const prior = await env.DB.prepare(
    `SELECT payload_hash, outcome FROM payment_webhook_events
     WHERE provider = ? AND event_id = ?`,
  ).bind(PAYMENT_PROVIDER, parsed.eventId).first<{ payload_hash: string; outcome: string | null }>();
  if (!prior) throw new Error("Webhook event was not persisted");
  if (prior.payload_hash !== payloadHash) {
    await reviewWebhookCollision(env, parsed.eventId, parsed.payload);
  } else {
    await processWebhookEvent(env, parsed.eventId, parsed.transactionId, parsed.payload, parsed.reviewReason);
  }
  return jsonResponse({ success: true }, 200, requestId);
}

export async function handlePaymentRoutes(
  request: Request,
  env: Env,
  path: string,
  requestId: string,
): Promise<Response | null> {
  if (path === "/api/v1/orders") {
    if (request.method === "POST") return createOrder(request, env, requestId);
    if (request.method === "GET") return listOrders(request, env, requestId);
    return apiError(requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
  }
  const orderMatch = path.match(/^\/api\/v1\/orders\/([0-9a-f-]{36})(?:\/status)?$/i);
  if (orderMatch) {
    if (request.method !== "GET") {
      return apiError(requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
    }
    const unavailable = paymentModeError(requestId, env);
    if (unavailable) return unavailable;
    return loadOwnedOrderFromRoute(request, env, requestId, orderMatch[1]);
  }
  if (path === "/api/v1/payments/sepay/webhook") {
    if (request.method !== "POST") {
      return apiError(requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
    }
    return handleSepayWebhook(request, env, requestId);
  }
  return null;
}

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
import {
  resolvePaymentEnvironmentPolicy,
  type PaymentProviderId,
} from "./payments/policy.ts";
import { assetReferences, type TemplateData } from "./template-registry.ts";
import { handleFulfillmentForOrder } from "./publications.ts";
import {
  CatalogPriceUnavailableError,
  publicProductCatalog,
  standardProduct,
  standardPriceSnapshot,
  standardPriceSnapshotForTerm,
  standardRenewalAmountMinor,
  standardStoragePlanForTerm,
  storageDuration,
  STANDARD_CATALOG_ENABLED,
  STANDARD_HOSTING_MONTHLY_ADDITION_MINOR,
  STANDARD_PRICING_VERSION,
  STORAGE_DURATIONS,
  type StandardHostingTerm,
  type StandardPriceSnapshot,
} from "./product-catalog.ts";
import { entitlementExpiry } from "./storage-plans.ts";
import type { Env } from "./types.ts";

const ORDER_LIFETIME_MINUTES = 15;
const SEPAY_PROVIDER = sepayPaymentProvider.id;

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
  storage_plan_id: string;
  storage_plan_title: string;
  storage_duration_months: number | null;
  storage_lifetime: number;
  pricing_snapshot_json: string | null;
  fulfillment_status: string | null;
}

interface PaymentRow {
  id: string;
  order_id: string;
  order_reference: string;
  order_status: string;
  order_total_minor: number;
  order_currency: string;
  payment_review_required: number;
  payment_status: string;
  review_required: number;
  amount_minor: number;
  currency: string;
  payment_reference: string;
  provider_payment_id: string | null;
  expires_at: string | null;
  snapshot_total_minor: number | null;
}

interface WebhookReviewDetails {
  expectedAmountMinor?: number | null;
  actualAmountMinor?: number | null;
  orderReference?: string | null;
  preserveOutcome?: boolean;
}

function selectedPaymentProvider(env: Env): PaymentProviderId {
  const provider = resolvePaymentEnvironmentPolicy(env).provider;
  if (!provider) throw new Error("Payment provider is unavailable for this runtime");
  return provider;
}

function paymentModeError(
  requestId: string,
  env: Env,
  requiresWebhookSecret = false,
): Response | null {
  const policy = resolvePaymentEnvironmentPolicy(env);
  if (!policy.orderCreationEnabled) {
    return apiError(requestId, 503, "PAYMENTS_DISABLED", "Payments are disabled for this runtime");
  }
  if (requiresWebhookSecret && !policy.sepayWebhookEnabled) {
    return apiError(
      requestId,
      503,
      policy.provider === "MOCK" ? "MOCK_SETTLEMENT_UNAVAILABLE" : "PAYMENTS_DISABLED",
      policy.provider === "MOCK"
        ? "Mock payments cannot be settled through the SePay webhook"
        : "SePay webhook processing is disabled for this runtime",
    );
  }
  if ((requiresWebhookSecret || policy.mode === "sepay-test") &&
      (!env.SEPAY_WEBHOOK_SECRET || env.SEPAY_WEBHOOK_SECRET.length < 16)) {
    return apiError(requestId, 503, "PAYMENT_CONFIGURATION_ERROR", "Local webhook verification is not configured");
  }
  if (policy.mode === "sepay-test" &&
      (!env.SEPAY_BANK_CODE || !/^[A-Z0-9]{2,20}$/i.test(env.SEPAY_BANK_CODE) ||
       !env.SEPAY_BANK_ACCOUNT || !/^\d{5,20}$/.test(env.SEPAY_BANK_ACCOUNT))) {
    return apiError(requestId, 503, "PAYMENT_CONFIGURATION_ERROR", "SePay Test mode bank settings are incomplete");
  }
  return null;
}

function localApprovedPricingEnabled(env: Env): boolean {
  return env.ENVIRONMENT === "local" &&
    env.LOCAL_TEST_MODE === "true" &&
    env.LOCAL_TEST_PRICING_POLICY === "true";
}

function isStandardPricingEnabled(env: Env): boolean {
  return STANDARD_CATALOG_ENABLED || localApprovedPricingEnabled(env);
}

function termFromPlan(planId: string): StandardHostingTerm | null {
  const plan = storageDuration(planId);
  if (!plan) return null;
  return plan.lifetime
    ? { type: "lifetime" }
    : plan.durationMonths === null
      ? null
      : { type: "monthly", months: plan.durationMonths };
}

function paymentInstructions(env: Env, amount: number, reference: string) {
  const mode = resolvePaymentEnvironmentPolicy(env).mode;
  if (mode !== "sepay-test") return null;
  return sepayPaymentProvider.createInstructions({
    mode,
    amountMinor: amount,
    reference,
    bankCode: env.SEPAY_BANK_CODE,
    bankAccount: env.SEPAY_BANK_ACCOUNT,
    accountName: env.SEPAY_ACCOUNT_NAME,
  });
}

function responseOrder(row: OrderRow, env: Env) {
  const policy = resolvePaymentEnvironmentPolicy(env);
  const provider = selectedPaymentProvider(env);
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
    storage_plan: {
      id: row.storage_plan_id,
      title: row.storage_plan_title,
      duration_months: row.storage_duration_months,
      lifetime: Boolean(row.storage_lifetime),
    },
    pricing_snapshot: row.pricing_snapshot_json
      ? JSON.parse(row.pricing_snapshot_json) as StandardPriceSnapshot
      : null,
    fulfillment_status: row.fulfillment_status,
    payment: {
      provider,
      status: paymentStatus,
      reference: row.payment_reference,
      mock_mode: policy.mode === "mock",
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
  const provider = resolvePaymentEnvironmentPolicy(env).provider;
  if (!provider) return null;
  return env.DB.prepare(
    `SELECT o.id, o.order_reference, o.status, o.payment_review_required,
            o.currency, o.total_minor, o.expires_at, o.created_at, o.design_id,
            i.reference_id AS template_id, CAST(json_extract(i.metadata_json, '$.schema_version') AS INTEGER) AS schema_version,
            o.design_revision AS revision,
            p.id AS payment_id, p.payment_reference, p.status AS payment_status,
            p.review_required AS payment_review_required_item,
            storage_item.reference_id AS storage_plan_id,
            json_extract(storage_item.metadata_json, '$.title') AS storage_plan_title,
            json_extract(storage_item.metadata_json, '$.duration_months') AS storage_duration_months,
            json_extract(storage_item.metadata_json, '$.lifetime') AS storage_lifetime,
            json_extract(storage_item.metadata_json, '$.pricing_snapshot') AS pricing_snapshot_json,
            fj.status AS fulfillment_status
     FROM orders o
     JOIN order_items i ON i.order_id = o.id AND i.item_type = 'TEMPLATE_LICENSE'
     JOIN payments p ON p.order_id = o.id AND p.provider = ?
     JOIN order_items storage_item ON storage_item.order_id = o.id
       AND storage_item.item_type = 'ADD_ON'
       AND json_extract(storage_item.metadata_json, '$.kind') = 'STORAGE_PLAN'
     LEFT JOIN fulfillment_jobs fj ON fj.order_id = o.id
     WHERE o.id = ? AND o.customer_id = ?`,
  ).bind(provider, orderId, customerId).first<OrderRow>();
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
  if (Object.keys(body).some((key) =>
    !["design_id", "storage_plan_id", "duration_type", "hosting_months",
      "asset_consents", "renewal_publication_id"].includes(key)) ||
      typeof body.design_id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.design_id) ||
      (body.storage_plan_id !== undefined &&
        (typeof body.storage_plan_id !== "string" ||
          !["1-month", "3-months", "6-months", "12-months", "lifetime"].includes(body.storage_plan_id))) ||
      (body.duration_type !== undefined &&
        body.duration_type !== "monthly" && body.duration_type !== "lifetime") ||
      ((body.storage_plan_id === undefined) === (body.duration_type === undefined)) ||
      (body.duration_type === "monthly" &&
        (!Number.isSafeInteger(body.hosting_months) || (body.hosting_months as number) < 1)) ||
      (body.duration_type === "lifetime" &&
        body.hosting_months !== undefined && body.hosting_months !== null) ||
      (body.duration_type === undefined && body.hosting_months !== undefined) ||
      (body.asset_consents !== undefined && !Array.isArray(body.asset_consents)) ||
      (body.renewal_publication_id !== undefined &&
        (typeof body.renewal_publication_id !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(body.renewal_publication_id)))) {
    return apiError(requestId, 400, "VALIDATION_ERROR",
      "Expected design_id and either storage_plan_id or a valid duration_type and hosting_months");
  }
  const legacyPlanRequest = typeof body.storage_plan_id === "string";
  const term: StandardHostingTerm | null = legacyPlanRequest
    ? termFromPlan(body.storage_plan_id as string)
    : body.duration_type === "lifetime"
      ? { type: "lifetime" }
      : { type: "monthly", months: body.hosting_months as number };
  if (!term) {
    return apiError(requestId, 400, "VALIDATION_ERROR", "Invalid storage plan");
  }
  const requestedPlan = legacyPlanRequest
    ? storageDuration(body.storage_plan_id as string)
    : standardStoragePlanForTerm(term);
  if (!requestedPlan) {
    return apiError(requestId, 400, "VALIDATION_ERROR", "Invalid storage plan");
  }
  if (!legacyPlanRequest && !isStandardPricingEnabled(env)) {
    return apiError(requestId, 422, "PRICE_UNAVAILABLE", "Standard hosting pricing is not enabled");
  }
  const localFixturePricing = env.ENVIRONMENT === "local" &&
    env.LOCAL_TEST_MODE === "true" &&
    env.LOCAL_TEST_CATALOG_OVERRIDE === "true" &&
    legacyPlanRequest;
  const consentList = (body.asset_consents ?? []) as unknown[];
  if (consentList.some((item) => !item || typeof item !== "object" || Array.isArray(item) ||
      Object.keys(item).length !== 2 ||
      typeof (item as { asset_id?: unknown }).asset_id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test((item as { asset_id: string }).asset_id) ||
      (item as { consent_version?: unknown }).consent_version !== "public-image-v1")) {
    return apiError(requestId, 400, "VALIDATION_ERROR", "Invalid public image consent list");
  }
  const assetConsents = consentList as Array<{ asset_id: string; consent_version: string }>;
  const consentIds = assetConsents.map((item) => item.asset_id);
  if (new Set(consentIds).size !== consentIds.length) {
    return apiError(requestId, 400, "VALIDATION_ERROR", "Image consent must not contain duplicates");
  }
  const ownerId = required.session!.customerId;
  const renewalRequestedAt = nowIso();
  const renewal = body.renewal_publication_id
    ? await env.DB.prepare(
      `SELECT p.id, p.design_id, p.status, p.expires_at,
         (SELECT e.status FROM storage_entitlements e
          WHERE e.publication_id = p.id ORDER BY e.created_at DESC LIMIT 1) AS entitlement_status
       FROM publications p
       JOIN designs d ON d.id = p.design_id AND d.customer_id = ?
       WHERE p.id = ? AND p.status IN ('PUBLISHED','UNPUBLISHED','EXPIRED')
         AND p.renderer_version <> 'unsupported'
         AND (p.retention_delete_after_at IS NULL OR p.retention_delete_after_at > ?)`,
    ).bind(ownerId, body.renewal_publication_id, renewalRequestedAt).first<{
      id: string;
      design_id: string;
      status: string;
      expires_at: string | null;
      entitlement_status: string | null;
    }>()
    : await env.DB.prepare(
      `SELECT p.id, p.design_id, p.status, p.expires_at,
         (SELECT e.status FROM storage_entitlements e
          WHERE e.publication_id = p.id ORDER BY e.created_at DESC LIMIT 1) AS entitlement_status
       FROM publications p
       JOIN designs d ON d.id = p.design_id AND d.customer_id = ?
       WHERE d.id = ? AND p.status IN ('PUBLISHED','UNPUBLISHED','EXPIRED')
         AND p.renderer_version <> 'unsupported'
         AND (p.retention_delete_after_at IS NULL OR p.retention_delete_after_at > ?)`,
    ).bind(ownerId, body.design_id, renewalRequestedAt).first<{
      id: string;
      design_id: string;
      status: string;
      expires_at: string | null;
      entitlement_status: string | null;
    }>();
  const renewalPublicationId = renewal?.id ?? null;
  if (body.renewal_publication_id && (!renewal || renewal.design_id !== body.design_id)) {
    return apiError(requestId, 404, "NOT_FOUND", "Renewable website not found");
  }
  if (renewal?.entitlement_status === "LIFETIME") {
    return apiError(requestId, 409, "LIFETIME_ACTIVE", "Lifetime storage does not require renewal");
  }
  if (renewalPublicationId && term.type === "lifetime" && !localFixturePricing) {
    return apiError(requestId, 422, "PRICE_UNAVAILABLE", "Lifetime upgrades are not available for renewal");
  }
  if (term.type === "monthly") {
    const latestActivation = new Date(Date.now() + ORDER_LIFETIME_MINUTES * 60_000);
    const currentExpiry = renewal?.expires_at ? Date.parse(renewal.expires_at) : NaN;
    if (Number.isFinite(currentExpiry) && currentExpiry > latestActivation.getTime()) {
      latestActivation.setTime(currentExpiry);
    }
    try {
      entitlementExpiry(requestedPlan, latestActivation);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return apiError(requestId, 422, "PRICE_UNAVAILABLE",
        "Hosting duration exceeds the supported calendar range");
    }
  }
  const fingerprint = await sha256(JSON.stringify({
    design_id: body.design_id,
    storage_plan_id: requestedPlan.id,
    duration_type: term.type,
    hosting_months: term.type === "monthly" ? term.months : null,
    renewal_publication_id: renewalPublicationId,
    asset_consents: [...consentIds].sort(),
  }));
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

  if (requestedPlan.id.startsWith("custom-") && term.type === "monthly") {
    const ownedDesign = await env.DB.prepare(
      `SELECT template_id FROM designs
       WHERE id = ? AND customer_id = ? AND status = 'DRAFT'`,
    ).bind(body.design_id, ownerId).first<{ template_id: string }>();
    if (!ownedDesign) return apiError(requestId, 404, "NOT_FOUND", "Design not found");
    if (!standardProduct(ownedDesign.template_id)) {
      return apiError(requestId, 422, "PRICE_UNAVAILABLE", "This product is not in the standard catalog");
    }
    if (renewalPublicationId) {
      if (standardRenewalAmountMinor(requestedPlan) === null) {
        return apiError(requestId, 422, "PRICE_UNAVAILABLE", "The renewal amount is invalid");
      }
    } else {
      try {
        standardPriceSnapshotForTerm(ownedDesign.template_id, term);
      } catch (error) {
        if (!(error instanceof CatalogPriceUnavailableError)) throw error;
        return apiError(requestId, 422, "PRICE_UNAVAILABLE", error.message);
      }
    }
    const createdAt = nowIso();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO storage_plans (
         id, title, duration_months, is_lifetime, status, created_at, updated_at
       ) VALUES (?, ?, ?, 0, 'ACTIVE', ?, ?)`,
    ).bind(requestedPlan.id, requestedPlan.title, term.type === "monthly" ? term.months : null,
      createdAt, createdAt).run();
    const storedPlan = await env.DB.prepare(
      "SELECT duration_months, is_lifetime, status FROM storage_plans WHERE id = ?",
    ).bind(requestedPlan.id).first<{
      duration_months: number | null;
      is_lifetime: number;
      status: string;
    }>();
    if (!storedPlan || storedPlan.duration_months !== term.months ||
        storedPlan.is_lifetime !== 0 || storedPlan.status !== "ACTIVE") {
      return apiError(requestId, 409, "STORAGE_PLAN_CONFLICT", "The requested storage plan is inconsistent");
    }
  }

  const design = await env.DB.prepare(
    `SELECT d.id, d.template_id, d.schema_version, d.revision, d.data_json,
            t.title, t.status AS template_status, v.status AS version_status,
            pr.amount_minor, pr.currency, sp.id AS storage_plan_id, sp.title AS storage_plan_title,
            sp.duration_months, sp.is_lifetime, spp.amount_minor AS storage_amount_minor,
            spp.currency AS storage_currency
     FROM designs d
     JOIN templates t ON t.id = d.template_id
     JOIN template_versions v ON v.template_id = d.template_id AND v.schema_version = d.schema_version
     LEFT JOIN template_prices pr ON pr.template_id = d.template_id
       AND pr.schema_version = d.schema_version AND pr.is_active = 1
     JOIN storage_plans sp ON sp.id = ? AND sp.status = 'ACTIVE'
     LEFT JOIN storage_plan_prices spp ON spp.storage_plan_id = sp.id AND spp.is_active = 1
     WHERE d.id = ? AND d.customer_id = ? AND d.status = 'DRAFT'
       AND t.status = 'ACTIVE' AND v.status = 'ACTIVE'`,
  ).bind(requestedPlan.id, body.design_id, ownerId).first<{
    id: string;
    template_id: string;
    schema_version: number;
    revision: number;
    data_json: string;
    title: string;
    template_status: string;
    version_status: string;
    amount_minor: number | null;
    currency: string | null;
    storage_plan_id: string;
    storage_plan_title: string;
    duration_months: number | null;
    is_lifetime: number;
    storage_amount_minor: number | null;
    storage_currency: string | null;
  }>();
  if (!design) {
    const ownedDesign = await env.DB.prepare(
      "SELECT id FROM designs WHERE id = ? AND customer_id = ? AND status = 'DRAFT'",
    ).bind(body.design_id, ownerId).first<{ id: string }>();
    return ownedDesign
      ? apiError(requestId, 422, "PRICE_UNAVAILABLE", "This template has no active server-side price")
      : apiError(requestId, 404, "NOT_FOUND", "Design not found");
  }
  const product = standardProduct(design.template_id);
  const duration = requestedPlan;
  if (!product || !duration || !product.available) {
    return apiError(requestId, 422, "PRICE_UNAVAILABLE", "This product or hosting duration is unavailable");
  }
  const standardPolicyPricing = !localFixturePricing && !renewalPublicationId &&
    isStandardPricingEnabled(env);
  if (!localFixturePricing && !isStandardPricingEnabled(env)) {
    return apiError(requestId, 422, "PRICE_UNAVAILABLE", "Hosting duration pricing has not been approved");
  }
  const templateAmount = renewalPublicationId
    ? 0
    : localFixturePricing
      ? design.amount_minor
      : product.basePriceMinor;
  const policySnapshot = standardPolicyPricing
    ? standardPriceSnapshotForTerm(design.template_id, term)
    : null;
  const storageAmount = localFixturePricing
    ? design.storage_amount_minor
    : renewalPublicationId
      ? standardRenewalAmountMinor(duration)
    : policySnapshot
      ? policySnapshot.total_minor - (templateAmount ?? 0)
      : duration.amountMinor;
  const storageCurrency = localFixturePricing ? design.storage_currency : duration.currency;
  if ((!renewalPublicationId && (!Number.isSafeInteger(templateAmount) ||
      (templateAmount ?? 0) <= 0 || (localFixturePricing && design.currency !== "VND"))) ||
      !Number.isSafeInteger(storageAmount) || (storageAmount ?? -1) < 0 ||
      storageCurrency !== "VND") {
    return apiError(requestId, 422, "PRICE_UNAVAILABLE", "Product or hosting duration has no valid server-side price");
  }
  const resolvedTemplateAmount = templateAmount ?? 0;
  const resolvedStorageAmount = storageAmount ?? 0;
  let authoritativeTotal: number;
  let pricingSnapshot: StandardPriceSnapshot | {
    template_id: string;
    storage_plan_id: string;
    duration_type: "monthly" | "lifetime";
    template_base_price_minor: number;
    hosting_months: number | null;
    included_hosting_months: number | null;
    additional_hosting_months: number | null;
    additional_monthly_price_minor: number;
    hosting_charge_minor: number | null;
    lifetime_price_minor: number | null;
    total_minor: number;
    currency: string;
    pricing_version: string;
    calculated_at: string;
  };
  try {
    if (localFixturePricing) {
      authoritativeTotal = resolvedTemplateAmount + resolvedStorageAmount;
      pricingSnapshot = {
        template_id: design.template_id as StandardPriceSnapshot["template_id"],
        storage_plan_id: duration.id,
        duration_type: term.type,
        template_base_price_minor: resolvedTemplateAmount,
        hosting_months: term.type === "monthly" ? term.months : null,
        included_hosting_months: term.type === "monthly" ? 1 : null,
        additional_hosting_months: term.type === "monthly" ? Math.max(0, term.months - 1) : null,
        additional_monthly_price_minor: 0,
        hosting_charge_minor: term.type === "monthly" ? resolvedStorageAmount : null,
        lifetime_price_minor: term.type === "lifetime" ? authoritativeTotal : null,
        total_minor: authoritativeTotal,
        currency: "VND",
        pricing_version: "local-fixture",
        calculated_at: nowIso(),
      };
    } else if (renewalPublicationId) {
      authoritativeTotal = resolvedStorageAmount;
      pricingSnapshot = {
        template_id: design.template_id as StandardPriceSnapshot["template_id"],
        storage_plan_id: duration.id,
        duration_type: term.type,
        template_base_price_minor: 0,
        hosting_months: term.type === "monthly" ? term.months : null,
        included_hosting_months: null,
        additional_hosting_months: term.type === "monthly" ? term.months : null,
        additional_monthly_price_minor: STANDARD_HOSTING_MONTHLY_ADDITION_MINOR,
        hosting_charge_minor: resolvedStorageAmount,
        lifetime_price_minor: null,
        total_minor: authoritativeTotal,
        currency: "VND",
        pricing_version: STANDARD_PRICING_VERSION,
        calculated_at: nowIso(),
      };
    } else {
      pricingSnapshot = policySnapshot ?? standardPriceSnapshot(design.template_id, design.storage_plan_id);
      authoritativeTotal = pricingSnapshot.total_minor;
    }
  } catch (error) {
    if (!(error instanceof CatalogPriceUnavailableError)) throw error;
    return apiError(requestId, 422, "PRICE_UNAVAILABLE", error.message);
  }
  const data = JSON.parse(design.data_json) as TemplateData;
  const availableAssetIds = new Set(assetReferences(design.template_id, data));
  if (consentIds.some((id) => !availableAssetIds.has(id))) {
    return apiError(requestId, 422, "VALIDATION_ERROR", "Consent may only reference an image in this design");
  }

  const orderId = createOrderId();
  const paymentId = safeId();
  const orderReference = createOrderReference();
  const paymentReference = createPaymentReference();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + ORDER_LIFETIME_MINUTES * 60_000).toISOString();
  const amount = authoritativeTotal;
  if (!Number.isSafeInteger(amount)) {
    return apiError(requestId, 503, "CATALOG_CONFIGURATION_ERROR", "Order total is invalid");
  }
  const statements = [
    env.DB.prepare(
      `INSERT INTO orders (
         id, customer_id, order_type, status, currency, subtotal_minor, discount_minor,
         total_minor, design_id, renewal_publication_id, idempotency_key, created_at, updated_at, expires_at,
         order_reference, design_revision, request_hash, payment_review_required
       )
       SELECT ?, ?, 'SELF_SERVICE', 'AWAITING_PAYMENT', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0
       WHERE EXISTS (
         SELECT 1
         FROM designs d
         JOIN templates t ON t.id = d.template_id AND t.status = 'ACTIVE'
         JOIN template_versions v ON v.template_id = d.template_id
           AND v.schema_version = d.schema_version AND v.status = 'ACTIVE'
         LEFT JOIN template_prices pr ON pr.template_id = d.template_id
           AND pr.schema_version = d.schema_version AND pr.is_active = 1
         JOIN storage_plans sp ON sp.id = ? AND sp.status = 'ACTIVE'
         LEFT JOIN storage_plan_prices spp ON spp.storage_plan_id = sp.id AND spp.is_active = 1
         WHERE d.id = ? AND d.customer_id = ? AND d.status = 'DRAFT'
           AND d.revision = ? AND d.template_id = ? AND d.schema_version = ?
           AND (? = 1 OR pr.amount_minor = ? AND pr.currency = ?)
           AND (? = 1 OR spp.amount_minor = ? AND spp.currency = ?)
           AND (? IS NULL OR EXISTS (
             SELECT 1 FROM publications renewal
             WHERE renewal.id = ? AND renewal.design_id = d.id
               AND renewal.status IN ('PUBLISHED','UNPUBLISHED','EXPIRED')
               AND (renewal.retention_delete_after_at IS NULL OR renewal.retention_delete_after_at > ?)
           ))
       )`,
    ).bind(orderId, ownerId, "VND", amount, amount, design.id, renewalPublicationId,
      idempotencyKey, now, now, expiresAt, orderReference, design.revision, fingerprint,
      design.storage_plan_id, design.id, ownerId, design.revision, design.template_id,
      design.schema_version, !localFixturePricing || Boolean(renewalPublicationId) ? 1 : 0,
      templateAmount, "VND",
      !localFixturePricing ? 1 : 0, storageAmount, "VND",
      renewalPublicationId, renewalPublicationId, now),
    env.DB.prepare(
      `INSERT INTO order_items (
         id, order_id, item_type, reference_id, description_snapshot, quantity,
         unit_amount_minor, line_total_minor, metadata_json, created_at
       )
       SELECT ?, ?, 'TEMPLATE_LICENSE', ?, ?, 1, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?)`,
    ).bind(safeId(), orderId, design.template_id, design.title, templateAmount, templateAmount,
      JSON.stringify({
        schema_version: design.schema_version,
        pricing_snapshot: {
          ...pricingSnapshot,
          template_id: design.template_id,
          storage_plan_id: design.storage_plan_id,
        },
      }), now, orderId),
    env.DB.prepare(
      `INSERT INTO order_items (
         id, order_id, item_type, reference_id, description_snapshot, quantity,
         unit_amount_minor, line_total_minor, metadata_json, created_at
       )
       SELECT ?, ?, 'ADD_ON', ?, ?, 1, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?)`,
    ).bind(safeId(), orderId, design.storage_plan_id, design.storage_plan_title,
      storageAmount, storageAmount,
      JSON.stringify({
        kind: "STORAGE_PLAN",
        storage_plan_id: design.storage_plan_id,
        title: design.storage_plan_title,
        duration_months: design.duration_months,
        lifetime: Boolean(design.is_lifetime),
        amount_minor: storageAmount,
        currency: storageCurrency,
        pricing_snapshot: pricingSnapshot,
        asset_consents: assetConsents,
      }), now, orderId),
    env.DB.prepare(
      `INSERT INTO payments (
         id, order_id, provider, status, amount_minor, currency, idempotency_key,
         created_at, updated_at, payment_reference, review_required
       )
       SELECT ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, 0
       WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?)`,
    ).bind(paymentId, orderId, selectedPaymentProvider(env), amount, "VND", `order:${orderId}`,
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

async function listStoragePlans(env: Env, requestId: string): Promise<Response> {
  const localFixturePricing = env.ENVIRONMENT === "local" &&
    env.LOCAL_TEST_MODE === "true" &&
    env.LOCAL_TEST_CATALOG_OVERRIDE === "true";
  if (!localFixturePricing) {
    return jsonResponse({
      checkout_enabled: resolvePaymentEnvironmentPolicy(env).orderCreationEnabled,
      renewal_month_price_minor: STANDARD_HOSTING_MONTHLY_ADDITION_MINOR,
      plans: STORAGE_DURATIONS.map((plan) => {
        const amountMinor = standardRenewalAmountMinor(plan);
        return {
          id: plan.id,
          title: plan.title,
          duration_months: plan.durationMonths,
          lifetime: plan.lifetime,
          amount_minor: amountMinor,
          currency: plan.currency,
          available: amountMinor !== null,
          price_configured: amountMinor !== null,
        };
      }),
    }, 200, requestId, { "Cache-Control": "no-store" });
  }
  const rows = await env.DB.prepare(
    `SELECT p.id, p.title, p.duration_months, p.is_lifetime,
            price.amount_minor, price.currency
     FROM storage_plans p
     LEFT JOIN storage_plan_prices price
       ON price.storage_plan_id = p.id AND price.is_active = 1
     WHERE p.status = 'ACTIVE'
     ORDER BY CASE p.id WHEN '1-month' THEN 1 WHEN '3-months' THEN 2
       WHEN '6-months' THEN 3 WHEN '12-months' THEN 4 ELSE 5 END`,
  ).all<{
    id: string;
    title: string;
    duration_months: number | null;
    is_lifetime: number;
    amount_minor: number | null;
    currency: string | null;
  }>();
  return jsonResponse({
    checkout_enabled: resolvePaymentEnvironmentPolicy(env).orderCreationEnabled,
    ...(!localApprovedPricingEnabled(env)
      ? { renewal_month_price_minor: STANDARD_HOSTING_MONTHLY_ADDITION_MINOR }
      : {}),
    plans: rows.results.map((plan) => ({
      id: plan.id,
      title: plan.title,
      duration_months: plan.duration_months,
      lifetime: Boolean(plan.is_lifetime),
      amount_minor: plan.amount_minor,
      currency: plan.currency,
      available: plan.amount_minor !== null && plan.currency === "VND",
      price_configured: plan.amount_minor !== null && plan.currency === "VND",
    })),
  }, 200, requestId, { "Cache-Control": "no-store" });
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
  if (payment.currency !== "VND" ||
      payment.order_currency !== payment.currency ||
      payment.order_total_minor !== payment.amount_minor ||
      (payment.snapshot_total_minor !== null &&
        payment.snapshot_total_minor !== payment.order_total_minor)) {
    return "Payment amount or currency does not match the order";
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
  if (env.PAYMENT_MODE !== "mock" &&
      payment && payment.payment_status !== "SUCCEEDED" && payment.order_status !== "PAID") {
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
      SEPAY_PROVIDER, eventId, details.preserveOutcome ? 1 : 0),
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
  ).bind(attemptAt, SEPAY_PROVIDER, eventId).run();
  if (attempt.meta.changes !== 1) return;
  const stored = await env.DB.prepare(
    `SELECT outcome, raw_payload FROM payment_webhook_events
     WHERE provider = ? AND event_id = ?`,
  ).bind(SEPAY_PROVIDER, eventId).first<{ outcome: string | null; raw_payload: string }>();
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
              o.total_minor AS order_total_minor, o.currency AS order_currency,
              o.payment_review_required, p.status AS payment_status,
              p.review_required, p.amount_minor, p.currency, p.payment_reference,
              p.provider_payment_id, o.expires_at,
              (SELECT CAST(json_extract(i.metadata_json, '$.pricing_snapshot.total_minor') AS INTEGER)
               FROM order_items i WHERE i.order_id = o.id AND i.item_type = 'ADD_ON') AS snapshot_total_minor
       FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE p.provider = ? AND p.payment_reference = ?`,
    ).bind(SEPAY_PROVIDER, transaction.paymentReference).first<PaymentRow>()
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
             AND total_minor = ? AND currency = ?
           )`,
      ).bind(transactionId, now, now, payment.id, payment.amount_minor, payment.order_id, now,
        payment.order_total_minor, payment.order_currency),
      env.DB.prepare(
        `UPDATE orders SET status = 'PAID', paid_at = ?, updated_at = ?
         WHERE id = ? AND status = 'AWAITING_PAYMENT' AND payment_review_required = 0
           AND EXISTS (
             SELECT 1 FROM payments WHERE id = ? AND status = 'SUCCEEDED'
               AND provider_payment_id = ?
               AND amount_minor = (SELECT total_minor FROM orders WHERE id = ?)
               AND currency = (SELECT currency FROM orders WHERE id = ?)
           )`,
      ).bind(now, now, payment.order_id, payment.id, transactionId,
        payment.order_id, payment.order_id),
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
        payment.amount_minor, transaction.amountMinor, SEPAY_PROVIDER, eventId),
      env.DB.prepare(
        `INSERT INTO fulfillment_jobs (id, order_id, status, created_at, updated_at)
         SELECT ?, ?, 'PENDING', ?, ?
         WHERE EXISTS (
           SELECT 1 FROM orders o
           JOIN payments p ON p.order_id = o.id
           JOIN payment_webhook_events e ON e.provider = p.provider
             AND e.event_id = p.provider_payment_id AND e.outcome = 'PROCESSED'
           WHERE o.id = ? AND o.status = 'PAID' AND p.id = ?
             AND p.status = 'SUCCEEDED' AND p.provider_payment_id = ?
             AND p.amount_minor = o.total_minor AND p.currency = o.currency
         )
         ON CONFLICT(order_id) DO NOTHING`,
      ).bind(safeId(), payment.order_id, now, now, payment.order_id, payment.id, transactionId),
    ]);
  } catch (error) {
    if (!(error instanceof DatabaseError) || error.code !== "CONSTRAINT") throw error;
    const existingTransaction = await env.DB.prepare(
      "SELECT id FROM payments WHERE provider = ? AND provider_payment_id = ?",
    ).bind(SEPAY_PROVIDER, transactionId).first<{ id: string }>();
    if (!existingTransaction) throw error;
    await markWebhookReview(
      env,
      eventId,
      "Provider transaction is already linked to another payment",
      payment,
      { actualAmountMinor: transaction.amountMinor },
    );
  }
  const processed = await env.DB.prepare(
    `SELECT outcome FROM payment_webhook_events WHERE provider = ? AND event_id = ?`,
  ).bind(SEPAY_PROVIDER, eventId).first<{ outcome: string }>();
  if (processed?.outcome === "PROCESSED") {
    await handleFulfillmentForOrder(env, payment.order_id);
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
              o.total_minor AS order_total_minor, o.currency AS order_currency,
              o.payment_review_required, p.status AS payment_status,
              p.review_required, p.amount_minor, p.currency, p.payment_reference,
              p.provider_payment_id, o.expires_at,
              (SELECT CAST(json_extract(i.metadata_json, '$.pricing_snapshot.total_minor') AS INTEGER)
               FROM order_items i WHERE i.order_id = o.id AND i.item_type = 'ADD_ON') AS snapshot_total_minor
       FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE p.provider = ? AND p.payment_reference = ?`,
    ).bind(SEPAY_PROVIDER, transaction.paymentReference).first<PaymentRow>()
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
  if (!resolvePaymentEnvironmentPolicy(env).sepayWebhookEnabled) {
    throw new Error("SePay webhook recovery is disabled for this runtime");
  }
  const events = await env.DB.prepare(
    `SELECT event_id, raw_payload FROM payment_webhook_events
     WHERE provider = ? AND outcome = 'RECEIVED'
     ORDER BY received_at LIMIT ?`,
  ).bind(SEPAY_PROVIDER, limit).all<{ event_id: string; raw_payload: string }>();
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
  ).bind(SEPAY_PROVIDER).first<{ count: number }>();
  return { attempted: events.results.length, pending: Number(pending?.count ?? 0) };
}

async function handleSepayWebhook(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  const unavailable = paymentModeError(requestId, env, true);
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
  ).bind(safeId(), SEPAY_PROVIDER, parsed.eventId, payloadHash, nowIso(),
    new TextDecoder().decode(rawBody), parsed.transactionId,
    typeof parsed.payload?.transferAmount === "number" &&
        Number.isSafeInteger(parsed.payload.transferAmount)
      ? parsed.payload.transferAmount
      : null).run();

  const prior = await env.DB.prepare(
    `SELECT payload_hash, outcome FROM payment_webhook_events
     WHERE provider = ? AND event_id = ?`,
  ).bind(SEPAY_PROVIDER, parsed.eventId).first<{ payload_hash: string; outcome: string | null }>();
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
  if (path === "/api/v1/catalog") {
    if (request.method !== "GET") return apiError(requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
    return jsonResponse(
      {
        ...publicProductCatalog({ catalogEnabled: isStandardPricingEnabled(env) }),
        checkout_enabled: resolvePaymentEnvironmentPolicy(env).orderCreationEnabled,
      },
      200,
      requestId,
      { "Cache-Control": "no-store" },
    );
  }
  if (path === "/api/v1/storage-plans") {
    if (request.method !== "GET") return apiError(requestId, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
    return listStoragePlans(env, requestId);
  }
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

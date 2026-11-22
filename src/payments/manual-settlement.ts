import { DatabaseError } from "../database.ts";
import { nowIso, safeId } from "../http.ts";
import { handleFulfillmentForOrder, type FulfillmentResult } from "../publications.ts";
import { previewAssetUploadsEnabled } from "../preview-assets.ts";
import { resolvePaymentEnvironmentPolicy } from "./policy.ts";
import { verifiedSettlementEvidence } from "./evidence.ts";
import type { Env } from "../types.ts";

const MANUAL_PROVIDER = "MANUAL_BANK_TRANSFER";

interface ManualConfirmationRow {
  id: string;
  order_id: string;
  payment_id: string;
  transaction_reference: string | null;
  amount_minor: number;
  order_status: string;
  payment_status: string;
}

interface ManualOrderRow {
  order_id: string;
  payment_id: string;
  order_status: string;
  payment_status: string;
  provider: string;
  order_total_minor: number;
  payment_amount_minor: number;
  order_currency: string;
  payment_currency: string;
  payment_review_required: number;
  order_review_required: number;
  expires_at: string | null;
  snapshot_total_minor: number | null;
  has_uploaded_media: number;
}

export type ManualPaymentConfirmationResult =
  | { kind: "disabled" }
  | { kind: "not_found" }
  | { kind: "conflict" }
  | { kind: "confirmed"; replayed: boolean; fulfillment: FulfillmentResult };

function sameReference(left: string | null, right: string | null): boolean {
  return left === null || right === null
    ? left === right
    : left.toLowerCase() === right.toLowerCase();
}

function mediaSettlementGuard(env: Env, orderIdExpression: string): string {
  return previewAssetUploadsEnabled(env)
    ? "1 = 1"
    : `NOT EXISTS (
         SELECT 1 FROM order_asset_refs media_ref
         WHERE media_ref.order_id = ${orderIdExpression}
       )`;
}

async function findConfirmation(
  env: Env,
  orderId: string,
): Promise<ManualConfirmationRow | null> {
  return env.DB.prepare(
    `SELECT confirmation.id, confirmation.order_id, confirmation.payment_id,
            confirmation.transaction_reference, confirmation.amount_minor,
            order_row.status AS order_status, payment.status AS payment_status
     FROM manual_payment_confirmations confirmation
     JOIN orders order_row ON order_row.id = confirmation.order_id
     JOIN payments payment ON payment.id = confirmation.payment_id
     WHERE confirmation.order_id = ?`,
  ).bind(orderId).first<ManualConfirmationRow>();
}

async function loadManualOrder(env: Env, orderId: string): Promise<ManualOrderRow | null> {
  return env.DB.prepare(
    `SELECT order_row.id AS order_id, payment.id AS payment_id,
            order_row.status AS order_status, payment.status AS payment_status,
            payment.provider, order_row.total_minor AS order_total_minor,
            payment.amount_minor AS payment_amount_minor,
            order_row.currency AS order_currency, payment.currency AS payment_currency,
            payment.review_required AS payment_review_required,
            order_row.payment_review_required AS order_review_required,
            order_row.expires_at,
            (SELECT CAST(json_extract(item.metadata_json, '$.pricing_snapshot.total_minor') AS INTEGER)
             FROM order_items item
             WHERE item.order_id = order_row.id AND item.item_type = 'ADD_ON'
             LIMIT 1) AS snapshot_total_minor,
            EXISTS (
              SELECT 1 FROM order_asset_refs media_ref
              WHERE media_ref.order_id = order_row.id
            ) AS has_uploaded_media
     FROM orders order_row
     JOIN payments payment ON payment.order_id = order_row.id
     WHERE order_row.id = ?`,
  ).bind(orderId).first<ManualOrderRow>();
}

export async function confirmManualPayment(
  env: Env,
  input: {
    orderId: string;
    actorCustomerId: string;
    requestId: string;
    amountMinor: number;
    transactionReference: string | null;
  },
): Promise<ManualPaymentConfirmationResult> {
  const policy = resolvePaymentEnvironmentPolicy(env);
  if (policy.provider !== MANUAL_PROVIDER || policy.mode !== "manual-bank-transfer" ||
      !policy.fulfillmentEnabled) {
    return { kind: "disabled" };
  }

  const order = await loadManualOrder(env, input.orderId);
  if (!order) return { kind: "not_found" };
  if (order.provider !== MANUAL_PROVIDER ||
      order.order_total_minor !== input.amountMinor ||
      order.payment_amount_minor !== input.amountMinor ||
      order.order_currency !== "VND" ||
      order.payment_currency !== "VND" ||
      order.payment_review_required !== 0 ||
      order.order_review_required !== 0 ||
      (order.snapshot_total_minor !== null &&
        order.snapshot_total_minor !== input.amountMinor)) {
    return { kind: "conflict" };
  }
  if (!previewAssetUploadsEnabled(env) && order.has_uploaded_media) {
    return { kind: "conflict" };
  }

  let confirmation = await findConfirmation(env, input.orderId);
  let replayed = Boolean(confirmation);
  if (confirmation) {
    if (confirmation.amount_minor !== input.amountMinor ||
        !sameReference(confirmation.transaction_reference, input.transactionReference)) {
      return { kind: "conflict" };
    }
  } else {
    const now = nowIso();
    const confirmationId = safeId();
    try {
      const inserted = await env.DB.prepare(
        `INSERT INTO manual_payment_confirmations (
           id, payment_id, order_id, actor_customer_id, request_id,
           transaction_reference, amount_minor, currency, confirmed_at, created_at
         )
         SELECT ?, payment.id, order_row.id, ?, ?, ?, payment.amount_minor,
                payment.currency, ?, ?
         FROM orders order_row
         JOIN payments payment ON payment.order_id = order_row.id
         WHERE order_row.id = ?
           AND order_row.order_type = 'SELF_SERVICE'
           AND order_row.status = 'AWAITING_PAYMENT'
           AND order_row.payment_review_required = 0
           AND order_row.expires_at IS NOT NULL
           AND julianday(order_row.expires_at) > julianday(?)
           AND order_row.total_minor = ?
           AND order_row.currency = 'VND'
           AND payment.provider = ?
           AND payment.status = 'PENDING'
           AND payment.review_required = 0
           AND payment.amount_minor = order_row.total_minor
           AND payment.amount_minor = ?
           AND payment.currency = order_row.currency
           AND ${mediaSettlementGuard(env, "order_row.id")}
           AND NOT EXISTS (
             SELECT 1 FROM order_items pricing_item
             WHERE pricing_item.order_id = order_row.id
               AND pricing_item.item_type = 'ADD_ON'
               AND json_extract(pricing_item.metadata_json, '$.pricing_snapshot.total_minor') IS NOT NULL
               AND CAST(json_extract(pricing_item.metadata_json, '$.pricing_snapshot.total_minor') AS INTEGER)
                 <> payment.amount_minor
           )`,
      ).bind(
        confirmationId,
        input.actorCustomerId,
        input.requestId,
        input.transactionReference,
        now,
        now,
        input.orderId,
        now,
        input.amountMinor,
        MANUAL_PROVIDER,
        input.amountMinor,
      ).run();
      if (inserted.meta.changes !== 1) return { kind: "conflict" };
    } catch (error) {
      if (!(error instanceof DatabaseError) || error.code !== "CONSTRAINT") throw error;
      const byOrder = await findConfirmation(env, input.orderId);
      if (!byOrder || byOrder.amount_minor !== input.amountMinor ||
          !sameReference(byOrder.transaction_reference, input.transactionReference)) {
        return { kind: "conflict" };
      }
      confirmation = byOrder;
      replayed = true;
    }
    confirmation ??= await findConfirmation(env, input.orderId);
    if (!confirmation) throw new Error("Manual payment confirmation was not persisted");
  }

  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE payments SET status = 'SUCCEEDED',
         succeeded_at = COALESCE(succeeded_at, ?), updated_at = ?
       WHERE id = ? AND order_id = ? AND provider = ?
         AND status IN ('PENDING', 'SUCCEEDED') AND review_required = 0
         AND amount_minor = ? AND currency = 'VND'
         AND ${mediaSettlementGuard(env, "payments.order_id")}
         AND EXISTS (
           SELECT 1 FROM manual_payment_confirmations confirmation
           WHERE confirmation.id = ? AND confirmation.payment_id = payments.id
             AND confirmation.order_id = payments.order_id
             AND confirmation.amount_minor = payments.amount_minor
             AND confirmation.currency = payments.currency
         )`,
    ).bind(now, now, order.payment_id, input.orderId, MANUAL_PROVIDER,
      input.amountMinor, confirmation.id),
    env.DB.prepare(
      `UPDATE orders SET status = 'PAID', paid_at = COALESCE(paid_at, ?), updated_at = ?
       WHERE id = ? AND order_type = 'SELF_SERVICE' AND status = 'AWAITING_PAYMENT'
         AND payment_review_required = 0
         AND ${mediaSettlementGuard(env, "orders.id")}
         AND EXISTS (
           SELECT 1 FROM payments payment
           JOIN manual_payment_confirmations confirmation
             ON confirmation.payment_id = payment.id AND confirmation.order_id = orders.id
           WHERE payment.order_id = orders.id AND payment.provider = ?
             AND payment.status = 'SUCCEEDED' AND payment.succeeded_at IS NOT NULL
             AND payment.review_required = 0 AND payment.amount_minor = orders.total_minor
             AND payment.currency = orders.currency AND payment.amount_minor = ?
             AND confirmation.id = ? AND confirmation.amount_minor = payment.amount_minor
             AND confirmation.currency = payment.currency
             AND julianday(orders.expires_at) > julianday(confirmation.confirmed_at)
         )`,
    ).bind(now, now, input.orderId, MANUAL_PROVIDER, input.amountMinor, confirmation.id),
    env.DB.prepare(
      `INSERT INTO fulfillment_jobs (id, order_id, status, created_at, updated_at)
       SELECT ?, order_row.id, 'PENDING', ?, ?
       FROM orders order_row
       JOIN payments payment ON payment.order_id = order_row.id
       WHERE order_row.id = ? AND order_row.status = 'PAID'
         AND ${mediaSettlementGuard(env, "order_row.id")}
         AND payment.provider = ? AND payment.status = 'SUCCEEDED'
         AND ${verifiedSettlementEvidence("payment", "order_row")}
       ON CONFLICT(order_id) DO NOTHING`,
    ).bind(safeId(), now, now, input.orderId, MANUAL_PROVIDER),
  ]);

  const settled = await env.DB.prepare(
    `SELECT order_row.status AS order_status, payment.status AS payment_status,
            EXISTS (
              SELECT 1 FROM fulfillment_jobs job WHERE job.order_id = order_row.id
            ) AS has_fulfillment_job
     FROM orders order_row
     JOIN payments payment ON payment.order_id = order_row.id
     WHERE order_row.id = ? AND payment.id = ?`,
  ).bind(input.orderId, order.payment_id).first<{
    order_status: string;
    payment_status: string;
    has_fulfillment_job: number;
  }>();
  if (!settled || !["PAID", "FULFILLING", "FULFILLED"].includes(settled.order_status) ||
      settled.payment_status !== "SUCCEEDED" || !settled.has_fulfillment_job) {
    throw new Error("Manual payment confirmation persisted but settlement state requires recovery");
  }

  const fulfillment = await handleFulfillmentForOrder(env, input.orderId);
  return { kind: "confirmed", replayed, fulfillment };
}

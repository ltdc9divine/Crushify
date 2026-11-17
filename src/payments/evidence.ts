export function verifiedSettlementEvidence(
  paymentAlias: string,
  orderAlias: string,
): string {
  return `(
    ${paymentAlias}.status = 'SUCCEEDED'
    AND ${paymentAlias}.review_required = 0
    AND ${paymentAlias}.succeeded_at IS NOT NULL
    AND ${orderAlias}.order_type = 'SELF_SERVICE'
    AND ${orderAlias}.status IN ('PAID', 'FULFILLING', 'FULFILLED')
    AND ${orderAlias}.paid_at IS NOT NULL
    AND ${orderAlias}.payment_review_required = 0
    AND ${paymentAlias}.amount_minor = ${orderAlias}.total_minor
    AND ${paymentAlias}.currency = ${orderAlias}.currency
    AND (
      (
        ${paymentAlias}.provider = 'SEPAY'
        AND EXISTS (
          SELECT 1 FROM payment_settlement_evidence evidence
          WHERE evidence.payment_id = ${paymentAlias}.id
            AND evidence.provider = ${paymentAlias}.provider
            AND evidence.status = 'VERIFIED'
            AND evidence.amount_minor = ${paymentAlias}.amount_minor
            AND evidence.amount_minor = ${orderAlias}.total_minor
            AND evidence.currency = ${paymentAlias}.currency
            AND evidence.currency = ${orderAlias}.currency
            AND evidence.evidence_source = 'SEPAY_WEBHOOK'
            AND evidence.source_transaction_id = ${paymentAlias}.provider_payment_id
            AND (
              SELECT COUNT(*) > 0
                AND COALESCE(SUM(CASE
                  WHEN webhook.outcome = 'PROCESSED'
                    AND webhook.review_reason IS NULL
                    AND webhook.payload_hash = evidence.payload_hash
                    AND webhook.actual_amount_minor = evidence.amount_minor
                  THEN 1 ELSE 0 END), 0) = COUNT(*)
              FROM payment_webhook_events webhook
              WHERE webhook.provider = evidence.provider
                AND webhook.provider_transaction_id = evidence.source_transaction_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM payment_settlement_evidence conflicting_evidence
              WHERE conflicting_evidence.payment_id = ${paymentAlias}.id
                AND (
                  conflicting_evidence.provider <> ${paymentAlias}.provider
                  OR conflicting_evidence.status <> 'VERIFIED'
                  OR conflicting_evidence.amount_minor <> ${paymentAlias}.amount_minor
                  OR conflicting_evidence.amount_minor <> ${orderAlias}.total_minor
                  OR conflicting_evidence.currency <> ${paymentAlias}.currency
                  OR conflicting_evidence.currency <> ${orderAlias}.currency
                )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM payment_webhook_events rejected_webhook
              JOIN payment_settlement_evidence related_evidence
                ON related_evidence.payment_id = ${paymentAlias}.id
                AND related_evidence.provider = rejected_webhook.provider
                AND related_evidence.source_transaction_id =
                  rejected_webhook.provider_transaction_id
              WHERE rejected_webhook.outcome IS NULL
                OR rejected_webhook.outcome <> 'PROCESSED'
                OR rejected_webhook.review_reason IS NOT NULL
                OR rejected_webhook.actual_amount_minor IS NULL
                OR rejected_webhook.actual_amount_minor <> related_evidence.amount_minor
                OR (
                  related_evidence.evidence_source = 'SEPAY_WEBHOOK'
                  AND rejected_webhook.payload_hash <> related_evidence.payload_hash
                )
            )
        )
      )
      OR (
        ${paymentAlias}.provider = 'MANUAL_BANK_TRANSFER'
        AND EXISTS (
          SELECT 1 FROM manual_payment_confirmations confirmation
          WHERE confirmation.payment_id = ${paymentAlias}.id
            AND confirmation.order_id = ${orderAlias}.id
            AND confirmation.amount_minor = ${paymentAlias}.amount_minor
            AND confirmation.amount_minor = ${orderAlias}.total_minor
            AND confirmation.currency = ${paymentAlias}.currency
            AND confirmation.currency = ${orderAlias}.currency
        )
        AND NOT EXISTS (
          SELECT 1 FROM payment_settlement_evidence conflicting_evidence
          WHERE conflicting_evidence.payment_id = ${paymentAlias}.id
        )
      )
    )
  )`;
}

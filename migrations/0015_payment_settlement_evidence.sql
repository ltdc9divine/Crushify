CREATE TABLE payment_settlement_evidence (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider = 'SEPAY'),
  evidence_source TEXT NOT NULL CHECK (
    evidence_source IN ('SEPAY_WEBHOOK', 'SEPAY_API_V2')
  ),
  source_transaction_id TEXT NOT NULL CHECK (length(trim(source_transaction_id)) > 0),
  receiving_bank_account_id TEXT CHECK (
    receiving_bank_account_id IS NULL OR length(trim(receiving_bank_account_id)) > 0
  ),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  verified_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (
    length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^a-fA-F0-9]*'
  ),
  status TEXT NOT NULL DEFAULT 'VERIFIED' CHECK (status IN ('VERIFIED', 'REVOKED')),
  created_at TEXT NOT NULL,
  UNIQUE (provider, evidence_source, source_transaction_id)
);

CREATE INDEX payment_settlement_evidence_payment_status
  ON payment_settlement_evidence(payment_id, status, verified_at);

CREATE INDEX payment_settlement_evidence_provider_source
  ON payment_settlement_evidence(provider, evidence_source, verified_at);

CREATE TRIGGER payment_settlement_evidence_payment_identity
BEFORE INSERT ON payment_settlement_evidence
WHEN EXISTS (
  SELECT 1
  FROM payment_settlement_evidence existing
  WHERE existing.provider = NEW.provider
    AND existing.source_transaction_id = NEW.source_transaction_id
    AND existing.payment_id <> NEW.payment_id
)
BEGIN
  SELECT RAISE(ABORT, 'settlement source transaction belongs to another payment');
END;

CREATE TRIGGER payment_settlement_evidence_payment_identity_update
BEFORE UPDATE OF provider, source_transaction_id, payment_id ON payment_settlement_evidence
WHEN EXISTS (
  SELECT 1
  FROM payment_settlement_evidence existing
  WHERE existing.id <> OLD.id
    AND existing.provider = NEW.provider
    AND existing.source_transaction_id = NEW.source_transaction_id
    AND existing.payment_id <> NEW.payment_id
)
BEGIN
  SELECT RAISE(ABORT, 'settlement source transaction belongs to another payment');
END;

INSERT INTO payment_settlement_evidence (
  id, payment_id, provider, evidence_source, source_transaction_id,
  receiving_bank_account_id, amount_minor, currency, verified_at, payload_hash,
  status, created_at
)
SELECT 'legacy-settlement-evidence-' || p.id, p.id, p.provider, 'SEPAY_WEBHOOK',
       e.provider_transaction_id, NULL, p.amount_minor, p.currency, e.processed_at,
       e.payload_hash, 'VERIFIED', e.processed_at
FROM payments p
JOIN orders o ON o.id = p.order_id
JOIN payment_webhook_events e ON e.provider = p.provider
  AND e.event_id = p.provider_payment_id
WHERE p.provider = 'SEPAY'
  AND p.status = 'SUCCEEDED'
  AND p.review_required = 0
  AND p.provider_payment_id IS NOT NULL
  AND length(trim(p.provider_payment_id)) > 0
  AND p.amount_minor > 0
  AND p.currency = 'VND'
  AND p.succeeded_at IS NOT NULL
  AND o.order_type = 'SELF_SERVICE'
  AND o.status IN ('PAID', 'FULFILLING', 'FULFILLED')
  AND o.paid_at IS NOT NULL
  AND o.payment_review_required = 0
  AND o.total_minor = p.amount_minor
  AND o.currency = p.currency
  AND e.outcome = 'PROCESSED'
  AND e.review_reason IS NULL
  AND e.order_reference = o.order_reference
  AND e.provider_transaction_id = p.provider_payment_id
  AND e.expected_amount_minor = p.amount_minor
  AND e.actual_amount_minor = p.amount_minor
  AND e.processed_at IS NOT NULL
  AND julianday(e.received_at) IS NOT NULL
  AND julianday(e.processed_at) IS NOT NULL
  AND julianday(e.received_at) <= julianday(e.processed_at)
  AND length(e.payload_hash) = 64
  AND e.payload_hash NOT GLOB '*[^a-fA-F0-9]*'
  AND json_valid(e.raw_payload)
  AND NOT EXISTS (
    SELECT 1
    FROM order_items pricing_item
    WHERE pricing_item.order_id = o.id
      AND pricing_item.item_type = 'ADD_ON'
      AND json_extract(pricing_item.metadata_json, '$.pricing_snapshot.total_minor') IS NOT NULL
      AND CAST(json_extract(pricing_item.metadata_json, '$.pricing_snapshot.total_minor') AS INTEGER)
        <> p.amount_minor
  )
  AND NOT EXISTS (
    SELECT 1
    FROM payment_webhook_events conflicting
    WHERE conflicting.provider = e.provider
      AND conflicting.provider_transaction_id = e.provider_transaction_id
      AND (
        conflicting.outcome IS NULL
        OR conflicting.outcome <> 'PROCESSED'
        OR conflicting.review_reason IS NOT NULL
        OR conflicting.payload_hash <> e.payload_hash
        OR conflicting.actual_amount_minor IS NULL
        OR conflicting.actual_amount_minor <> p.amount_minor
      )
  )
  AND (
    SELECT COUNT(*)
    FROM payments duplicate
    WHERE duplicate.provider = p.provider
      AND duplicate.provider_payment_id = p.provider_payment_id
  ) = 1;

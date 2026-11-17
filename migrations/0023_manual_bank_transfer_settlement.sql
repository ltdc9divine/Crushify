CREATE TABLE manual_payment_confirmations (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  actor_customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  transaction_reference TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (currency = 'VND'),
  confirmed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (
    transaction_reference IS NULL OR
    (length(trim(transaction_reference)) BETWEEN 1 AND 128
      AND transaction_reference NOT GLOB '*[^ -~]*')
  )
);

CREATE UNIQUE INDEX manual_payment_confirmations_transaction_reference
  ON manual_payment_confirmations(transaction_reference COLLATE NOCASE)
  WHERE transaction_reference IS NOT NULL;
CREATE INDEX manual_payment_confirmations_timeline
  ON manual_payment_confirmations(confirmed_at DESC, id DESC);

CREATE TRIGGER manual_payment_confirmations_validate_insert
BEFORE INSERT ON manual_payment_confirmations
WHEN NOT EXISTS (
  SELECT 1
  FROM payments payment
  JOIN orders order_row ON order_row.id = payment.order_id
  WHERE payment.id = NEW.payment_id
    AND payment.order_id = NEW.order_id
    AND payment.provider = 'MANUAL_BANK_TRANSFER'
    AND payment.status = 'PENDING'
    AND payment.review_required = 0
    AND payment.amount_minor = NEW.amount_minor
    AND payment.currency = NEW.currency
    AND order_row.order_type = 'SELF_SERVICE'
    AND order_row.status = 'AWAITING_PAYMENT'
    AND order_row.payment_review_required = 0
    AND order_row.total_minor = NEW.amount_minor
    AND order_row.currency = NEW.currency
    AND order_row.expires_at IS NOT NULL
    AND julianday(order_row.expires_at) > julianday(NEW.confirmed_at)
    AND NOT EXISTS (
      SELECT 1 FROM order_items pricing_item
      WHERE pricing_item.order_id = order_row.id
        AND pricing_item.item_type = 'ADD_ON'
        AND json_extract(pricing_item.metadata_json, '$.pricing_snapshot.total_minor') IS NOT NULL
        AND CAST(json_extract(pricing_item.metadata_json, '$.pricing_snapshot.total_minor') AS INTEGER)
          <> NEW.amount_minor
    )
)
BEGIN
  SELECT RAISE(ABORT, 'manual payment confirmation does not match an eligible order');
END;

CREATE TRIGGER manual_payment_confirmations_immutable_update
BEFORE UPDATE ON manual_payment_confirmations
BEGIN
  SELECT RAISE(ABORT, 'manual payment confirmations are immutable');
END;

CREATE TRIGGER manual_payment_confirmations_immutable_delete
BEFORE DELETE ON manual_payment_confirmations
BEGIN
  SELECT RAISE(ABORT, 'manual payment confirmations are immutable');
END;

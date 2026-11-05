CREATE TABLE template_prices (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'VND' CHECK (currency = 'VND'),
  amount_minor INTEGER CHECK (amount_minor IS NULL OR amount_minor > 0),
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (template_id, schema_version)
    REFERENCES template_versions(template_id, schema_version),
  CHECK (is_active = 0 OR amount_minor IS NOT NULL)
);
CREATE UNIQUE INDEX template_prices_one_active
  ON template_prices(template_id, schema_version)
  WHERE is_active = 1;

ALTER TABLE orders ADD COLUMN order_reference TEXT;
ALTER TABLE orders ADD COLUMN design_revision INTEGER;
ALTER TABLE orders ADD COLUMN request_hash TEXT;
ALTER TABLE orders ADD COLUMN payment_review_required INTEGER NOT NULL DEFAULT 0
  CHECK (payment_review_required IN (0, 1));
CREATE UNIQUE INDEX orders_reference_unique ON orders(order_reference)
  WHERE order_reference IS NOT NULL;

ALTER TABLE payments ADD COLUMN payment_reference TEXT;
ALTER TABLE payments ADD COLUMN review_required INTEGER NOT NULL DEFAULT 0
  CHECK (review_required IN (0, 1));
CREATE UNIQUE INDEX payments_reference_unique ON payments(payment_reference)
  WHERE payment_reference IS NOT NULL;

ALTER TABLE payment_webhook_events ADD COLUMN raw_payload TEXT NOT NULL DEFAULT '{}';
ALTER TABLE payment_webhook_events ADD COLUMN review_reason TEXT;

ALTER TABLE payment_webhook_events ADD COLUMN processing_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (processing_attempts >= 0);
ALTER TABLE payment_webhook_events ADD COLUMN last_attempt_at TEXT;
ALTER TABLE payment_webhook_events ADD COLUMN provider_transaction_id TEXT;
ALTER TABLE payment_webhook_events ADD COLUMN order_reference TEXT;
ALTER TABLE payment_webhook_events ADD COLUMN expected_amount_minor INTEGER
  CHECK (expected_amount_minor IS NULL OR expected_amount_minor >= 0);
ALTER TABLE payment_webhook_events ADD COLUMN actual_amount_minor INTEGER
  CHECK (actual_amount_minor IS NULL OR actual_amount_minor >= 0);

CREATE INDEX payment_webhook_events_recovery
  ON payment_webhook_events(provider, outcome, received_at);

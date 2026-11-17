CREATE TABLE sepay_api_observations (
  transaction_uuid TEXT PRIMARY KEY CHECK (
    length(transaction_uuid) = 36 AND transaction_uuid = lower(transaction_uuid)
  ),
  bank_account_id TEXT NOT NULL CHECK (
    length(bank_account_id) = 36 AND bank_account_id = lower(bank_account_id)
  ),
  transaction_date TEXT NOT NULL,
  transfer_type TEXT NOT NULL CHECK (transfer_type IN ('in', 'out')),
  amount_in INTEGER NOT NULL CHECK (amount_in >= 0),
  amount_out INTEGER NOT NULL CHECK (amount_out >= 0),
  reference_number TEXT,
  code TEXT,
  webhook_success INTEGER CHECK (webhook_success IS NULL OR webhook_success IN (0, 1)),
  payload_hash TEXT NOT NULL CHECK (
    length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^a-f0-9]*'
  ),
  scan_type TEXT NOT NULL CHECK (scan_type IN ('DATE_WINDOW', 'SINCE_ID')),
  status TEXT NOT NULL CHECK (
    status IN ('UNMATCHED', 'CANDIDATE', 'AMBIGUOUS', 'MANUAL_REVIEW', 'RECONCILED')
  ),
  reason_code TEXT NOT NULL CHECK (length(trim(reason_code)) > 0),
  payment_id TEXT REFERENCES payments(id) ON DELETE RESTRICT,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL
);

CREATE INDEX sepay_api_observations_status_date
  ON sepay_api_observations(status, transaction_date);

CREATE INDEX sepay_api_observations_bank_date
  ON sepay_api_observations(bank_account_id, transaction_date);

CREATE TRIGGER sepay_api_observations_transaction_identity
BEFORE UPDATE OF transaction_uuid ON sepay_api_observations
WHEN NEW.transaction_uuid <> OLD.transaction_uuid
BEGIN
  SELECT RAISE(ABORT, 'SePay API observation transaction identity is immutable');
END;

CREATE TRIGGER sepay_api_observations_payment_owner
BEFORE UPDATE OF payment_id ON sepay_api_observations
WHEN OLD.payment_id IS NOT NULL AND NEW.payment_id IS NOT OLD.payment_id
BEGIN
  SELECT RAISE(ABORT, 'SePay API observation payment ownership cannot be reassigned');
END;

CREATE TABLE sepay_api_reconciliation_cursors (
  scan_key TEXT NOT NULL CHECK (length(trim(scan_key)) > 0),
  scan_mode TEXT NOT NULL CHECK (scan_mode IN ('DATE_WINDOW', 'SINCE_ID')),
  cursor_transaction_id TEXT REFERENCES sepay_api_observations(transaction_uuid) ON DELETE RESTRICT,
  window_start TEXT,
  window_end TEXT,
  scan_completed_at TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scan_key, scan_mode),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK (
    (scan_mode = 'DATE_WINDOW' AND cursor_transaction_id IS NULL) OR
    (scan_mode = 'SINCE_ID' AND window_start IS NULL AND window_end IS NULL)
  )
);

CREATE INDEX sepay_api_reconciliation_lease
  ON sepay_api_reconciliation_cursors(lease_expires_at);

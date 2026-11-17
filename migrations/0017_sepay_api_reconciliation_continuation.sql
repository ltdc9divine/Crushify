ALTER TABLE sepay_api_reconciliation_cursors
  ADD COLUMN pending_window_start TEXT;

ALTER TABLE sepay_api_reconciliation_cursors
  ADD COLUMN pending_window_end TEXT;

ALTER TABLE sepay_api_reconciliation_cursors
  ADD COLUMN pending_since_id TEXT;

ALTER TABLE sepay_api_reconciliation_cursors
  ADD COLUMN pending_next_page INTEGER NOT NULL DEFAULT 1
  CHECK (pending_next_page >= 1);

ALTER TABLE sepay_api_reconciliation_cursors
  ADD COLUMN pending_complete INTEGER NOT NULL DEFAULT 0
  CHECK (pending_complete IN (0, 1));

ALTER TABLE sepay_api_reconciliation_cursors
  ADD COLUMN pending_last_transaction_id TEXT;

ALTER TABLE sepay_api_reconciliation_cursors
  ADD COLUMN pending_last_transaction_date TEXT;

ALTER TABLE sepay_api_reconciliation_cursors
  ADD COLUMN pending_last_page_fingerprint TEXT
  CHECK (
    pending_last_page_fingerprint IS NULL OR
    (length(pending_last_page_fingerprint) = 64 AND
     pending_last_page_fingerprint NOT GLOB '*[^a-f0-9]*')
  );

ALTER TABLE sepay_api_reconciliation_cursors
  ADD COLUMN pending_last_page INTEGER
  CHECK (pending_last_page IS NULL OR pending_last_page >= 0);

ALTER TABLE sepay_api_reconciliation_cursors
  ADD COLUMN pending_total_records INTEGER
  CHECK (pending_total_records IS NULL OR pending_total_records >= 0);

ALTER TABLE custom_design_requests
  ADD COLUMN customer_reply_submission_token TEXT
  CHECK (
    customer_reply_submission_token IS NULL OR
    (length(customer_reply_submission_token) = 36 AND
     customer_reply_submission_token NOT GLOB '*[^0-9a-f-]*')
  );

CREATE TABLE custom_design_customer_replies (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES custom_design_requests(id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  reply_hash TEXT NOT NULL CHECK (
    length(reply_hash) = 64 AND reply_hash NOT GLOB '*[^a-f0-9]*'
  ),
  message TEXT NOT NULL CHECK (length(trim(message)) BETWEEN 1 AND 2000),
  from_status TEXT NOT NULL CHECK (from_status = 'CUSTOMER_ACTION_REQUIRED'),
  to_status TEXT NOT NULL CHECK (to_status = 'IN_REVIEW'),
  from_communication_status TEXT NOT NULL
    CHECK (from_communication_status = 'CUSTOMER_ACTION_REQUIRED'),
  to_communication_status TEXT NOT NULL CHECK (to_communication_status = 'RESPONDED'),
  created_at TEXT NOT NULL,
  UNIQUE (request_id, idempotency_key)
);

CREATE INDEX custom_design_customer_replies_timeline
  ON custom_design_customer_replies(request_id, created_at DESC, id DESC);

CREATE TRIGGER custom_design_customer_replies_owner
BEFORE INSERT ON custom_design_customer_replies
WHEN NOT EXISTS (
  SELECT 1 FROM custom_design_requests
  WHERE id = NEW.request_id AND customer_id = NEW.customer_id
)
BEGIN
  SELECT RAISE(ABORT, 'custom design customer reply owner mismatch');
END;

CREATE TRIGGER custom_design_customer_replies_immutable_update
BEFORE UPDATE ON custom_design_customer_replies
BEGIN
  SELECT RAISE(ABORT, 'custom design customer replies are immutable');
END;

CREATE TRIGGER custom_design_customer_replies_immutable_delete
BEFORE DELETE ON custom_design_customer_replies
BEGIN
  SELECT RAISE(ABORT, 'custom design customer replies are immutable');
END;

CREATE TABLE custom_design_requests (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (
    length(idempotency_key) BETWEEN 16 AND 128
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'
  ),
  preferred_template TEXT NOT NULL CHECK (
    preferred_template IN (
      'not_sure', 'custom', 'our-universe', 'love-letter',
      'our-memories', 'say-yes', 'distance-means-nothing'
    )
  ),
  brief TEXT NOT NULL CHECK (length(trim(brief)) BETWEEN 1 AND 5000),
  requirements TEXT NOT NULL CHECK (length(requirements) <= 5000),
  requested_delivery_date TEXT CHECK (
    requested_delivery_date IS NULL OR
    (length(requested_delivery_date) = 10 AND
     requested_delivery_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
  ),
  reference_urls_json TEXT NOT NULL CHECK (
    json_valid(reference_urls_json) AND json_type(reference_urls_json) = 'array'
  ),
  assets_rights_confirmed INTEGER NOT NULL CHECK (assets_rights_confirmed = 1),
  status TEXT NOT NULL CHECK (
    status IN ('QUOTE_PENDING', 'IN_REVIEW', 'CUSTOMER_ACTION_REQUIRED', 'QUOTED', 'CANCELLED')
  ),
  communication_status TEXT NOT NULL CHECK (
    communication_status IN ('AWAITING_REVIEW', 'CUSTOMER_ACTION_REQUIRED', 'RESPONDED')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (customer_id, idempotency_key)
);

CREATE INDEX custom_design_requests_customer_status
  ON custom_design_requests(customer_id, status, created_at DESC);

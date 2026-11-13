ALTER TABLE fulfillment_jobs RENAME TO fulfillment_jobs_legacy;

CREATE TABLE fulfillment_jobs (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  status TEXT NOT NULL CHECK (status IN (
    'PENDING','PROCESSING','FAILED','MANUAL_REVIEW','COMPLETED'
  )),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code TEXT,
  started_at TEXT,
  completed_at TEXT,
  next_attempt_at TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  last_failure_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO fulfillment_jobs (
  id, order_id, status, attempts, last_error_code, started_at, completed_at,
  created_at, updated_at
)
SELECT id, order_id, status, attempts, last_error_code, started_at, completed_at,
       created_at, updated_at
FROM fulfillment_jobs_legacy;

DROP TABLE fulfillment_jobs_legacy;

CREATE INDEX fulfillment_jobs_recovery
  ON fulfillment_jobs(status, next_attempt_at, lease_expires_at, created_at);

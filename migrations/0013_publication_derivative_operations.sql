CREATE TABLE publication_derivative_operations (
  id TEXT PRIMARY KEY,
  publication_asset_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  derivative_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (
    status IN ('CREATING','READY','CLEANUP_PENDING','CLEANED','MANUAL_REVIEW')
  ),
  operation_token TEXT NOT NULL UNIQUE,
  operation_lease_expires_at TEXT NOT NULL,
  cleanup_attempts INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_attempts >= 0),
  next_cleanup_at TEXT NOT NULL,
  cleanup_lease_token TEXT,
  cleanup_lease_expires_at TEXT,
  last_cleanup_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX publication_derivative_cleanup
  ON publication_derivative_operations(status, next_cleanup_at, id);
CREATE INDEX publication_derivative_asset
  ON publication_derivative_operations(publication_asset_id, status);
CREATE INDEX publication_derivative_publication
  ON publication_derivative_operations(publication_id, status, next_cleanup_at);

INSERT INTO publication_derivative_operations (
  id, publication_asset_id, derivative_key, publication_id, status, operation_token,
  operation_lease_expires_at, next_cleanup_at, created_at, updated_at
)
SELECT 'legacy-derivative-' || id, id, derivative_key,
       publication_id,
       CASE derivative_status
         WHEN 'READY' THEN 'READY'
         WHEN 'PENDING' THEN 'CREATING'
         ELSE 'CLEANUP_PENDING'
       END,
       'legacy-derivative-token-' || id,
       strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+15 minutes'),
       CASE WHEN derivative_status = 'CLEANUP_PENDING' THEN updated_at
         ELSE strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+1 hour') END,
       created_at, updated_at
FROM publication_assets
WHERE derivative_key IS NOT NULL;

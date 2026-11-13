ALTER TABLE asset_upload_sessions
  ADD COLUMN status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','UPLOADING','COMPLETE','CANCELLED'));

ALTER TABLE asset_upload_sessions
  ADD COLUMN lease_expires_at TEXT;

UPDATE asset_upload_sessions
SET status = 'COMPLETE'
WHERE used_at IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM assets
    WHERE assets.id = asset_upload_sessions.asset_id
      AND assets.status IN ('QUARANTINED','READY')
  );

CREATE INDEX upload_sessions_lifecycle
  ON asset_upload_sessions(status, lease_expires_at, asset_id);

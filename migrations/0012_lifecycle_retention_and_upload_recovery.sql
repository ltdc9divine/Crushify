ALTER TABLE asset_upload_attempts
  ADD COLUMN reconciliation_state TEXT NOT NULL DEFAULT 'ACTIVE'
  CHECK (reconciliation_state IN ('ACTIVE','MANUAL_REVIEW'));

UPDATE asset_upload_attempts
SET next_cleanup_at = strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at, '+1 hour')
WHERE status IN ('UPLOADING','ATTACHED');
INSERT OR IGNORE INTO asset_upload_attempts (
  id, session_id, asset_id, lease_token, object_key, status, lease_expires_at,
  next_cleanup_at, created_at, updated_at
)
SELECT 'legacy-pending-upload-' || session.id, session.id, asset.id,
       'legacy-pending-upload-' || session.id, asset.object_key, 'CLEANUP_PENDING',
       COALESCE(session.expires_at, session.created_at),
       strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(session.expires_at, session.created_at), '+1 hour'),
       session.created_at, session.created_at
FROM asset_upload_sessions session
JOIN assets asset ON asset.id = session.asset_id
WHERE session.status = 'PENDING' AND asset.status = 'PENDING'
  AND NOT EXISTS (
    SELECT 1 FROM asset_upload_attempts attempt WHERE attempt.session_id = session.id
  );
CREATE INDEX upload_attempts_reconciliation
  ON asset_upload_attempts(reconciliation_state, status, next_cleanup_at, id);

DROP TRIGGER referenced_asset_cannot_be_deleted;
CREATE TRIGGER referenced_asset_cannot_be_deleted
BEFORE UPDATE OF status ON assets
WHEN NEW.status IN ('DELETION_PENDING','DELETED')
 AND (
   EXISTS (SELECT 1 FROM design_asset_refs WHERE asset_id = OLD.id)
   OR EXISTS (
     SELECT 1 FROM order_asset_refs ref JOIN orders o ON o.id = ref.order_id
     WHERE ref.asset_id = OLD.id
       AND o.status IN ('DRAFT','AWAITING_PAYMENT','PAID','FULFILLING','REFUND_PENDING')
   )
   OR EXISTS (
     SELECT 1 FROM publication_assets ref JOIN publications p ON p.id = ref.publication_id
     WHERE ref.asset_id = OLD.id AND ref.revoked_at IS NULL
       AND (
         p.status IN ('PUBLISHED','UNPUBLISHED') OR
         (p.status IN ('EXPIRED','REVOKED')
           AND p.retention_delete_after_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       )
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'referenced asset cannot be deleted');
END;

DROP TRIGGER design_asset_refs_ready_insert;
CREATE TRIGGER design_asset_refs_ready_insert
BEFORE INSERT ON design_asset_refs
WHEN NOT EXISTS (
  SELECT 1 FROM assets a JOIN designs d ON d.id = a.design_id
  WHERE a.id = NEW.asset_id AND a.customer_id = NEW.customer_id
    AND a.design_id = NEW.design_id AND a.status = 'READY'
    AND d.customer_id = NEW.customer_id AND d.status = 'DRAFT'
)
BEGIN
  SELECT RAISE(ABORT, 'design asset reference requires a ready asset on an active draft');
END;

CREATE TRIGGER design_asset_refs_ready_update
BEFORE UPDATE OF design_id, asset_id, customer_id ON design_asset_refs
WHEN NOT EXISTS (
  SELECT 1 FROM assets a JOIN designs d ON d.id = a.design_id
  WHERE a.id = NEW.asset_id AND a.customer_id = NEW.customer_id
    AND a.design_id = NEW.design_id AND a.status = 'READY'
    AND d.customer_id = NEW.customer_id AND d.status = 'DRAFT'
)
BEGIN
  SELECT RAISE(ABORT, 'design asset reference requires a ready asset on an active draft');
END;

CREATE TRIGGER publication_assets_source_ready_insert
BEFORE INSERT ON publication_assets
WHEN NOT EXISTS (
  SELECT 1 FROM assets
  WHERE id = NEW.asset_id AND customer_id = NEW.customer_id AND status = 'READY'
)
BEGIN
  SELECT RAISE(ABORT, 'publication asset reference requires a ready owned asset');
END;

CREATE TRIGGER publication_assets_source_ready_update
BEFORE UPDATE OF asset_id, customer_id ON publication_assets
WHEN (NEW.asset_id <> OLD.asset_id OR NEW.customer_id <> OLD.customer_id)
 AND NOT EXISTS (
   SELECT 1 FROM assets
   WHERE id = NEW.asset_id AND customer_id = NEW.customer_id AND status = 'READY'
)
BEGIN
  SELECT RAISE(ABORT, 'publication asset reference requires a ready owned asset');
END;

CREATE TRIGGER publication_activation_requires_ready_assets
BEFORE UPDATE OF status, retention_delete_after_at ON publications
WHEN (
   NEW.status IN ('PUBLISHED','UNPUBLISHED') OR
   (NEW.status IN ('EXPIRED','REVOKED')
     AND NEW.retention_delete_after_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 )
 AND EXISTS (
   SELECT 1 FROM publication_assets ref
   JOIN assets a ON a.id = ref.asset_id
   WHERE ref.publication_id = NEW.id AND ref.revoked_at IS NULL
     AND a.status <> 'READY'
 )
BEGIN
  SELECT RAISE(ABORT, 'publication activation requires ready source assets');
END;

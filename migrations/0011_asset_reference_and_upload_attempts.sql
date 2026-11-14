ALTER TABLE asset_upload_sessions
  ADD COLUMN lease_token TEXT;

CREATE TABLE design_asset_refs (
  design_id TEXT NOT NULL REFERENCES designs(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (design_id, asset_id),
  FOREIGN KEY (design_id, revision) REFERENCES design_revisions(design_id, revision)
);
CREATE INDEX design_asset_refs_asset ON design_asset_refs(asset_id, design_id);

CREATE TABLE order_design_snapshots (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  design_id TEXT NOT NULL REFERENCES designs(id),
  design_revision INTEGER NOT NULL,
  template_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  content_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE order_asset_refs (
  order_id TEXT NOT NULL REFERENCES orders(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (order_id, asset_id)
);
CREATE INDEX order_asset_refs_asset ON order_asset_refs(asset_id, order_id);

CREATE TABLE asset_upload_attempts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES asset_upload_sessions(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  lease_token TEXT NOT NULL UNIQUE,
  object_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN (
    'UPLOADING','ATTACHED','CLEANUP_PENDING','CLEANED'
  )),
  lease_expires_at TEXT NOT NULL,
  cleanup_attempts INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_attempts >= 0),
  next_cleanup_at TEXT NOT NULL,
  cleanup_lease_token TEXT,
  cleanup_lease_expires_at TEXT,
  last_cleanup_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_verified_at TEXT
);
CREATE INDEX upload_attempts_cleanup
  ON asset_upload_attempts(status, next_cleanup_at, id);
CREATE INDEX upload_attempts_session
  ON asset_upload_attempts(session_id, status, lease_expires_at);

INSERT OR IGNORE INTO design_asset_refs (design_id, asset_id, customer_id, revision, created_at)
SELECT DISTINCT d.id, a.id, d.customer_id, d.revision, d.updated_at
FROM designs d
JOIN assets a ON a.design_id = d.id AND a.customer_id = d.customer_id
JOIN json_tree(d.data_json) ref ON ref.type = 'text' AND ref.value = a.id
WHERE ref.key IN ('asset_id','coverImage') AND a.status = 'READY';

INSERT OR IGNORE INTO order_design_snapshots (
  order_id, design_id, design_revision, template_id, schema_version,
  data_json, content_sha256, created_at
)
SELECT o.id, o.design_id, o.design_revision, d.template_id, d.schema_version,
       revision.data_json, '', o.created_at
FROM orders o
JOIN designs d ON d.id = o.design_id
JOIN design_revisions revision
  ON revision.design_id = o.design_id AND revision.revision = o.design_revision
WHERE o.order_type = 'SELF_SERVICE' AND o.design_revision IS NOT NULL;

INSERT OR IGNORE INTO order_asset_refs (order_id, asset_id, created_at)
SELECT DISTINCT snapshot.order_id, a.id, snapshot.created_at
FROM order_design_snapshots snapshot
JOIN assets a ON a.design_id = snapshot.design_id
JOIN json_tree(snapshot.data_json) ref ON ref.type = 'text' AND ref.value = a.id
WHERE ref.key IN ('asset_id','coverImage') AND a.status = 'READY';

INSERT OR IGNORE INTO asset_upload_attempts (
  id, session_id, asset_id, lease_token, object_key, status,
  lease_expires_at, next_cleanup_at, created_at, updated_at
)
SELECT 'legacy-upload-' || session.id, session.id, asset.id,
       'legacy-upload-' || session.id, asset.object_key,
       CASE WHEN session.status = 'COMPLETE' AND asset.status IN ('QUARANTINED','READY')
         THEN 'ATTACHED' ELSE 'CLEANUP_PENDING' END,
       COALESCE(session.lease_expires_at, session.created_at),
       COALESCE(session.lease_expires_at, session.created_at),
       session.created_at, session.created_at
FROM asset_upload_sessions session
JOIN assets asset ON asset.id = session.asset_id
WHERE session.status = 'COMPLETE' AND asset.status IN ('QUARANTINED','READY')
   OR session.status = 'UPLOADING';

UPDATE assets
SET status = 'DELETION_PENDING', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE status IN ('PENDING','QUARANTINED')
  AND id IN (
    SELECT asset_id FROM asset_upload_sessions WHERE status = 'UPLOADING'
  );

UPDATE asset_upload_sessions
SET status = 'CANCELLED', lease_expires_at = NULL, lease_token = NULL
WHERE status = 'UPLOADING';

UPDATE asset_upload_sessions
SET used_at = NULL, lease_expires_at = NULL, lease_token = NULL
WHERE status = 'PENDING' AND used_at IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM assets
    WHERE assets.id = asset_upload_sessions.asset_id AND assets.status = 'PENDING'
  );

CREATE TRIGGER design_asset_refs_ready_insert
BEFORE INSERT ON design_asset_refs
WHEN NOT EXISTS (
  SELECT 1 FROM assets
  WHERE id = NEW.asset_id AND customer_id = NEW.customer_id
    AND design_id = NEW.design_id AND status = 'READY'
)
BEGIN
  SELECT RAISE(ABORT, 'design asset reference requires a ready owned asset');
END;

CREATE TRIGGER order_asset_refs_ready_insert
BEFORE INSERT ON order_asset_refs
WHEN NOT EXISTS (
  SELECT 1
  FROM orders o JOIN assets a ON a.id = NEW.asset_id
  WHERE o.id = NEW.order_id AND o.design_id = a.design_id
    AND o.customer_id = a.customer_id AND a.status = 'READY'
)
BEGIN
  SELECT RAISE(ABORT, 'order asset reference requires a ready owned asset');
END;

CREATE TRIGGER order_design_snapshot_immutable_update
BEFORE UPDATE ON order_design_snapshots
BEGIN
  SELECT RAISE(ABORT, 'order design snapshots are immutable');
END;

CREATE TRIGGER order_design_snapshot_immutable_delete
BEFORE DELETE ON order_design_snapshots
BEGIN
  SELECT RAISE(ABORT, 'order design snapshots are immutable');
END;

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
       AND p.status IN ('PUBLISHED','UNPUBLISHED')
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'referenced asset cannot be deleted');
END;

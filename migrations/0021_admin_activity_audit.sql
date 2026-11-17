CREATE TABLE admin_activity_events (
  id TEXT PRIMARY KEY,
  actor_customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (
    action IN (
      'OPERATIONS_VIEWED',
      'CUSTOM_DESIGN_START_REVIEW',
      'CUSTOM_DESIGN_REQUEST_INFORMATION',
      'CUSTOM_DESIGN_REPLY',
      'FULFILLMENT_RECOVERY',
      'PUBLICATION_DERIVATIVE_RECONCILIATION'
    )
  ),
  outcome TEXT NOT NULL CHECK (outcome IN ('STARTED', 'COMPLETED', 'FAILED')),
  target_type TEXT NOT NULL CHECK (
    target_type IN (
      'ADMIN_OPERATIONS',
      'CUSTOM_DESIGN_REQUEST',
      'FULFILLMENT_JOBS',
      'PUBLICATION_DERIVATIVE_OPERATIONS'
    )
  ),
  target_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX admin_activity_events_timeline
  ON admin_activity_events(created_at DESC, id DESC);

CREATE TRIGGER admin_activity_events_immutable_update
BEFORE UPDATE ON admin_activity_events
BEGIN
  SELECT RAISE(ABORT, 'admin activity events are immutable');
END;

CREATE TRIGGER admin_activity_events_immutable_delete
BEFORE DELETE ON admin_activity_events
BEGIN
  SELECT RAISE(ABORT, 'admin activity events are immutable');
END;

ALTER TABLE custom_design_requests ADD COLUMN customer_message TEXT CHECK (
  customer_message IS NULL OR length(trim(customer_message)) BETWEEN 1 AND 2000
);
ALTER TABLE custom_design_requests ADD COLUMN customer_message_at TEXT;
ALTER TABLE custom_design_requests ADD COLUMN customer_message_by TEXT
  REFERENCES customers(id) ON DELETE RESTRICT;
ALTER TABLE custom_design_requests ADD COLUMN last_admin_event_id TEXT;

CREATE TABLE custom_design_request_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES custom_design_requests(id) ON DELETE RESTRICT,
  actor_customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (
    action IN ('start_review', 'request_information', 'reply')
  ),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  from_communication_status TEXT NOT NULL,
  to_communication_status TEXT NOT NULL,
  customer_message TEXT CHECK (
    customer_message IS NULL OR length(trim(customer_message)) BETWEEN 1 AND 2000
  ),
  created_at TEXT NOT NULL
);
CREATE INDEX custom_design_request_events_timeline
  ON custom_design_request_events(request_id, created_at DESC, id DESC);

CREATE TRIGGER custom_design_request_events_immutable_update
BEFORE UPDATE ON custom_design_request_events
BEGIN
  SELECT RAISE(ABORT, 'custom design review events are immutable');
END;

CREATE TRIGGER custom_design_request_events_immutable_delete
BEFORE DELETE ON custom_design_request_events
BEGIN
  SELECT RAISE(ABORT, 'custom design review events are immutable');
END;

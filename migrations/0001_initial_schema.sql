CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL UNIQUE,
  display_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED','DELETION_PENDING','DELETED')),
  email_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX customers_status_created ON customers(status, created_at);

CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','ACTIVE','RETIRED')),
  current_schema_version INTEGER NOT NULL CHECK (current_schema_version > 0),
  current_renderer_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX templates_status ON templates(status);

CREATE TABLE template_versions (
  template_id TEXT NOT NULL REFERENCES templates(id),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  renderer_version TEXT NOT NULL,
  default_data_json TEXT NOT NULL CHECK (json_valid(default_data_json)),
  editor_config_json TEXT NOT NULL CHECK (json_valid(editor_config_json)),
  validation_json TEXT NOT NULL CHECK (json_valid(validation_json)),
  compatibility_json TEXT NOT NULL CHECK (json_valid(compatibility_json)),
  status TEXT NOT NULL CHECK (status IN ('DRAFT','ACTIVE','RETIRED')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (template_id, schema_version)
);

CREATE TABLE designs (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  template_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('DRAFT','CHECKOUT_LOCKED','PUBLISHED','ARCHIVED','DELETION_PENDING')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  FOREIGN KEY (template_id, schema_version)
    REFERENCES template_versions(template_id, schema_version)
);
CREATE INDEX designs_customer_updated ON designs(customer_id, updated_at DESC);
CREATE INDEX designs_template_status ON designs(template_id, status);

CREATE TABLE design_revisions (
  design_id TEXT NOT NULL REFERENCES designs(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (design_id, revision)
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  design_id TEXT REFERENCES designs(id),
  object_key TEXT NOT NULL UNIQUE,
  rendition_key TEXT UNIQUE,
  visibility TEXT NOT NULL CHECK (visibility IN ('PRIVATE','PUBLISHED')),
  status TEXT NOT NULL CHECK (status IN ('PENDING','QUARANTINED','READY','REJECTED','DELETION_PENDING','DELETED')),
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX assets_owner_status ON assets(customer_id, status);
CREATE INDEX assets_design ON assets(design_id);

CREATE TABLE coupons (
  id TEXT PRIMARY KEY,
  code_normalized TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','ACTIVE','PAUSED','EXPIRED')),
  discount_type TEXT NOT NULL CHECK (discount_type IN ('PERCENT','FIXED')),
  discount_value INTEGER NOT NULL CHECK (discount_value > 0),
  currency TEXT,
  starts_at TEXT,
  ends_at TEXT,
  max_redemptions INTEGER CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  redeemed_count INTEGER NOT NULL DEFAULT 0 CHECK (redeemed_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE custom_projects (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  design_id TEXT REFERENCES designs(id),
  status TEXT NOT NULL CHECK (status IN ('INQUIRY','BRIEF_SUBMITTED','QUOTED','QUOTE_EXPIRED','DEPOSIT_PAID','IN_PROGRESS','PREVIEW_READY','REVISION_REQUESTED','APPROVED','BALANCE_DUE','DELIVERED','ON_HOLD','CANCELLED')),
  brief_json TEXT NOT NULL CHECK (json_valid(brief_json)),
  included_revision_rounds INTEGER NOT NULL DEFAULT 0 CHECK (included_revision_rounds >= 0),
  used_revision_rounds INTEGER NOT NULL DEFAULT 0 CHECK (used_revision_rounds >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX custom_projects_customer_created ON custom_projects(customer_id, created_at DESC);
CREATE INDEX custom_projects_status_updated ON custom_projects(status, updated_at);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  order_type TEXT NOT NULL CHECK (order_type IN ('SELF_SERVICE','CUSTOM_DEPOSIT','CUSTOM_BALANCE','CUSTOM_OTHER')),
  status TEXT NOT NULL CHECK (status IN ('DRAFT','AWAITING_PAYMENT','PAID','FULFILLING','FULFILLED','CANCELLED','REFUND_PENDING','REFUNDED','EXPIRED')),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  subtotal_minor INTEGER NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
  coupon_id TEXT REFERENCES coupons(id),
  design_id TEXT REFERENCES designs(id),
  custom_project_id TEXT REFERENCES custom_projects(id),
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paid_at TEXT,
  expires_at TEXT,
  UNIQUE (customer_id, idempotency_key),
  CHECK (total_minor = subtotal_minor - discount_minor)
);
CREATE INDEX orders_customer_created ON orders(customer_id, created_at DESC);
CREATE INDEX orders_status_created ON orders(status, created_at);
CREATE INDEX orders_project ON orders(custom_project_id);

CREATE TABLE order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  item_type TEXT NOT NULL CHECK (item_type IN ('TEMPLATE_LICENSE','CUSTOM_DEPOSIT','CUSTOM_BALANCE','ADD_ON')),
  reference_id TEXT NOT NULL,
  description_snapshot TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_amount_minor INTEGER NOT NULL CHECK (unit_amount_minor >= 0),
  line_total_minor INTEGER NOT NULL CHECK (line_total_minor >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  CHECK (line_total_minor = unit_amount_minor * quantity)
);
CREATE INDEX order_items_order ON order_items(order_id);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  provider TEXT NOT NULL,
  provider_payment_id TEXT,
  provider_checkout_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('CREATED','PENDING','SUCCEEDED','FAILED','CANCELLED','REFUND_PENDING','REFUNDED')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  succeeded_at TEXT,
  UNIQUE (provider, provider_payment_id)
);
CREATE INDEX payments_order_status ON payments(order_id, status);

CREATE TABLE custom_quotes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES custom_projects(id),
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('DRAFT','ISSUED','ACCEPTED','REJECTED','EXPIRED','SUPERSEDED')),
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  exclusions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(exclusions_json)),
  revision_rounds INTEGER NOT NULL CHECK (revision_rounds >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
  deposit_minor INTEGER NOT NULL CHECK (deposit_minor >= 0),
  balance_minor INTEGER NOT NULL CHECK (balance_minor >= 0),
  valid_until TEXT NOT NULL,
  issued_at TEXT,
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, version),
  CHECK (deposit_minor + balance_minor = total_minor)
);
CREATE INDEX quotes_project_status ON custom_quotes(project_id, status);

CREATE TABLE customer_sessions (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX customer_sessions_owner_expiry ON customer_sessions(customer_id, expires_at);

CREATE TABLE login_tokens (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX login_tokens_expiry ON login_tokens(expires_at);

CREATE TABLE payment_webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  outcome TEXT,
  UNIQUE (provider, event_id)
);

CREATE TABLE idempotency_records (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);
CREATE INDEX idempotency_expiry ON idempotency_records(expires_at);

CREATE TABLE custom_project_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES custom_projects(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('CUSTOMER','ADMIN','SYSTEM')),
  actor_id TEXT,
  request_id TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX project_events_timeline ON custom_project_events(project_id, created_at);

CREATE TABLE publications (
  id TEXT PRIMARY KEY,
  design_id TEXT NOT NULL REFERENCES designs(id),
  published_revision INTEGER NOT NULL CHECK (published_revision > 0),
  template_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  slug_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  published_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (template_id, schema_version)
    REFERENCES template_versions(template_id, schema_version)
);
CREATE INDEX publications_design_status ON publications(design_id, status);

CREATE TABLE coupon_redemptions (
  id TEXT PRIMARY KEY,
  coupon_id TEXT NOT NULL REFERENCES coupons(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  redeemed_at TEXT NOT NULL,
  UNIQUE (coupon_id, customer_id)
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('CUSTOMER','ADMIN','SYSTEM','PAYMENT_PROVIDER')),
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  request_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX audit_entity_time ON audit_logs(entity_type, entity_id, created_at);
CREATE INDEX audit_actor_time ON audit_logs(actor_type, actor_id, created_at);

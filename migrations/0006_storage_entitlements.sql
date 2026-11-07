CREATE TABLE storage_plans (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  duration_months INTEGER CHECK (duration_months IS NULL OR duration_months > 0),
  is_lifetime INTEGER NOT NULL CHECK (is_lifetime IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','RETIRED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((is_lifetime = 1 AND duration_months IS NULL) OR
         (is_lifetime = 0 AND duration_months IS NOT NULL))
);

INSERT INTO storage_plans (id, title, duration_months, is_lifetime, status, created_at, updated_at)
VALUES
  ('1-month', '1 tháng', 1, 0, 'ACTIVE', '2026-11-07T00:00:00.000Z', '2026-11-07T00:00:00.000Z'),
  ('3-months', '3 tháng', 3, 0, 'ACTIVE', '2026-11-07T00:00:00.000Z', '2026-11-07T00:00:00.000Z'),
  ('6-months', '6 tháng', 6, 0, 'ACTIVE', '2026-11-07T00:00:00.000Z', '2026-11-07T00:00:00.000Z'),
  ('12-months', '12 tháng', 12, 0, 'ACTIVE', '2026-11-07T00:00:00.000Z', '2026-11-07T00:00:00.000Z'),
  ('lifetime', 'Trọn đời', NULL, 1, 'ACTIVE', '2026-11-07T00:00:00.000Z', '2026-11-07T00:00:00.000Z');

CREATE TABLE storage_plan_prices (
  id TEXT PRIMARY KEY,
  storage_plan_id TEXT NOT NULL REFERENCES storage_plans(id),
  currency TEXT NOT NULL DEFAULT 'VND' CHECK (currency = 'VND'),
  amount_minor INTEGER CHECK (amount_minor IS NULL OR amount_minor > 0),
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (is_active = 0 OR amount_minor IS NOT NULL)
);
CREATE UNIQUE INDEX storage_plan_prices_one_active
  ON storage_plan_prices(storage_plan_id) WHERE is_active = 1;

ALTER TABLE publications ADD COLUMN activated_at TEXT;
ALTER TABLE publications ADD COLUMN original_expires_at TEXT;
ALTER TABLE publications ADD COLUMN expired_at TEXT;
ALTER TABLE publications ADD COLUMN retention_delete_after_at TEXT;
ALTER TABLE orders ADD COLUMN renewal_publication_id TEXT REFERENCES publications(id);
CREATE INDEX publications_retention
  ON publications(status, retention_delete_after_at);

CREATE TABLE storage_entitlements (
  id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES publications(id),
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  storage_plan_id TEXT NOT NULL REFERENCES storage_plans(id),
  duration_months INTEGER CHECK (duration_months IS NULL OR duration_months > 0),
  activated_at TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  previous_expires_at TEXT,
  expires_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','EXTENDED','EXPIRED','REVOKED','LIFETIME')),
  created_at TEXT NOT NULL,
  CHECK ((status = 'LIFETIME' AND expires_at IS NULL) OR status <> 'LIFETIME')
);
CREATE INDEX storage_entitlements_publication
  ON storage_entitlements(publication_id, created_at);

CREATE TABLE fulfillment_jobs (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  status TEXT NOT NULL CHECK (status IN ('PENDING','PROCESSING','FAILED','COMPLETED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX fulfillment_jobs_recovery
  ON fulfillment_jobs(status, updated_at);

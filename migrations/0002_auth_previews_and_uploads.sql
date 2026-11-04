CREATE TABLE preview_tokens (
  id TEXT PRIMARY KEY,
  design_id TEXT NOT NULL REFERENCES designs(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  design_revision INTEGER NOT NULL CHECK (design_revision > 0),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX preview_tokens_design_expiry ON preview_tokens(design_id, expires_at);

CREATE TABLE asset_upload_sessions (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX upload_sessions_asset_expiry ON asset_upload_sessions(asset_id, expires_at);

CREATE TABLE auth_rate_limits (
  key_hash TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0)
);

INSERT INTO templates (
  id, title, status, current_schema_version, current_renderer_version, created_at, updated_at
) VALUES (
  'our-universe', 'Our Universe', 'ACTIVE', 1, '1.0.0',
  '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z'
);

INSERT INTO template_versions (
  template_id, schema_version, renderer_version, default_data_json,
  editor_config_json, validation_json, compatibility_json, status, created_at
) VALUES (
  'our-universe', 1, '1.0.0',
  '{"sender":"Minh","receiver":"Linh","nickname":"Bé yêu","headline":"Một vũ trụ dành riêng cho hai ta","subheadline":"Hai tâm hồn. Một vũ trụ vô tận.","mainMessage":"Giữa thiên hà bao la, chúng mình đã tìm thấy nhau. Và trong vũ trụ này, mình sẽ bên nhau mãi mãi.","startDate":"2024-02-14","theme":"rose-nebula","animation":"cinematic","memories":[{"title":"Quỹ đạo đầu tiên","description":"Ngày hai con đường gặp nhau và mọi điều bắt đầu."},{"title":"Hành trình đôi mình","description":"Mỗi chuyến phiêu lưu, mỗi ngày bình thường hóa thành điều tuyệt vời."},{"title":"Đến vô cùng","description":"Dù ngày mai có điều gì, mình vẫn muốn cùng em trải nghiệm."}],"photos":[]}',
  '{"fields":["sender","receiver","nickname","headline","subheadline","mainMessage","startDate","theme","animation","memories","photos"]}',
  '{"max_json_bytes":65536,"max_photos":6,"max_memories":3}',
  '{"renderer":"templates/our-universe/index.html","preserve_extra_fields":false}',
  'ACTIVE', '2026-11-04T00:00:00.000Z'
);

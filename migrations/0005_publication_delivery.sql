ALTER TABLE publications RENAME TO publications_legacy;

CREATE TABLE publications (
  id TEXT PRIMARY KEY,
  design_id TEXT NOT NULL REFERENCES designs(id),
  order_id TEXT UNIQUE REFERENCES orders(id),
  published_revision INTEGER NOT NULL CHECK (published_revision > 0),
  template_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  renderer_version TEXT NOT NULL,
  slug TEXT UNIQUE,
  slug_hash TEXT NOT NULL UNIQUE,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  status TEXT NOT NULL CHECK (status IN ('PUBLISHED','UNPUBLISHED','EXPIRED','REVOKED')),
  lifecycle_revision INTEGER NOT NULL DEFAULT 1 CHECK (lifecycle_revision > 0),
  published_at TEXT,
  unpublished_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (template_id, schema_version)
    REFERENCES template_versions(template_id, schema_version)
);

INSERT INTO publications (
  id, design_id, order_id, published_revision, template_id, schema_version,
  renderer_version, slug, slug_hash, snapshot_json, status, published_at, revoked_at,
  created_at, updated_at
)
SELECT id, design_id, NULL, published_revision, template_id, schema_version,
       'unsupported', NULL, slug_hash, '{}', 'UNPUBLISHED', NULL, revoked_at,
       published_at, published_at
FROM publications_legacy
;

DROP TABLE publications_legacy;
CREATE INDEX publications_design_status ON publications(design_id, status);
CREATE UNIQUE INDEX publications_one_reissuable_per_design
  ON publications(design_id)
  WHERE status IN ('PUBLISHED','UNPUBLISHED','EXPIRED') AND renderer_version <> 'unsupported';
CREATE INDEX publications_expiry ON publications(status, expires_at);

CREATE TABLE publication_assets (
  id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES publications(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  consent_version TEXT NOT NULL,
  consented_at TEXT NOT NULL,
  revoked_at TEXT,
  derivative_key TEXT UNIQUE,
  derivative_status TEXT NOT NULL CHECK (
    derivative_status IN ('PENDING','READY','CLEANUP_PENDING','DELETED')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (publication_id, asset_id)
);
CREATE INDEX publication_assets_ready
  ON publication_assets(publication_id, derivative_status, revoked_at);

INSERT INTO templates (
  id, title, status, current_schema_version, current_renderer_version, created_at, updated_at
) VALUES
  ('love-letter', 'Love Letter', 'ACTIVE', 1, '1.0.0', '2026-11-07T00:00:00.000Z', '2026-11-07T00:00:00.000Z'),
  ('our-memories', 'Our Memories', 'ACTIVE', 1, '1.0.0', '2026-11-07T00:00:00.000Z', '2026-11-07T00:00:00.000Z'),
  ('say-yes', 'Say Yes!', 'ACTIVE', 1, '1.0.0', '2026-11-07T00:00:00.000Z', '2026-11-07T00:00:00.000Z'),
  ('distance-means-nothing', 'Distance Means Nothing', 'ACTIVE', 1, '1.0.0', '2026-11-07T00:00:00.000Z', '2026-11-07T00:00:00.000Z');

INSERT INTO template_versions (
  template_id, schema_version, renderer_version, default_data_json,
  editor_config_json, validation_json, compatibility_json, status, created_at
) VALUES
  ('love-letter', 1, '1.0.0',
   '{"from":"Anh","to":"Em","title":"Gửi người mình thương nhất…","msg":"Cảm ơn em vì đã ở đây, vì đã làm những ngày của anh rực rỡ hơn, và vì đã yêu anh theo cách của em. Dù thế giới có rộng lớn đến đâu, anh vẫn luôn chọn em.","secret":"Em là vũ trụ của anh ♥","theme":"rose","spd":"1"}',
   '{"fields":["from","to","title","msg","secret","theme","spd"]}', '{"max_json_bytes":49152}', '{"renderer":"templates/love-letter/index.html"}', 'ACTIVE', '2026-11-07T00:00:00.000Z'),
  ('our-memories', 1, '1.0.0',
   '{"templateId":"our-memories","sender":"Minh","receiver":"Linh","nickname":"Bé yêu","albumTitle":"Kỷ niệm đôi mình","subtitle":"Bởi mỗi khoảnh khắc bên em đều là một câu chuyện đẹp.","anniversary":"2024-02-14","theme":"rose-memories","animation":"cinematic","coverImage":"","introduction":"Cuốn album này lưu giữ những điều nhỏ bé mà anh không muốn quên.","story":"Mọi chuyện bắt đầu từ một tách cà phê, rồi lặng lẽ trở thành tất cả.","chapters":[{"id":"first-meet","title":"Lần đầu gặp gỡ","date":"2024-02-14","description":"Ngày mình gặp nhau.","photos":[]},{"id":"our-journey","title":"Hành trình đôi mình","date":"2025-01-01","description":"Hành trình đôi mình.","photos":[]},{"id":"to-infinity","title":"Đến vô cùng","date":"","description":"Mọi điều chúng mình vẫn muốn cùng nhau thực hiện.","photos":[]}],"closingMessage":"Mong có thêm thật nhiều kỷ niệm đẹp.","signature":"Minh","music":""}',
   '{"fields":["sender","receiver","nickname","albumTitle","subtitle","anniversary","theme","animation","coverImage","introduction","story","chapters","closingMessage","signature","music"]}', '{"max_json_bytes":49152,"max_photos":12}', '{"renderer":"templates/our-memories/index.html"}', 'ACTIVE', '2026-11-07T00:00:00.000Z'),
  ('say-yes', 1, '1.0.0',
   '{"templateId":"say-yes","sender":"Minh","receiver":"Linh","nickname":"Bé yêu","question":"Em sẽ đồng ý bên anh chứ?","subtitle":"Anh có điều này muốn hỏi em…","yesLabel":"EM ĐỒNG Ý ♡","noLabel":"EM XIN TỪ CHỐI","yesHeadline":"EM ĐÃ KHIẾN VŨ TRỤ CỦA ANH TRỌN VẸN.","yesMessage":"Cảm ơn em đã đồng ý. Mỗi ngày bên em đều là ngày tuyệt vời nhất.","letter":"Từ lần đầu gặp em, anh đã biết em thật đặc biệt.","signature":"Minh","specialDate":"2026-02-14","noMessage":"Cảm ơn em đã thành thật. Dù câu trả lời thế nào, anh vẫn mong em luôn hạnh phúc.","noBackLabel":"Quay lại","showNoMessage":true,"theme":"rose-proposal","animation":"cinematic","particles":true,"autoRotate":true,"music":"","photos":[]}',
   '{"fields":["sender","receiver","nickname","question","subtitle","yesLabel","noLabel","yesHeadline","yesMessage","letter","signature","specialDate","noMessage","noBackLabel","showNoMessage","theme","animation","particles","autoRotate","music","photos"]}', '{"max_json_bytes":49152,"max_photos":6}', '{"renderer":"templates/say-yes/index.html"}', 'ACTIVE', '2026-11-07T00:00:00.000Z'),
  ('distance-means-nothing', 1, '1.0.0',
   '{"templateId":"distance","sender":{"name":"","city":"","timezone":"","lat":null,"lon":null},"receiver":{"name":"","city":"","timezone":"","lat":null,"lon":null},"anniversary":"","nextMeeting":{"date":"","time":"","timezone":""},"headline":"Xa mặt không cách lòng","message":"","theme":"midnight-distance","animation":"cinematic","distance":{"mode":"coordinates","distanceKm":null},"messages":[],"memories":[]}',
   '{"fields":["sender","receiver","anniversary","nextMeeting","headline","message","theme","animation","distance","messages","memories"]}', '{"max_json_bytes":49152,"max_messages":12}', '{"renderer":"templates/distance-means-nothing/index.html"}', 'ACTIVE', '2026-11-07T00:00:00.000Z');

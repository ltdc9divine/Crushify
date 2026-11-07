INSERT INTO template_versions (
  template_id, schema_version, renderer_version, default_data_json,
  editor_config_json, validation_json, compatibility_json, status, created_at
) VALUES (
  'love-letter', 2, '1.0.0',
  '{"from":"Anh","to":"Em","title":"Gửi người mình thương nhất…","msg":"Cảm ơn em vì đã ở đây, vì đã làm những ngày của anh rực rỡ hơn, và vì đã yêu anh theo cách của em. Dù thế giới có rộng lớn đến đâu, anh vẫn luôn chọn em.","secret":"Em là vũ trụ của anh ♥","theme":"rose","spd":"1","photos":[]}',
  '{"fields":["from","to","title","msg","secret","theme","spd","photos"]}',
  '{"max_json_bytes":49152,"max_photos":4}',
  '{"renderer":"templates/love-letter/index.html","previous_schema_versions":[1]}',
  'ACTIVE', '2026-11-07T00:00:00.000Z'
);

UPDATE templates
SET current_schema_version = 2, updated_at = '2026-11-07T00:00:00.000Z'
WHERE id = 'love-letter' AND current_schema_version = 1;

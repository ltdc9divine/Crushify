ALTER TABLE publication_derivative_operations
  ADD COLUMN provider_create_succeeded_at TEXT;

UPDATE publication_derivative_operations
SET provider_create_succeeded_at = updated_at
WHERE status = 'READY';

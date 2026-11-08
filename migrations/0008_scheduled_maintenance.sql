CREATE TABLE scheduled_task_leases (
  task_name TEXT PRIMARY KEY,
  lease_token TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE scheduled_task_runs (
  id TEXT PRIMARY KEY,
  task_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  result_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(result_json)),
  error_code TEXT
);
CREATE INDEX scheduled_task_runs_task_started
  ON scheduled_task_runs(task_name, started_at DESC);

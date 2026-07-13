ALTER TABLE runs ADD COLUMN workflow_instance_id TEXT;
ALTER TABLE runs ADD COLUMN workflow_input_json TEXT;
ALTER TABLE runs ADD COLUMN current_step TEXT;
ALTER TABLE runs ADD COLUMN step_started_at TEXT;
ALTER TABLE runs ADD COLUMN last_heartbeat_at TEXT;
ALTER TABLE runs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  step TEXT,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE INDEX run_events_run_created_idx
  ON run_events(run_id, created_at DESC);

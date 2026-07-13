CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  interaction_token TEXT,
  thread_id TEXT,
  source_url TEXT,
  normalized_url_hash TEXT,
  draft_json TEXT,
  base_commit_sha TEXT,
  status TEXT NOT NULL,
  termination_reason TEXT,
  llm_calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  github_branch TEXT,
  github_pr_url TEXT,
  error_category TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX runs_user_created_idx ON runs(discord_user_id, created_at DESC);
CREATE INDEX runs_status_expiry_idx ON runs(status, expires_at);
CREATE UNIQUE INDEX runs_active_url_idx
  ON runs(normalized_url_hash)
  WHERE status IN ('RECEIVED', 'VALIDATING', 'ANALYZING', 'AWAITING_APPROVAL', 'CREATING_PR');

CREATE TABLE model_prices (
  model TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  input_per_million REAL NOT NULL,
  cached_input_per_million REAL NOT NULL,
  output_per_million REAL NOT NULL,
  PRIMARY KEY (model, effective_from)
);

INSERT INTO model_prices VALUES
  ('gpt-5-mini-2025-08-07', '2026-07-12T00:00:00.000Z', 0.25, 0.025, 2.00);

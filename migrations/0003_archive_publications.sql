CREATE TABLE archive_publications (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id),
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  draft_hash TEXT NOT NULL CHECK (length(draft_hash) > 0),
  draft_json TEXT CHECK (draft_json IS NULL OR json_valid(draft_json)),
  owner TEXT NOT NULL CHECK (length(owner) > 0),
  repo TEXT NOT NULL CHECK (length(repo) > 0),
  base_branch TEXT NOT NULL CHECK (length(base_branch) > 0),
  branch TEXT NOT NULL CHECK (branch = 'hanni/archive-' || run_id),
  prepared_json TEXT CHECK (prepared_json IS NULL OR json_valid(prepared_json)),
  commit_sha TEXT CHECK (commit_sha IS NULL OR length(commit_sha) > 0),
  pr_url TEXT CHECK (pr_url IS NULL OR length(pr_url) > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('requested', 'attempted', 'unknown', 'succeeded', 'failed')),
  error_category TEXT,
  updated_at TEXT NOT NULL,
  CHECK (outcome != 'succeeded' OR pr_url IS NOT NULL),
  CHECK (outcome != 'failed' OR pr_url IS NULL),
  CHECK (
    (outcome IN ('requested', 'attempted', 'unknown') AND draft_json IS NOT NULL)
    OR (outcome IN ('succeeded', 'failed') AND draft_json IS NULL AND prepared_json IS NULL)
  )
);

CREATE INDEX archive_publications_recovery_idx
  ON archive_publications(updated_at, run_id)
  WHERE outcome IN ('requested', 'attempted', 'unknown');

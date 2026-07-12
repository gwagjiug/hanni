export interface Env {
  DB: D1Database;
  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_GUILD_ID: string;
  DISCORD_CHANNEL_ID: string;
  DISCORD_OWNER_USER_ID: string;
  GITHUB_APP_ID: string;
  GITHUB_INSTALLATION_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
  ARCHIVE_OWNER: string;
  ARCHIVE_REPO: string;
  ARCHIVE_DEFAULT_BRANCH: string;
  APPROVAL_TTL_HOURS: string;
  MAX_RUN_COST_USD: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
}

export type RunStatus =
  | "RECEIVED"
  | "VALIDATING"
  | "ANALYZING"
  | "AWAITING_APPROVAL"
  | "CREATING_PR"
  | "COMPLETED"
  | "CANCELLED"
  | "EXPIRED"
  | "REJECTED_OUT_OF_SCOPE"
  | "REJECTED_PERMISSION"
  | "FAILED_EXTERNAL"
  | "FAILED_BUDGET";

export interface ArchivePreparation {
  category: {
    name: string;
    mode: "existing" | "new";
    rationale: string;
  };
  prTitle: string;
  prBody: string;
}

export interface ArchiveDraft extends ArchivePreparation {
  runId: string;
  title: string;
  url: string;
  pins: string[];
  slug: string;
  pinPath: string;
  readmeBefore: string;
  readmeAfter: string;
  pinContent: string;
  baseCommitSha: string;
  baseTreeSha: string;
  model: string;
  usage: TokenUsage;
  estimatedCostUsd: number;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface RunRow {
  id: string;
  discord_user_id: string;
  guild_id: string;
  channel_id: string;
  interaction_token: string | null;
  thread_id: string | null;
  source_url: string | null;
  normalized_url_hash: string | null;
  draft_json: string | null;
  base_commit_sha: string | null;
  status: RunStatus;
  termination_reason: string | null;
  llm_calls: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
  github_branch: string | null;
  github_pr_url: string | null;
  error_category: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface Env {
  DB: D1Database;
  ARCHIVE_WORKFLOW: Workflow<ArchiveWorkflowParams>;
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
}

export const RUN_STATUS = {
  RECEIVED: 'RECEIVED',
  VALIDATING: 'VALIDATING',
  ANALYZING: 'ANALYZING',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  CREATING_PR: 'CREATING_PR',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  REJECTED_OUT_OF_SCOPE: 'REJECTED_OUT_OF_SCOPE',
  REJECTED_PERMISSION: 'REJECTED_PERMISSION',
  FAILED_EXTERNAL: 'FAILED_EXTERNAL',
  FAILED_BUDGET: 'FAILED_BUDGET',
  FAILED_TIMEOUT: 'FAILED_TIMEOUT',
} as const;

export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS];

export interface ArchiveWorkflowParams {
  runId: string;
}

export interface ArchiveWorkflowInput {
  pins: string[];
  note?: string;
}

export interface ArchivePreparation {
  category: {
    name: string;
    mode: 'existing' | 'new';
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
  workflow_instance_id: string | null;
  workflow_input_json: string | null;
  current_step: string | null;
  step_started_at: string | null;
  last_heartbeat_at: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

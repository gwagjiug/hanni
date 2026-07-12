import { z } from 'zod';
import { RUN_STATUS } from '../types';

export const runStatusSchema = z.nativeEnum(RUN_STATUS);

export const runRowSchema = z.object({
  id: z.string(),
  discord_user_id: z.string(),
  guild_id: z.string(),
  channel_id: z.string(),
  interaction_token: z.string().nullable(),
  thread_id: z.string().nullable(),
  source_url: z.string().nullable(),
  normalized_url_hash: z.string().nullable(),
  draft_json: z.string().nullable(),
  base_commit_sha: z.string().nullable(),
  status: runStatusSchema,
  termination_reason: z.string().nullable(),
  llm_calls: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  cached_input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  estimated_cost_usd: z.number().nonnegative(),
  github_branch: z.string().nullable(),
  github_pr_url: z.string().nullable(),
  error_category: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  expires_at: z.string(),
});

export const costSummarySchema = z.object({
  run_count: z.number().int().nonnegative(),
  completed_count: z.number().int().nonnegative(),
  failed_count: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  estimated_cost_usd: z.number().nonnegative(),
  max_cost_usd: z.number().nonnegative(),
});

export type CostSummary = z.infer<typeof costSummarySchema>;

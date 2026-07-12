import { assertTransition } from '../agent/state';
import type { ArchiveDraft, RunRow, RunStatus } from '../types';
import { costSummarySchema, runRowSchema, type CostSummary } from './schema';

export class RunStore {
  constructor(private readonly db: D1Database) {}

  async create(input: {
    id: string;
    userId: string;
    guildId: string;
    channelId: string;
    interactionToken: string;
    sourceUrl: string;
    urlHash: string;
    ttlHours: number;
  }): Promise<void> {
    const now = new Date();
    const expires = new Date(now.getTime() + input.ttlHours * 3_600_000);
    await this.db
      .prepare(
        `INSERT INTO runs
         (id, discord_user_id, guild_id, channel_id, interaction_token, source_url, normalized_url_hash,
          status, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'RECEIVED', ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.userId,
        input.guildId,
        input.channelId,
        input.interactionToken,
        input.sourceUrl,
        input.urlHash,
        now.toISOString(),
        now.toISOString(),
        expires.toISOString(),
      )
      .run();
  }

  async get(id: string): Promise<RunRow | null> {
    const row = await this.db
      .prepare('SELECT * FROM runs WHERE id = ?')
      .bind(id)
      .first();
    return row ? runRowSchema.parse(row) : null;
  }

  async setInteractionToken(id: string, token: string): Promise<void> {
    await this.db
      .prepare(
        'UPDATE runs SET interaction_token = ?, updated_at = ? WHERE id = ?',
      )
      .bind(token, new Date().toISOString(), id)
      .run();
  }

  async transition(
    id: string,
    from: RunStatus,
    to: RunStatus,
    reason?: string,
  ): Promise<boolean> {
    assertTransition(from, to);
    const result = await this.db
      .prepare(
        'UPDATE runs SET status = ?, termination_reason = ?, updated_at = ? WHERE id = ? AND status = ?',
      )
      .bind(to, reason ?? null, new Date().toISOString(), id, from)
      .run();
    return result.meta.changes === 1;
  }

  async cancel(id: string, reason = 'user_cancelled'): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE runs SET status = 'CANCELLED', termination_reason = ?,
         interaction_token = NULL, source_url = NULL, draft_json = NULL, updated_at = ?
         WHERE id = ? AND status = 'AWAITING_APPROVAL'`,
      )
      .bind(reason, new Date().toISOString(), id)
      .run();
    return result.meta.changes === 1;
  }

  async saveDraft(
    id: string,
    draft: ArchiveDraft,
    threadId?: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE runs SET draft_json = ?, base_commit_sha = ?, thread_id = COALESCE(?, thread_id),
          llm_calls = 1, input_tokens = ?, cached_input_tokens = ?, output_tokens = ?,
          estimated_cost_usd = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(
        JSON.stringify(draft),
        draft.baseCommitSha,
        threadId ?? null,
        draft.usage.inputTokens,
        draft.usage.cachedInputTokens,
        draft.usage.outputTokens,
        draft.estimatedCostUsd,
        new Date().toISOString(),
        id,
      )
      .run();
  }

  async replaceDraft(id: string, draft: ArchiveDraft): Promise<void> {
    await this.db
      .prepare(
        "UPDATE runs SET draft_json = ?, updated_at = ? WHERE id = ? AND status = 'AWAITING_APPROVAL'",
      )
      .bind(JSON.stringify(draft), new Date().toISOString(), id)
      .run();
  }

  async complete(id: string, branch: string, prUrl: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE runs SET status = 'COMPLETED', github_branch = ?, github_pr_url = ?,
         interaction_token = NULL, source_url = NULL, draft_json = NULL, updated_at = ?
         WHERE id = ? AND status = 'CREATING_PR'`,
      )
      .bind(branch, prUrl, new Date().toISOString(), id)
      .run();
  }

  async fail(
    id: string,
    from: RunStatus,
    status: 'FAILED_EXTERNAL' | 'FAILED_BUDGET',
    category: string,
  ): Promise<void> {
    assertTransition(from, status);
    await this.db
      .prepare(
        `UPDATE runs SET status = ?, error_category = ?, termination_reason = ?,
         interaction_token = NULL, source_url = NULL, draft_json = NULL, updated_at = ?
         WHERE id = ? AND status = ?`,
      )
      .bind(status, category, category, new Date().toISOString(), id, from)
      .run();
  }

  async expireOldRuns(): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE runs SET status = 'EXPIRED', source_url = NULL, draft_json = NULL, interaction_token = NULL,
         termination_reason = 'approval_timeout', updated_at = ?
         WHERE status = 'AWAITING_APPROVAL' AND expires_at < ?`,
      )
      .bind(new Date().toISOString(), new Date().toISOString())
      .run();
    return result.meta.changes ?? 0;
  }

  async costSummary(userId: string): Promise<CostSummary> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) run_count,
          SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) completed_count,
          SUM(CASE WHEN status LIKE 'FAILED_%' THEN 1 ELSE 0 END) failed_count,
          COALESCE(SUM(input_tokens), 0) input_tokens,
          COALESCE(SUM(output_tokens), 0) output_tokens,
          COALESCE(SUM(estimated_cost_usd), 0) estimated_cost_usd,
          COALESCE(MAX(estimated_cost_usd), 0) max_cost_usd
         FROM runs WHERE discord_user_id = ? AND created_at >= datetime('now', 'start of month')`,
      )
      .bind(userId)
      .first();
    return costSummarySchema.parse(row);
  }

  async latestForUser(userId: string): Promise<RunRow | null> {
    const row = await this.db
      .prepare(
        'SELECT * FROM runs WHERE discord_user_id = ? ORDER BY created_at DESC LIMIT 1',
      )
      .bind(userId)
      .first();
    return row ? runRowSchema.parse(row) : null;
  }
}

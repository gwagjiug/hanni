import { assertTransition } from '../agent/state';
import type {
  ArchiveDraft,
  ArchiveWorkflowInput,
  RunRow,
  RunStatus,
} from '../types';
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
    workflowInput: ArchiveWorkflowInput;
    ttlHours: number;
  }): Promise<void> {
    const now = new Date();
    const expires = new Date(now.getTime() + input.ttlHours * 3_600_000);
    await this.db
      .prepare(
        `INSERT INTO runs
         (id, discord_user_id, guild_id, channel_id, interaction_token, source_url, normalized_url_hash,
          workflow_input_json, status, current_step, step_started_at, last_heartbeat_at,
          created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED', 'RECEIVED', ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.userId,
        input.guildId,
        input.channelId,
        input.interactionToken,
        input.sourceUrl,
        input.urlHash,
        JSON.stringify(input.workflowInput),
        now.toISOString(),
        now.toISOString(),
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

  async setWorkflowInstance(id: string, instanceId: string): Promise<void> {
    await this.db
      .prepare(
        'UPDATE runs SET workflow_instance_id = ?, updated_at = ? WHERE id = ?',
      )
      .bind(instanceId, new Date().toISOString(), id)
      .run();
  }

  async progress(
    id: string,
    step: string,
    detail: string,
    retryCount = 0,
  ): Promise<void> {
    const now = new Date().toISOString();
    const row = await this.get(id);
    if (!row) {
      return;
    }
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE runs SET current_step = ?, step_started_at = ?, last_heartbeat_at = ?,
           retry_count = ?, updated_at = ? WHERE id = ?`,
        )
        .bind(step, now, now, retryCount, now, id),
      this.db
        .prepare(
          `INSERT INTO run_events (run_id, event_type, step, status, detail, created_at)
           VALUES (?, 'STEP_STARTED', ?, ?, ?, ?)`,
        )
        .bind(id, step, row.status, detail.slice(0, 300), now),
    ]);
    console.log({
      event: 'hanni.step.started',
      runId: id,
      status: row.status,
      step,
      retryCount,
    });
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
        `UPDATE runs SET status = ?, termination_reason = ?, current_step = ?,
         step_started_at = ?, last_heartbeat_at = ?, updated_at = ?
         WHERE id = ? AND status = ?`,
      )
      .bind(
        to,
        reason ?? null,
        to,
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
        id,
        from,
      )
      .run();
    return result.meta.changes === 1;
  }

  async cancel(id: string, reason = 'user_cancelled'): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE runs SET status = 'CANCELLED', termination_reason = ?,
         interaction_token = NULL, source_url = NULL, draft_json = NULL, workflow_input_json = NULL,
         current_step = 'CANCELLED', updated_at = ?
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
    llmCalls = 1,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE runs SET draft_json = ?, workflow_input_json = NULL,
          base_commit_sha = ?, thread_id = COALESCE(?, thread_id),
          llm_calls = ?, input_tokens = ?, cached_input_tokens = ?, output_tokens = ?,
          estimated_cost_usd = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(
        JSON.stringify(draft),
        draft.baseCommitSha,
        threadId ?? null,
        llmCalls,
        draft.usage.inputTokens,
        draft.usage.cachedInputTokens,
        draft.usage.outputTokens,
        draft.estimatedCostUsd,
        new Date().toISOString(),
        id,
      )
      .run();
  }

  async recordUsage(
    id: string,
    usage: ArchiveDraft['usage'],
    llmCalls: number,
    estimatedCostUsd: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE runs SET llm_calls = ?, input_tokens = ?, cached_input_tokens = ?,
         output_tokens = ?, estimated_cost_usd = ?, last_heartbeat_at = ?, updated_at = ?
         WHERE id = ? AND status = 'ANALYZING'`,
      )
      .bind(
        llmCalls,
        usage.inputTokens,
        usage.cachedInputTokens,
        usage.outputTokens,
        estimatedCostUsd,
        new Date().toISOString(),
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
         interaction_token = NULL, source_url = NULL, draft_json = NULL, workflow_input_json = NULL,
         current_step = 'COMPLETED', updated_at = ?
         WHERE id = ? AND status = 'CREATING_PR'`,
      )
      .bind(branch, prUrl, new Date().toISOString(), id)
      .run();
  }

  async fail(
    id: string,
    from: RunStatus,
    status: 'FAILED_EXTERNAL' | 'FAILED_BUDGET' | 'FAILED_TIMEOUT',
    category: string,
  ): Promise<void> {
    assertTransition(from, status);
    await this.db
      .prepare(
        `UPDATE runs SET status = ?, error_category = ?, termination_reason = ?,
         interaction_token = NULL, source_url = NULL, draft_json = NULL, workflow_input_json = NULL,
         current_step = ?, updated_at = ?
         WHERE id = ? AND status = ?`,
      )
      .bind(
        status,
        category,
        category,
        status,
        new Date().toISOString(),
        id,
        from,
      )
      .run();
  }

  async expireOldRuns(): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE runs SET status = 'EXPIRED', source_url = NULL, draft_json = NULL,
         workflow_input_json = NULL, interaction_token = NULL, current_step = 'EXPIRED',
         termination_reason = 'approval_timeout', updated_at = ?
         WHERE status = 'AWAITING_APPROVAL' AND expires_at < ?`,
      )
      .bind(new Date().toISOString(), new Date().toISOString())
      .run();
    return result.meta.changes ?? 0;
  }

  async failStaleRuns(staleBefore: Date): Promise<RunRow[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM runs
         WHERE status IN ('VALIDATING', 'ANALYZING')
           AND COALESCE(last_heartbeat_at, updated_at) < ?`,
      )
      .bind(staleBefore.toISOString())
      .all();
    const stale = rows.results.map((row) => runRowSchema.parse(row));
    const failed: RunRow[] = [];
    for (const row of stale) {
      const result = await this.db
        .prepare(
          `UPDATE runs SET status = 'FAILED_TIMEOUT', error_category = 'workflow_stalled',
           termination_reason = 'workflow_stalled', workflow_input_json = NULL,
           source_url = NULL, draft_json = NULL, interaction_token = NULL,
           current_step = 'FAILED_TIMEOUT', updated_at = ?
           WHERE id = ? AND status = ?`,
        )
        .bind(new Date().toISOString(), row.id, row.status)
        .run();
      if (result.meta.changes === 1) {
        failed.push(row);
      }
    }
    return failed;
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

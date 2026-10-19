import { z } from 'zod';
import type { CreateArchiveCommitInput } from '../tools/github/client';

const activeOutcomes = "'requested', 'attempted', 'unknown'";

export const preparedCommitSchema = z.object({
  commitMessage: z.string().min(1),
  baseCommitSha: z.string().min(1),
  baseTreeSha: z.string().min(1),
  readme: z.string(),
  pinPath: z.string().min(1),
  pinContent: z.string(),
});

const publicationSchema = z.object({
  run_id: z.string(),
  approved_by: z.string(),
  approved_at: z.string().datetime(),
  draft_hash: z.string().min(1),
  draft_json: z.string().nullable(),
  owner: z.string().min(1),
  repo: z.string().min(1),
  base_branch: z.string().min(1),
  branch: z.string().min(1),
  prepared_json: z.string().nullable(),
  commit_sha: z.string().min(1).nullable(),
  pr_url: z.string().url().nullable(),
  outcome: z.enum(['requested', 'attempted', 'unknown', 'succeeded', 'failed']),
  error_category: z.string().nullable(),
  updated_at: z.string().datetime(),
});

export type Publication = z.infer<typeof publicationSchema>;

const stateSchema = publicationSchema.extend({
  run_status: z.string(),
  run_branch: z.string().nullable(),
  run_pr_url: z.string().nullable(),
});

type PublicationState = z.infer<typeof stateSchema>;

function parsePublication(value: unknown): Publication {
  const publication = publicationSchema.parse(value);
  if (publication.prepared_json !== null) {
    preparedCommitSchema.parse(JSON.parse(publication.prepared_json));
  }
  return publication;
}

function stateFromBatch(results: D1Result[]): PublicationState {
  const value = results.at(-1)?.results[0];
  if (!value) {
    throw new Error('publication_not_found');
  }
  const state = stateSchema.parse(value);
  parsePublication(state);
  return state;
}

function isActive(state: PublicationState): boolean {
  return (
    state.run_status === 'CREATING_PR' &&
    state.outcome !== 'succeeded' &&
    state.outcome !== 'failed'
  );
}

export class PublicationStore {
  constructor(private readonly db: D1Database) {}

  async approve(input: {
    runId: string;
    userId: string;
    draftJson: string;
    draftHash: string;
    target: { owner: string; repo: string; baseBranch: string };
  }): Promise<Publication | null> {
    const now = new Date().toISOString();
    // D1 batch is a transaction. The second statement can only claim the run
    // when this transaction inserted the exact owner/draft/expiry CAS intent.
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO archive_publications
           (run_id, approved_by, approved_at, draft_hash, draft_json,
            owner, repo, base_branch, branch, outcome, updated_at)
           SELECT id, ?, ?, ?, draft_json, ?, ?, ?, ?, 'requested', ?
           FROM runs
           WHERE id = ? AND discord_user_id = ? AND status = 'AWAITING_APPROVAL'
             AND draft_json = ? AND julianday(expires_at) > julianday(?)
           ON CONFLICT(run_id) DO NOTHING`,
        )
        .bind(
          input.userId,
          now,
          input.draftHash,
          input.target.owner,
          input.target.repo,
          input.target.baseBranch,
          `hanni/archive-${input.runId}`,
          now,
          input.runId,
          input.userId,
          input.draftJson,
          now,
        ),
      this.db
        .prepare(
          `UPDATE runs SET status = 'CREATING_PR', current_step = 'CREATING_PR',
             step_started_at = ?, last_heartbeat_at = ?, updated_at = ?
           WHERE changes() = 1 AND id = ? AND discord_user_id = ?
             AND status = 'AWAITING_APPROVAL' AND draft_json = ?
             AND julianday(expires_at) > julianday(?)`,
        )
        .bind(now, now, now, input.runId, input.userId, input.draftJson, now),
      this.db
        .prepare(
          `SELECT p.* FROM archive_publications p JOIN runs r ON r.id = p.run_id
           WHERE p.run_id = ? AND p.approved_by = ? AND r.discord_user_id = ?`,
        )
        .bind(input.runId, input.userId, input.userId),
    ]);
    const row = results.at(-1)?.results[0];
    return row ? parsePublication(row) : null;
  }

  async get(runId: string): Promise<Publication | null> {
    const row = await this.db
      .prepare('SELECT * FROM archive_publications WHERE run_id = ?')
      .bind(runId)
      .first();
    return row ? parsePublication(row) : null;
  }

  async listRecoverable(limit = 20): Promise<Publication[]> {
    const boundedLimit = z.number().int().min(1).max(100).parse(limit);
    const result = await this.db
      .prepare(
        `SELECT p.* FROM archive_publications p JOIN runs r ON r.id = p.run_id
         WHERE p.outcome IN (${activeOutcomes}) AND r.status = 'CREATING_PR'
         ORDER BY p.updated_at, p.run_id LIMIT ?`,
      )
      .bind(boundedLimit)
      .all();
    return result.results.map(parsePublication);
  }

  async touchDispatch(runId: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE archive_publications SET updated_at = ?
         WHERE run_id = ? AND outcome IN (${activeOutcomes})
           AND EXISTS (SELECT 1 FROM runs WHERE id = run_id AND status = 'CREATING_PR')`,
      )
      .bind(new Date().toISOString(), runId)
      .run();
  }

  async savePrepared(
    runId: string,
    input: CreateArchiveCommitInput,
  ): Promise<CreateArchiveCommitInput> {
    const prepared = preparedCommitSchema.parse(input);
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE archive_publications
           SET prepared_json = ?, updated_at = ?
           WHERE run_id = ? AND prepared_json IS NULL AND outcome IN (${activeOutcomes})
             AND EXISTS (SELECT 1 FROM runs WHERE id = run_id AND status = 'CREATING_PR')`,
        )
        .bind(JSON.stringify(prepared), new Date().toISOString(), runId),
      this.stateStatement(runId),
    ]);
    const state = stateFromBatch(results);
    if (!isActive(state) || state.prepared_json === null) {
      throw new Error('publication_state_conflict');
    }
    return preparedCommitSchema.parse(JSON.parse(state.prepared_json));
  }

  async saveCommit(runId: string, commitSha: string): Promise<string> {
    z.string().min(1).parse(commitSha);
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE archive_publications SET commit_sha = ?, updated_at = ?
           WHERE run_id = ? AND commit_sha IS NULL AND outcome IN (${activeOutcomes})
             AND EXISTS (SELECT 1 FROM runs WHERE id = run_id AND status = 'CREATING_PR')`,
        )
        .bind(commitSha, new Date().toISOString(), runId),
      this.stateStatement(runId),
    ]);
    const state = stateFromBatch(results);
    if (state.commit_sha !== commitSha) {
      throw new Error('publication_commit_conflict');
    }
    return state.commit_sha;
  }

  async recordAttempt(runId: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE archive_publications
         SET outcome = CASE WHEN outcome = 'requested' THEN 'attempted' ELSE outcome END,
             updated_at = ?
         WHERE run_id = ? AND outcome IN (${activeOutcomes})
           AND EXISTS (SELECT 1 FROM runs WHERE id = run_id AND status = 'CREATING_PR')`,
      )
      .bind(new Date().toISOString(), runId)
      .run();
  }

  async recordPullRequest(runId: string, prUrl: string): Promise<void> {
    z.string().url().parse(prUrl);
    const now = new Date().toISOString();
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE archive_publications SET pr_url = ?, updated_at = ?
           WHERE run_id = ? AND outcome IN (${activeOutcomes})
             AND (pr_url IS NULL OR pr_url = ?)
             AND EXISTS (
               SELECT 1 FROM runs r WHERE r.id = run_id AND r.status = 'CREATING_PR'
                 AND (r.github_branch IS NULL OR r.github_branch = branch)
                 AND (r.github_pr_url IS NULL OR r.github_pr_url = ?)
             )`,
        )
        .bind(prUrl, now, runId, prUrl, prUrl),
      this.db
        .prepare(
          `UPDATE runs
           SET github_branch = (SELECT branch FROM archive_publications WHERE run_id = ?),
               github_pr_url = ?, updated_at = ?
           WHERE changes() = 1 AND id = ? AND status = 'CREATING_PR'`,
        )
        .bind(runId, prUrl, now, runId),
      this.stateStatement(runId),
    ]);
    const state = stateFromBatch(results);
    if (
      state.pr_url !== prUrl ||
      state.run_pr_url !== prUrl ||
      state.run_branch !== state.branch ||
      (!isActive(state) &&
        !(state.outcome === 'succeeded' && state.run_status === 'COMPLETED'))
    ) {
      throw new Error('publication_pr_conflict');
    }
  }

  async markUnknown(runId: string, category: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE archive_publications SET outcome = 'unknown', error_category = ?, updated_at = ?
           WHERE run_id = ? AND outcome IN (${activeOutcomes})
             AND EXISTS (SELECT 1 FROM runs WHERE id = run_id AND status = 'CREATING_PR')`,
        )
        .bind(category, now, runId),
      this.db
        .prepare(
          `UPDATE runs SET current_step = 'PUBLICATION_RECOVERY', error_category = ?,
             last_heartbeat_at = ?, updated_at = ?
           WHERE changes() = 1 AND id = ? AND status = 'CREATING_PR'`,
        )
        .bind(category, now, now, runId),
    ]);
  }

  async fail(runId: string, category: string): Promise<void> {
    const now = new Date().toISOString();
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE runs SET status = 'FAILED_EXTERNAL', error_category = ?, termination_reason = ?,
             interaction_token = NULL, source_url = NULL, draft_json = NULL, workflow_input_json = NULL,
             current_step = 'FAILED_EXTERNAL', step_started_at = ?, last_heartbeat_at = ?, updated_at = ?
           WHERE id = ? AND status = 'CREATING_PR' AND github_pr_url IS NULL
             AND EXISTS (
               SELECT 1 FROM archive_publications p WHERE p.run_id = runs.id
                 AND p.outcome IN (${activeOutcomes}) AND p.pr_url IS NULL
             )`,
        )
        .bind(category, category, now, now, now, runId),
      this.db
        .prepare(
          `UPDATE archive_publications
           SET outcome = 'failed', error_category = ?, draft_json = NULL, prepared_json = NULL, updated_at = ?
           WHERE changes() = 1 AND run_id = ? AND outcome IN (${activeOutcomes}) AND pr_url IS NULL`,
        )
        .bind(category, now, runId),
      this.stateStatement(runId),
    ]);
    const state = stateFromBatch(results);
    if (state.outcome === 'succeeded' || state.outcome === 'failed') {
      return;
    }
    if (state.pr_url !== null || state.run_pr_url !== null) {
      throw new Error('publication_pr_already_observed');
    }
    throw new Error('publication_state_conflict');
  }

  async complete(runId: string): Promise<void> {
    const now = new Date().toISOString();
    // Write the run and clean the publication in one D1 transaction. A failure
    // in either statement rolls back both; observed PR evidence is never cleared.
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE runs
           SET status = 'COMPLETED',
               github_branch = (SELECT branch FROM archive_publications WHERE run_id = ?),
               github_pr_url = (SELECT pr_url FROM archive_publications WHERE run_id = ?),
               interaction_token = NULL, source_url = NULL, draft_json = NULL, workflow_input_json = NULL,
               error_category = NULL, termination_reason = NULL,
               current_step = 'COMPLETED', step_started_at = ?, last_heartbeat_at = ?, updated_at = ?
           WHERE id = ? AND status = 'CREATING_PR'
             AND EXISTS (
               SELECT 1 FROM archive_publications p WHERE p.run_id = runs.id
                 AND p.outcome IN (${activeOutcomes}) AND p.pr_url IS NOT NULL
                 AND (runs.github_branch IS NULL OR runs.github_branch = p.branch)
                 AND (runs.github_pr_url IS NULL OR runs.github_pr_url = p.pr_url)
             )`,
        )
        .bind(runId, runId, now, now, now, runId),
      this.db
        .prepare(
          `UPDATE archive_publications
           SET outcome = 'succeeded', error_category = NULL,
               draft_json = NULL, prepared_json = NULL, updated_at = ?
           WHERE changes() = 1 AND run_id = ? AND outcome IN (${activeOutcomes}) AND pr_url IS NOT NULL`,
        )
        .bind(now, runId),
      this.stateStatement(runId),
    ]);
    const state = stateFromBatch(results);
    if (
      state.outcome !== 'succeeded' ||
      state.run_status !== 'COMPLETED' ||
      state.pr_url === null ||
      state.run_pr_url !== state.pr_url ||
      state.run_branch !== state.branch
    ) {
      throw new Error('publication_completion_conflict');
    }
  }

  private stateStatement(runId: string): D1PreparedStatement {
    return this.db
      .prepare(
        `SELECT p.*, r.status AS run_status, r.github_branch AS run_branch,
                r.github_pr_url AS run_pr_url
         FROM archive_publications p JOIN runs r ON r.id = p.run_id WHERE p.run_id = ?`,
      )
      .bind(runId);
  }
}

import type { Env } from '../../types';
import { createArchiveWorkflowDependencies } from './dependencies';
import { errorCategory, isBudgetFailure } from './errors';
import {
  archiveEntry,
  hasUrl,
  insertReadmeEntry,
  renderPinFile,
} from './render';
import { parseArchiveDraft } from './schema';

export async function approveDraft(
  env: Env,
  runId: string,
  userId: string,
  dependencies = createArchiveWorkflowDependencies(env, runId),
): Promise<{ branch: string; prUrl: string }> {
  const { store, github, circuit, tracer } = dependencies;
  const row = await store.get(runId);
  if (!row || row.discord_user_id !== userId) {
    throw new Error('approval_forbidden');
  }
  if (Date.parse(row.expires_at) < Date.now()) {
    if (row.status === 'AWAITING_APPROVAL') {
      await store.transition(
        runId,
        'AWAITING_APPROVAL',
        'EXPIRED',
        'approval_timeout',
      );
    }
    throw new Error('approval_expired');
  }
  if (!row.draft_json) {
    throw new Error('draft_missing');
  }
  if (!(await store.transition(runId, 'AWAITING_APPROVAL', 'CREATING_PR'))) {
    throw new Error('approval_already_processed');
  }

  try {
    const draft = parseArchiveDraft(row.draft_json);
    circuit.tool('github.revalidate', runId);
    const latest = await tracer.span(
      'github.revalidate',
      { 'tool.read_write': 'read', 'ax.dimension': 'agent_behavior' },
      () => github.readArchive(),
    );
    if (hasUrl(latest.readme, draft.url)) {
      throw new Error('archive_duplicate_url');
    }
    if (latest.files.has(draft.pinPath)) {
      throw new Error('archive_slug_collision_after_approval');
    }

    const readme = insertReadmeEntry(
      latest.readme,
      draft.category.name,
      archiveEntry(draft.title, draft.url, draft.slug),
    );
    const pinContent = renderPinFile(draft.title, draft.url, draft.pins);
    circuit.tool('github.create_archive_draft_pr', runId);
    const result = await tracer.span(
      'github.create_archive_draft_pr',
      { 'tool.read_write': 'write', 'ax.dimension': 'goal_achievement' },
      () =>
        github.createDraftPr({
          runId,
          title: draft.prTitle,
          body: draft.prBody,
          commitMessage: `archive: add ${draft.title}`,
          baseCommitSha: latest.baseCommitSha,
          baseTreeSha: latest.baseTreeSha,
          readme,
          pinPath: draft.pinPath,
          pinContent,
        }),
    );
    await store.complete(runId, result.branch, result.prUrl);
    return result;
  } catch (error) {
    const category = errorCategory(error);
    await store.fail(
      runId,
      'CREATING_PR',
      isBudgetFailure(category) ? 'FAILED_BUDGET' : 'FAILED_EXTERNAL',
      category,
    );
    throw error;
  }
}

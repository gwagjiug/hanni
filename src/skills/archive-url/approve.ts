import { PublicationStore, type Publication } from '../../storage/publications';
import { RunStore } from '../../storage/runs';
import type { Env } from '../../types';
import { parseArchiveDraft } from './schema';

export async function approvedDraftHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export async function approveDraft(
  env: Env,
  runId: string,
  userId: string,
  dependencies = {
    runs: new RunStore(env.DB),
    publications: new PublicationStore(env.DB),
  },
): Promise<Publication> {
  const { runs, publications } = dependencies;
  const row = await runs.get(runId);
  if (!row || row.discord_user_id !== userId) {
    throw new Error('approval_forbidden');
  }
  const existing = await publications.get(runId);
  if (existing) {
    if (existing.approved_by !== userId) {
      throw new Error('approval_forbidden');
    }
    return existing;
  }
  if (row.status !== 'AWAITING_APPROVAL') {
    throw new Error('approval_already_processed');
  }
  if (Date.parse(row.expires_at) < Date.now()) {
    await runs.transition(
      runId,
      'AWAITING_APPROVAL',
      'EXPIRED',
      'approval_timeout',
    );
    throw new Error('approval_expired');
  }
  if (!row.draft_json) {
    throw new Error('draft_missing');
  }
  const draft = parseArchiveDraft(row.draft_json);
  if (draft.runId !== runId) {
    throw new Error('approval_draft_mismatch');
  }
  const publication = await publications.approve({
    runId,
    userId,
    draftJson: row.draft_json,
    draftHash: await approvedDraftHash(row.draft_json),
    target: {
      owner: env.ARCHIVE_OWNER,
      repo: env.ARCHIVE_REPO,
      baseBranch: env.ARCHIVE_DEFAULT_BRANCH,
    },
  });
  if (!publication) {
    throw new Error('approval_changed_or_expired');
  }
  return publication;
}

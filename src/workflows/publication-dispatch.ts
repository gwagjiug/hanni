import { errorCategory } from '../skills/archive-url/errors';
import { PublicationStore } from '../storage/publications';
import type { Env } from '../types';

export async function dispatchArchivePublication(
  env: Env,
  runId: string,
): Promise<void> {
  const publications = new PublicationStore(env.DB);
  const publication = await publications.get(runId);
  if (!publication) {
    throw new Error('publication_missing');
  }
  if (publication.outcome === 'succeeded' || publication.outcome === 'failed') {
    return;
  }
  // Create may return an existing instance or lose its acknowledgement.
  // Always observe its state instead of assuming that it was scheduled.
  await env.ARCHIVE_PUBLICATION_WORKFLOW.create({
    id: runId,
    params: { runId },
  }).catch(() => undefined);
  const instance = await env.ARCHIVE_PUBLICATION_WORKFLOW.get(runId);
  const { status } = await instance.status();
  if (status === 'errored' || status === 'complete') {
    const current = await publications.get(runId);
    if (
      current &&
      current.outcome !== 'succeeded' &&
      current.outcome !== 'failed'
    ) {
      // D1 checkpoints survive a full Workflow restart, including completion loss.
      await instance.restart();
    }
  } else if (status === 'terminated') {
    // Respect an operator stop; an explicit restart can reuse the checkpoints.
    throw new Error('publication_workflow_terminated');
  } else if (status === 'unknown') {
    throw new Error('publication_workflow_unknown');
  }
  // Rotate active/paused instances behind other intents in the bounded scan.
  await publications.touchDispatch(runId);
}

export async function recoverArchivePublications(env: Env): Promise<void> {
  const publications = new PublicationStore(env.DB);
  for (const publication of await publications.listRecoverable()) {
    try {
      await dispatchArchivePublication(env, publication.run_id);
    } catch (error) {
      const category = errorCategory(error);
      await publications.markUnknown(publication.run_id, category);
      console.warn({
        event: 'hanni.publication.dispatch_failed',
        runId: publication.run_id,
        errorCategory: category,
      });
    }
  }
}

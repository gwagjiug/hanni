import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import {
  publishApprovedArchive,
  type ArchivePublicationResult,
} from '../skills/archive-url/publish';
import type { ArchiveWorkflowParams, Env } from '../types';

export class ArchivePublicationWorkflow extends WorkflowEntrypoint<
  Env,
  ArchiveWorkflowParams
> {
  async run(
    event: Readonly<WorkflowEvent<ArchiveWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<ArchivePublicationResult> {
    return publishApprovedArchive(this.env, event.payload.runId, step);
  }
}

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import { estimateCost } from '../agent/budget';
import { normalizePublicUrl } from '../policies/scope';
import { createArchiveDraft } from '../skills/archive-url/draft';
import {
  errorCategory,
  isBudgetFailure,
  userFacingError,
} from '../skills/archive-url/errors';
import { extractCategories, hasUrl } from '../skills/archive-url/render';
import { parseArchiveWorkflowInput } from '../skills/archive-url/schema';
import { RunStore } from '../storage/runs';
import { DiscordClient, previewPayload } from '../tools/discord';
import { GitHubClient, type ArchiveSnapshot } from '../tools/github/client';
import { prepareArchiveEntry } from '../tools/openai';
import { fetchMetadata } from '../tools/web/metadata';
import type { ArchiveWorkflowParams, Env } from '../types';

const externalRead = {
  retries: { limit: 1, delay: '2 seconds', backoff: 'exponential' },
  timeout: '30 seconds',
  sensitive: 'output',
} as const;

const sensitiveStep = {
  retries: { limit: 1, delay: '1 second', backoff: 'constant' },
  timeout: '15 seconds',
  sensitive: 'output',
} as const;

async function reportProgress(
  env: Env,
  runId: string,
  stepName: string,
  message: string,
  retryCount = 0,
): Promise<void> {
  const store = new RunStore(env.DB);
  await store.progress(runId, stepName, message, retryCount);
  const row = await store.get(runId);
  if (!row?.interaction_token) {
    return;
  }
  await new DiscordClient(env)
    .editOriginal(row.interaction_token, {
      content: `⏳ ${message}\n\n실행 ID: \`${runId}\``,
      allowed_mentions: { parse: [] },
    })
    .catch((error: unknown) => {
      console.warn({
        event: 'hanni.progress.discord_failed',
        runId,
        step: stepName,
        errorCategory: errorCategory(error),
      });
    });
}

export class ArchiveAnalysisWorkflow extends WorkflowEntrypoint<
  Env,
  ArchiveWorkflowParams
> {
  async run(
    event: Readonly<WorkflowEvent<ArchiveWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<{ runId: string; status: string }> {
    const { runId } = event.payload;
    const store = new RunStore(this.env.DB);
    try {
      const initial = await step.do(
        'validate archive request',
        sensitiveStep,
        async (context) => {
          await reportProgress(
            this.env,
            runId,
            'VALIDATING_INPUT',
            'URL과 Pin을 확인하고 있어요.',
            context.attempt - 1,
          );
          const row = await store.get(runId);
          if (
            !row?.source_url ||
            !row.interaction_token ||
            !row.workflow_input_json
          ) {
            throw new Error('workflow_input_missing');
          }
          if (row.status === 'RECEIVED') {
            await store.transition(runId, 'RECEIVED', 'VALIDATING');
          }
          const normalizedUrl = normalizePublicUrl(row.source_url);
          const input = parseArchiveWorkflowInput(row.workflow_input_json);
          await store.transition(runId, 'VALIDATING', 'ANALYZING');
          return {
            normalizedUrl,
            interactionToken: row.interaction_token,
            pins: input.pins,
            note: input.note ?? '',
          };
        },
      );

      const archiveData = await step.do(
        'read archive repository',
        externalRead,
        async (context) => {
          await reportProgress(
            this.env,
            runId,
            'READING_ARCHIVE',
            'archive 저장소를 확인하고 있어요.',
            context.attempt - 1,
          );
          const archive = await new GitHubClient(this.env).readArchive();
          if (hasUrl(archive.readme, initial.normalizedUrl)) {
            throw new Error('archive_duplicate_url');
          }
          return {
            readme: archive.readme,
            baseCommitSha: archive.baseCommitSha,
            baseTreeSha: archive.baseTreeSha,
            files: [...archive.files],
          };
        },
      );
      const archive: ArchiveSnapshot = {
        ...archiveData,
        files: new Set(archiveData.files),
      };

      const document = await step.do(
        'fetch document metadata',
        externalRead,
        async (context) => {
          await reportProgress(
            this.env,
            runId,
            'FETCHING_METADATA',
            '문서 제목과 canonical URL을 확인하고 있어요.',
            context.attempt - 1,
          );
          const metadata = await fetchMetadata(initial.normalizedUrl);
          const title = metadata.title;
          if (!title) {
            throw new Error('metadata_title_missing');
          }
          return { title, canonicalUrl: metadata.canonicalUrl };
        },
      );

      const llm = await step.do(
        'classify archive entry',
        { timeout: '2 minutes', sensitive: 'output' },
        async (context) => {
          await reportProgress(
            this.env,
            runId,
            'CLASSIFYING_ENTRY',
            '카테고리와 PR 설명을 준비하고 있어요.',
            context.attempt - 1,
          );
          return prepareArchiveEntry({
            apiKey: this.env.OPENAI_API_KEY,
            model: this.env.OPENAI_MODEL,
            title: document.title,
            hostname: new URL(document.canonicalUrl).hostname,
            categories: extractCategories(archive.readme),
            pins: initial.pins,
            ...(initial.note ? { note: initial.note } : {}),
          });
        },
      );
      const cost = estimateCost(llm.usage);
      await step.do('record model usage', async () => {
        await store.recordUsage(runId, llm.usage, llm.calls, cost);
        return { calls: llm.calls, estimatedCostUsd: cost };
      });
      if (cost > Number(this.env.MAX_RUN_COST_USD)) {
        throw new Error('max_cost_exceeded');
      }

      const draft = await step.do(
        'render archive draft',
        { timeout: '15 seconds', sensitive: 'output' },
        async (context) => {
          await reportProgress(
            this.env,
            runId,
            'RENDERING_DRAFT',
            'README와 Pin 파일 변경안을 만들고 있어요.',
            context.attempt - 1,
          );
          const value = await createArchiveDraft({
            runId,
            pins: initial.pins,
            model: this.env.OPENAI_MODEL,
            archive,
            document,
            llm,
          });
          await store.saveDraft(runId, value, undefined, llm.calls);
          return value;
        },
      );

      await step.do(
        'publish discord preview',
        { timeout: '30 seconds', sensitive: 'output' },
        async (context) => {
          await reportProgress(
            this.env,
            runId,
            'PUBLISHING_PREVIEW',
            'Discord 미리보기를 게시하고 있어요.',
            context.attempt - 1,
          );
          const discord = new DiscordClient(this.env);
          const original = await discord.editOriginal(
            initial.interactionToken,
            {
              content: `📌 **${draft.title}** 변경안을 준비했어요. 아래 스레드에서 확인해주세요.`,
              allowed_mentions: { parse: [] },
            },
          );
          const thread = await discord.createThread(
            original.channel_id,
            original.id,
            `Hanni · ${draft.title}`,
          );
          await discord.sendMessage(thread.id, previewPayload(draft));
          await store.saveDraft(runId, draft, thread.id, llm.calls);
          await store.transition(runId, 'ANALYZING', 'AWAITING_APPROVAL');
          await store.progress(
            runId,
            'AWAITING_APPROVAL',
            '변경안을 확인하고 승인해주세요.',
          );
          return { threadId: thread.id };
        },
      );
      return { runId, status: 'AWAITING_APPROVAL' };
    } catch (error) {
      const category = errorCategory(error);
      await step.do(
        'record analysis failure',
        { retries: { limit: 1, delay: '1 second' }, timeout: '15 seconds' },
        async () => {
          const row = await store.get(runId);
          if (row?.interaction_token) {
            await new DiscordClient(this.env)
              .editOriginal(row.interaction_token, {
                content: userFacingError(error),
                allowed_mentions: { parse: [] },
              })
              .catch(() => undefined);
          }
          if (row?.status === 'VALIDATING' || row?.status === 'ANALYZING') {
            await store.fail(
              runId,
              row.status,
              isBudgetFailure(category) ? 'FAILED_BUDGET' : 'FAILED_EXTERNAL',
              category,
            );
          }
          console.error({
            event: 'hanni.workflow.failed',
            runId,
            step: row?.current_step ?? 'UNKNOWN',
            errorCategory: category,
          });
          return { category };
        },
      );
      throw error;
    }
  }
}

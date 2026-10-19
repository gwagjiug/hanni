import type { WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';
import {
  PublicationStore,
  preparedCommitSchema,
  type Publication,
} from '../../storage/publications';
import { RunProgressStore } from '../../storage/run-progress';
import { RunStore } from '../../storage/runs';
import { Tracer } from '../../telemetry/tracer';
import { DiscordClient } from '../../tools/discord';
import { GitHubClient } from '../../tools/github/client';
import type { Env } from '../../types';
import { approvedDraftHash } from './approve';
import { errorCategory } from './errors';
import {
  archiveEntry,
  hasUrl,
  insertReadmeEntry,
  renderPinFile,
} from './render';
import { parseArchiveDraft } from './schema';

const databaseStep = {
  retries: { limit: 3, delay: '1 second', backoff: 'exponential' },
  timeout: '15 seconds',
} as const satisfies WorkflowStepConfig;

const externalStep = {
  retries: { limit: 3, delay: '2 seconds', backoff: 'exponential' },
  timeout: '30 seconds',
} as const satisfies WorkflowStepConfig;

const permanentFailures: Readonly<Record<string, true>> = {
  publication_missing: true,
  publication_state_conflict: true,
  approval_draft_mismatch: true,
  approval_digest_mismatch: true,
  archive_duplicate_url: true,
  archive_slug_collision_after_approval: true,
  github_branch_conflict: true,
  github_pr_conflict: true,
  github_pr_ambiguous: true,
};

export type PublicationGitHub = Pick<
  GitHubClient,
  | 'readArchive'
  | 'createArchiveCommit'
  | 'findArchiveDraftPr'
  | 'ensureArchiveBranch'
  | 'ensureArchiveDraftPr'
>;

export interface ArchivePublicationResult {
  runId: string;
  status: 'COMPLETED' | 'FAILED_EXTERNAL';
  prUrl?: string;
}

export type PublicationTarget = Pick<
  Publication,
  'owner' | 'repo' | 'base_branch'
>;

export interface PublicationDependencies {
  publications: PublicationStore;
  runs: Pick<RunStore, 'get'>;
  progress: Pick<RunProgressStore, 'progress'>;
  github(publication: PublicationTarget): PublicationGitHub;
  discord: Pick<DiscordClient, 'sendMessage'>;
  tracer: Pick<Tracer, 'span'>;
}

export async function publishApprovedArchive(
  env: Env,
  runId: string,
  step: Pick<WorkflowStep, 'do'>,
  dependencies: PublicationDependencies = {
    publications: new PublicationStore(env.DB),
    runs: new RunStore(env.DB),
    progress: new RunProgressStore(env.DB),
    github: (publication) =>
      new GitHubClient({
        ...env,
        ARCHIVE_OWNER: publication.owner,
        ARCHIVE_REPO: publication.repo,
        ARCHIVE_DEFAULT_BRANCH: publication.base_branch,
      }),
    discord: new DiscordClient(env),
    tracer: new Tracer(runId),
  },
): Promise<ArchivePublicationResult> {
  const { publications, runs, progress, tracer } = dependencies;
  try {
    const publication = await step.do(
      'load approved publication',
      databaseStep,
      async () => {
        const value = await publications.get(runId);
        if (!value) {
          throw new Error('publication_missing');
        }
        if (value.outcome !== 'succeeded' && value.outcome !== 'failed') {
          const row = await runs.get(runId);
          if (
            row?.discord_user_id !== value.approved_by ||
            (row.status !== 'CREATING_PR' &&
              !(
                row.status === 'COMPLETED' && value.pr_url === row.github_pr_url
              ))
          ) {
            throw new Error('publication_state_conflict');
          }
          if (
            !value.draft_json ||
            (await approvedDraftHash(value.draft_json)) !== value.draft_hash
          ) {
            throw new Error('approval_digest_mismatch');
          }
        }
        // Keep private draft/file contents in D1, not Workflow step outputs.
        return {
          owner: value.owner,
          repo: value.repo,
          base_branch: value.base_branch,
          branch: value.branch,
          outcome: value.outcome,
          pr_url: value.pr_url,
        };
      },
    );
    if (publication.outcome === 'succeeded' && publication.pr_url) {
      return { runId, status: 'COMPLETED', prUrl: publication.pr_url };
    }
    if (publication.outcome === 'failed') {
      return { runId, status: 'FAILED_EXTERNAL' };
    }

    const github = dependencies.github(publication);
    let prUrl = await step.do(
      'reconcile prior archive PR',
      externalStep,
      async () => {
        const current = await publications.get(runId);
        if (!current) {
          throw new Error('publication_missing');
        }
        if (current.pr_url || !current.commit_sha) {
          return current.pr_url;
        }
        const observed = await github.findArchiveDraftPr(
          current.branch,
          current.commit_sha,
        );
        if (observed) {
          await publications.recordPullRequest(runId, observed.prUrl);
        }
        return observed?.prUrl ?? null;
      },
    );
    if (!prUrl) {
      await step.do(
        'prepare approved archive commit',
        externalStep,
        async (context) => {
          await progress.progress(
            runId,
            'REVALIDATING_ARCHIVE',
            '승인한 내용을 최신 archive 기준으로 검증하고 있어요.',
            context.attempt - 1,
          );
          const current = await publications.get(runId);
          if (current?.prepared_json) {
            return { prepared: true };
          }
          if (!current?.draft_json) {
            throw new Error('publication_state_conflict');
          }
          const draft = parseArchiveDraft(current.draft_json);
          if (draft.runId !== runId) {
            throw new Error('approval_draft_mismatch');
          }
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
          await publications.savePrepared(runId, {
            commitMessage: `archive: add ${draft.title}`,
            baseCommitSha: latest.baseCommitSha,
            baseTreeSha: latest.baseTreeSha,
            readme: insertReadmeEntry(
              latest.readme,
              draft.category.name,
              archiveEntry(draft.title, draft.url, draft.slug),
            ),
            pinPath: draft.pinPath,
            pinContent: renderPinFile(draft.title, draft.url, draft.pins),
          });
          return { prepared: true };
        },
      );

      const commitSha = await step.do(
        'create archive commit',
        externalStep,
        async (context) => {
          await progress.progress(
            runId,
            'CREATING_ARCHIVE_COMMIT',
            '승인한 파일의 commit을 준비하고 있어요.',
            context.attempt - 1,
          );
          const current = await publications.get(runId);
          if (current?.commit_sha) {
            return current.commit_sha;
          }
          if (!current?.prepared_json) {
            throw new Error('publication_state_conflict');
          }
          const prepared = preparedCommitSchema.parse(
            JSON.parse(current.prepared_json),
          );
          await publications.recordAttempt(runId);
          const sha = await tracer.span(
            'github.create_archive_commit',
            { 'tool.read_write': 'write', 'ax.dimension': 'goal_achievement' },
            () => github.createArchiveCommit(prepared),
          );
          return publications.saveCommit(runId, sha);
        },
      );

      await step.do('ensure archive branch', externalStep, async (context) => {
        await progress.progress(
          runId,
          'ENSURING_ARCHIVE_BRANCH',
          '실행 전용 브랜치를 확인하고 있어요.',
          context.attempt - 1,
        );
        await tracer.span(
          'github.ensure_archive_branch',
          { 'tool.read_write': 'write', 'ax.dimension': 'goal_achievement' },
          () => github.ensureArchiveBranch(publication.branch, commitSha),
        );
        return { branch: publication.branch };
      });

      const result = await step.do(
        'ensure archive draft PR',
        externalStep,
        async (context) => {
          await progress.progress(
            runId,
            'ENSURING_ARCHIVE_PR',
            '기존 Draft PR을 확인하고 필요한 경우에만 만들고 있어요.',
            context.attempt - 1,
          );
          const current = await publications.get(runId);
          if (current?.pr_url) {
            return { branch: current.branch, prUrl: current.pr_url };
          }
          if (!current?.draft_json) {
            throw new Error('publication_state_conflict');
          }
          const draft = parseArchiveDraft(current.draft_json);
          const observed = await tracer.span(
            'github.ensure_archive_draft_pr',
            { 'tool.read_write': 'write', 'ax.dimension': 'goal_achievement' },
            () =>
              github.ensureArchiveDraftPr({
                branch: publication.branch,
                commitSha,
                title: draft.prTitle,
                body: draft.prBody,
              }),
          );
          // A successful external effect must survive a later completion failure.
          await publications.recordPullRequest(runId, observed.prUrl);
          return observed;
        },
      );
      prUrl = result.prUrl;
    }

    await step.do('complete archive publication', databaseStep, async () => {
      await publications.complete(runId);
      return { prUrl };
    });

    try {
      await step.do('notify archive publication', externalStep, async () => {
        const row = await runs.get(runId);
        if (!row) {
          throw new Error('publication_run_missing');
        }
        await dependencies.discord.sendMessage(
          row.thread_id ?? row.channel_id,
          {
            content: `✅ Draft PR을 만들었어요.\n${prUrl}`,
            nonce: runId.replaceAll('-', '').slice(0, 25),
            enforce_nonce: true,
            allowed_mentions: { parse: [] },
          },
        );
        return { notified: true };
      });
    } catch (error) {
      // Notification failure does not undo an observed and persisted PR.
      console.warn({
        event: 'hanni.publication.notification_failed',
        runId,
        errorCategory: errorCategory(error),
      });
    }
    return { runId, status: 'COMPLETED', prUrl };
  } catch (error) {
    const category = errorCategory(error);
    await step.do('record publication failure', databaseStep, async () => {
      const current = await publications.get(runId);
      const recoverable =
        !Object.hasOwn(permanentFailures, category) || Boolean(current?.pr_url);
      if (current) {
        if (!recoverable) {
          await publications.fail(runId, category);
        } else {
          await publications.markUnknown(runId, category);
        }
      }
      console.error({
        event: 'hanni.publication.failed',
        runId,
        errorCategory: category,
        recoverable,
      });
      return { category };
    });
    throw error;
  }
}

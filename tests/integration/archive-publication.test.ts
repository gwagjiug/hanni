import type {
  WorkflowStep,
  WorkflowStepConfig,
  WorkflowStepContext,
} from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { approveDraft } from '../../src/skills/archive-url/approve';
import {
  publishApprovedArchive,
  type PublicationDependencies,
  type PublicationGitHub,
} from '../../src/skills/archive-url/publish';
import { PublicationStore } from '../../src/storage/publications';
import { RunProgressStore } from '../../src/storage/run-progress';
import { RunStore } from '../../src/storage/runs';
import type { CreateArchiveCommitInput } from '../../src/tools/github/client';
import type { ArchiveDraft, Env } from '../../src/types';
import { dispatchArchivePublication } from '../../src/workflows/publication-dispatch';
import { createTestDatabase, type TestDatabase } from '../helpers/d1';

interface RemotePublicationState {
  commits: CreateArchiveCommitInput[];
  branchSha: string | null;
  prs: Array<{ branch: string; prUrl: string }>;
  loseBranchResponse: boolean;
  losePrResponse: boolean;
  notificationFails: boolean;
}

interface PublicationFixture extends TestDatabase {
  env: Env;
  runs: RunStore;
  publications: PublicationStore;
  runId: string;
  draft: ArchiveDraft;
  remote: RemotePublicationState;
  dependencies: PublicationDependencies;
}

// Execute one attempt per step. A new runner models a full restart with no
// Workflow result cache: recovery must work from the production D1 checkpoints.
function restartedSteps(outputs?: unknown[]): Pick<WorkflowStep, 'do'> {
  async function execute<T>(
    name: string,
    configOrCallback:
      WorkflowStepConfig | ((context: WorkflowStepContext) => Promise<T>),
    callback?: (context: WorkflowStepContext) => Promise<T>,
  ): Promise<T> {
    const work =
      typeof configOrCallback === 'function' ? configOrCallback : callback;
    if (!work) {
      throw new Error('step_callback_missing');
    }
    const result = await work({
      step: { name, count: 1 },
      attempt: 1,
      config: {},
    });
    outputs?.push(result);
    return result;
  }
  return { do: execute as WorkflowStep['do'] };
}

async function fixture(approve = true): Promise<PublicationFixture> {
  const database = createTestDatabase();
  const runs = new RunStore(database.db);
  const publications = new PublicationStore(database.db);
  const runId = 'publication-12345678';
  const env = {
    DB: database.db,
    ARCHIVE_OWNER: 'owner',
    ARCHIVE_REPO: 'archive',
    ARCHIVE_DEFAULT_BRANCH: 'main',
  } as Env;
  await runs.create({
    id: runId,
    userId: 'operator',
    guildId: 'guild',
    channelId: 'channel',
    interactionToken: 'local-only',
    sourceUrl: 'https://example.com/article',
    urlHash: runId,
    workflowInput: { pins: ['사용자가 고른 원문'] },
    ttlHours: 24,
  });
  const draft: ArchiveDraft = {
    runId,
    title: 'Article',
    url: 'https://example.com/article',
    pins: ['사용자가 고른 원문'],
    slug: 'article',
    pinPath: 'pins/article.md',
    readmeBefore: '# Archive\n\n## AI\n',
    readmeAfter: 'preview',
    pinContent: 'preview',
    baseCommitSha: 'preview-base',
    baseTreeSha: 'preview-tree',
    model: 'local-only',
    usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 },
    estimatedCostUsd: 0.001,
    category: { name: 'AI', mode: 'existing', rationale: 'fixture' },
    prTitle: 'Archive Article',
    prBody: 'Archive selected pins',
  };
  await runs.saveDraft(runId, draft);
  await runs.transition(runId, 'RECEIVED', 'VALIDATING');
  await runs.transition(runId, 'VALIDATING', 'ANALYZING');
  await runs.transition(runId, 'ANALYZING', 'AWAITING_APPROVAL');
  if (approve) {
    await approveDraft(env, runId, 'operator');
  }

  const remote: RemotePublicationState = {
    commits: [],
    branchSha: null,
    prs: [],
    loseBranchResponse: false,
    losePrResponse: false,
    notificationFails: false,
  };
  const github: PublicationGitHub = {
    async readArchive() {
      return {
        readme: '# Archive\n\nA concurrent entry.\n\n## AI\n',
        baseCommitSha: 'latest-base',
        baseTreeSha: 'latest-tree',
        files: new Set(),
      };
    },
    async createArchiveCommit(input) {
      remote.commits.push(input);
      return `commit-${remote.commits.length}`;
    },
    async findArchiveDraftPr(branch) {
      return remote.prs.find((item) => item.branch === branch) ?? null;
    },
    async ensureArchiveBranch(_branch, commitSha) {
      if (remote.branchSha && remote.branchSha !== commitSha) {
        throw new Error('github_branch_conflict');
      }
      remote.branchSha = commitSha;
      if (remote.loseBranchResponse) {
        remote.loseBranchResponse = false;
        throw new Error('github_reconciliation_failed');
      }
    },
    async ensureArchiveDraftPr(input) {
      let pr = remote.prs.find((item) => item.branch === input.branch);
      if (!pr) {
        pr = {
          branch: input.branch,
          prUrl: `https://github.com/owner/archive/pull/${remote.prs.length + 1}`,
        };
        remote.prs.push(pr);
      }
      if (remote.losePrResponse) {
        remote.losePrResponse = false;
        throw new Error('github_reconciliation_failed');
      }
      return pr;
    },
  };
  const dependencies: PublicationDependencies = {
    publications,
    runs,
    progress: new RunProgressStore(database.db),
    github: () => github,
    tracer: {
      async span(_name, _attributes, work) {
        return work();
      },
    },
    discord: {
      async sendMessage() {
        if (remote.notificationFails) {
          throw new Error('discord_send_message_503');
        }
      },
    },
  };
  return {
    ...database,
    env,
    runs,
    publications,
    runId,
    draft,
    remote,
    dependencies,
  };
}

async function publish(setup: PublicationFixture, outputs?: unknown[]) {
  return publishApprovedArchive(
    setup.env,
    setup.runId,
    restartedSteps(outputs),
    setup.dependencies,
  );
}

describe('durable archive publication', () => {
  it('refuses execution without a committed approval intent', async () => {
    const setup = await fixture(false);
    try {
      await expect(publish(setup)).rejects.toThrow();
      expect(setup.remote.commits).toEqual([]);
      expect(setup.remote.prs).toEqual([]);
      expect((await setup.runs.get(setup.runId))?.status).toBe(
        'AWAITING_APPROVAL',
      );
    } finally {
      setup.close();
    }
  });

  it('keeps an unrecognized external error recoverable without erasing approval', async () => {
    const setup = await fixture();
    try {
      const originalGitHub = setup.dependencies.github;
      setup.dependencies.github = (target) => ({
        ...originalGitHub(target),
        async readArchive() {
          throw new Error('constructor');
        },
      });
      await expect(publish(setup)).rejects.toThrow('constructor');
      expect(await setup.publications.get(setup.runId)).toMatchObject({
        outcome: 'unknown',
        draft_json: JSON.stringify(setup.draft),
      });
      expect((await setup.runs.get(setup.runId))?.status).toBe('CREATING_PR');
    } finally {
      setup.close();
    }
  });

  it('locks the approved pins and rebases the change onto the latest main', async () => {
    const setup = await fixture();
    try {
      expect(
        await setup.runs.replaceDraft(setup.runId, {
          ...setup.draft,
          pins: ['승인 뒤에 바꾼 문장'],
        }),
      ).toBe(false);
      expect(await setup.runs.cancel(setup.runId)).toBe(false);
      const outputs: unknown[] = [];
      await publish(setup, outputs);
      const commit = setup.remote.commits[0];
      expect(commit?.baseCommitSha).toBe('latest-base');
      expect(commit?.readme).toContain('A concurrent entry.');
      expect(commit?.pinContent).toContain('> 사용자가 고른 원문');
      expect(commit?.pinContent).not.toContain('승인 뒤에 바꾼 문장');
      expect((await setup.runs.get(setup.runId))?.status).toBe('COMPLETED');
      const persistedOutput = JSON.stringify(outputs);
      expect(persistedOutput).not.toContain('사용자가 고른 원문');
      expect(persistedOutput).not.toContain('A concurrent entry.');
    } finally {
      setup.close();
    }
  });

  it('reuses the saved commit after a branch response is lost across a restart', async () => {
    const setup = await fixture();
    try {
      setup.remote.loseBranchResponse = true;
      await expect(publish(setup)).rejects.toThrow(
        'github_reconciliation_failed',
      );
      const interrupted = await setup.publications.get(setup.runId);
      expect(interrupted?.outcome).toBe('unknown');
      expect(interrupted?.commit_sha).toBe(setup.remote.branchSha);
      expect(interrupted?.draft_json).not.toBeNull();
      const result = await publish(setup);
      expect(setup.remote.commits).toHaveLength(1);
      expect(setup.remote.prs).toHaveLength(1);
      expect(result.prUrl).toBe(setup.remote.prs[0]?.prUrl);
      expect((await setup.runs.get(setup.runId))?.status).toBe('COMPLETED');
    } finally {
      setup.close();
    }
  });

  it('reconciles an unacknowledged PR instead of creating a replacement', async () => {
    const setup = await fixture();
    try {
      setup.remote.losePrResponse = true;
      await expect(publish(setup)).rejects.toThrow(
        'github_reconciliation_failed',
      );
      expect(setup.remote.prs).toHaveLength(1);
      expect((await setup.publications.get(setup.runId))?.pr_url).toBeNull();
      expect((await setup.runs.get(setup.runId))?.status).toBe('CREATING_PR');
      // The user may close the PR and delete its branch before recovery.
      setup.remote.branchSha = null;
      const result = await publish(setup);
      expect(setup.remote.prs).toHaveLength(1);
      expect(result.prUrl).toBe(setup.remote.prs[0]?.prUrl);
      expect((await setup.publications.get(setup.runId))?.outcome).toBe(
        'succeeded',
      );
      expect(setup.remote.branchSha).toBeNull();
    } finally {
      setup.close();
    }
  });

  it('retains the observed PR and approval when completion storage fails', async () => {
    const setup = await fixture();
    try {
      setup.sqlite
        .exec(`CREATE TRIGGER interrupt_completion BEFORE UPDATE ON runs
        WHEN NEW.status = 'COMPLETED'
        BEGIN SELECT RAISE(ABORT, 'simulated_completion_storage_failure'); END;`);
      await expect(publish(setup)).rejects.toThrow(
        'simulated_completion_storage_failure',
      );
      const interrupted = await setup.publications.get(setup.runId);
      expect(interrupted?.pr_url).toBe(setup.remote.prs[0]?.prUrl);
      expect(interrupted?.draft_json).not.toBeNull();
      expect(interrupted?.outcome).toBe('unknown');
      expect((await setup.runs.get(setup.runId))?.status).toBe('CREATING_PR');
      setup.sqlite.exec('DROP TRIGGER interrupt_completion');
      // A successful create() may return the already-errored instance.
      setup.env.ARCHIVE_PUBLICATION_WORKFLOW = {
        async create() {
          return { id: setup.runId };
        },
        async get() {
          return {
            id: setup.runId,
            async status() {
              const publication = await setup.publications.get(setup.runId);
              return {
                status:
                  publication?.outcome === 'succeeded' ? 'complete' : 'errored',
              };
            },
            async restart() {
              await publish(setup);
            },
          };
        },
      } as unknown as Env['ARCHIVE_PUBLICATION_WORKFLOW'];
      await dispatchArchivePublication(setup.env, setup.runId);
      expect(setup.remote.prs).toHaveLength(1);
      const completed = await setup.publications.get(setup.runId);
      expect(completed?.pr_url).toBe(interrupted?.pr_url);
      expect(completed?.outcome).toBe('succeeded');
      expect(completed?.draft_json).toBeNull();
      expect(completed?.prepared_json).toBeNull();
      expect((await setup.runs.get(setup.runId))?.draft_json).toBeNull();
      await publish(setup);
      expect(setup.remote.prs).toHaveLength(1);
    } finally {
      setup.close();
    }
  });

  it('refuses a conflicting branch without overwriting it or publishing a PR', async () => {
    const setup = await fixture();
    try {
      setup.remote.branchSha = 'somebody-elses-commit';
      await expect(publish(setup)).rejects.toThrow('github_branch_conflict');
      expect(setup.remote.branchSha).toBe('somebody-elses-commit');
      expect(setup.remote.prs).toEqual([]);
      expect((await setup.runs.get(setup.runId))?.status).toBe(
        'FAILED_EXTERNAL',
      );
    } finally {
      setup.close();
    }
  });

  it('keeps successful PR status when only the Discord notification fails', async () => {
    const setup = await fixture();
    try {
      setup.remote.notificationFails = true;
      const result = await publish(setup);
      const row = await setup.runs.get(setup.runId);
      expect(row?.status).toBe('COMPLETED');
      expect(row?.github_pr_url).toBe(result.prUrl);
      expect((await setup.publications.get(setup.runId))?.outcome).toBe(
        'succeeded',
      );
    } finally {
      setup.close();
    }
  });
});

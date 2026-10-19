import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker } from '../../src/agent/circuit-breaker';
import {
  analyzeArchiveUrl,
  type ArchiveWorkflowDependencies,
} from '../../src/skills/archive-url/run';
import type { ArchiveDraft, Env, RunRow, RunStatus } from '../../src/types';

const env = {
  OPENAI_API_KEY: 'test',
  OPENAI_MODEL: 'test-model',
  MAX_RUN_COST_USD: '0.03',
} as Env;

function row(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: 'run-12345678',
    discord_user_id: 'owner',
    guild_id: 'guild',
    channel_id: 'channel',
    interaction_token: 'interaction',
    thread_id: null,
    source_url: 'https://example.com/article',
    normalized_url_hash: 'hash',
    draft_json: null,
    base_commit_sha: null,
    status: 'RECEIVED',
    termination_reason: null,
    llm_calls: 0,
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: 0,
    github_branch: null,
    github_pr_url: null,
    error_category: null,
    workflow_instance_id: null,
    workflow_input_json: null,
    current_step: null,
    step_started_at: null,
    last_heartbeat_at: null,
    retry_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function dependencies(initial: RunRow) {
  let current = initial;
  let savedDraft: ArchiveDraft | undefined;
  const store: ArchiveWorkflowDependencies['store'] = {
    get: vi.fn(async () => current),
    transition: vi.fn(async (_id, from, to) => {
      if (current.status !== from) {
        return false;
      }
      current = { ...current, status: to as RunStatus };
      return true;
    }),
    saveDraft: vi.fn(async (_id, draft) => {
      savedDraft = draft;
      current = { ...current, draft_json: JSON.stringify(draft) };
    }),
    fail: vi.fn(async (_id, _from, status, category) => {
      current = { ...current, status, error_category: category };
      return true;
    }),
  };
  const deps: ArchiveWorkflowDependencies = {
    store,
    github: {
      readArchive: vi.fn(async () => ({
        readme: '# Archive\n\n## AI\n',
        baseCommitSha: 'commit',
        baseTreeSha: 'tree',
        files: new Set<string>(),
      })),
    },
    discord: {
      editOriginal: vi.fn(async () => ({
        id: 'message',
        channel_id: 'channel',
      })),
      createThread: vi.fn(async () => ({ id: 'thread' })),
      sendMessage: vi.fn(async () => undefined),
    },
    metadata: vi.fn(async () => ({
      title: 'Useful Agent',
      canonicalUrl: 'https://example.com/article',
    })),
    prepare: vi.fn(async () => ({
      preparation: {
        category: { name: 'AI', mode: 'existing' as const, rationale: 'fit' },
        prTitle: 'archive: add Useful Agent',
        prBody: 'Adds pins.',
      },
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 },
      calls: 1,
    })),
    tracer: { span: vi.fn(async (_name, _attributes, work) => work()) },
    circuit: new CircuitBreaker(),
  };
  return { deps, store, current: () => current, savedDraft: () => savedDraft };
}

describe('archive workflow', () => {
  it('analyzes once and stores an approval-ready deterministic draft', async () => {
    const setup = dependencies(row());
    await analyzeArchiveUrl(
      env,
      { runId: 'run-12345678', pins: ['원문 그대로'] },
      setup.deps,
    );

    expect(setup.deps.prepare).toHaveBeenCalledOnce();
    expect(setup.current().status).toBe('AWAITING_APPROVAL');
    expect(setup.savedDraft()?.pinContent).toContain('> 원문 그대로');
  });

  it('stops before Discord and GitHub writes when token usage exceeds the circuit', async () => {
    const setup = dependencies(row());
    setup.deps.prepare = vi.fn(async () => ({
      preparation: {
        category: { name: 'AI', mode: 'existing' as const, rationale: 'fit' },
        prTitle: 'title',
        prBody: 'body',
      },
      usage: { inputTokens: 12_001, cachedInputTokens: 0, outputTokens: 20 },
      calls: 1,
    }));
    await analyzeArchiveUrl(
      env,
      { runId: 'run-12345678', pins: ['pin'] },
      setup.deps,
    );

    expect(setup.current().status).toBe('FAILED_BUDGET');
    expect(setup.deps.discord.createThread).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicationStore } from '../../src/storage/publications';
import { RunStore } from '../../src/storage/runs';
import type { CreateArchiveCommitInput } from '../../src/tools/github/client';
import {
  createTestDatabase,
  type TestDatabase,
  type TestDatabaseOptions,
} from '../helpers/d1';

const runId = 'run-12345678-full-id';
const draftJson = JSON.stringify({
  title: 'Approved private draft',
  pins: ['private'],
});
const target = { owner: 'archive-owner', repo: 'archive', baseBranch: 'main' };
const prUrl = 'https://github.com/archive-owner/archive/pull/17';
const prepared: CreateArchiveCommitInput = {
  commitMessage: 'archive: add approved article',
  baseCommitSha: 'base-commit',
  baseTreeSha: 'base-tree',
  readme: '# Archive\nApproved readme',
  pinPath: 'pins/approved.md',
  pinContent: 'Private approved pins',
};

const databases: TestDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
  vi.useRealTimers();
});

function database(options?: TestDatabaseOptions) {
  const result = createTestDatabase(options);
  databases.push(result);
  return { ...result, store: new PublicationStore(result.db) };
}

async function seedRun(
  db: D1Database,
  input: {
    id?: string;
    userId?: string;
    status?: string;
    draft?: string | null;
    expiresAt?: string;
  } = {},
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO runs
       (id, discord_user_id, guild_id, channel_id, interaction_token, source_url,
        normalized_url_hash, draft_json, workflow_input_json, status,
        current_step, created_at, updated_at, expires_at)
       VALUES (?, ?, 'guild', 'channel', 'private-token', 'https://private.test/source',
               ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id ?? runId,
      input.userId ?? 'owner',
      input.id ?? runId,
      input.draft === undefined ? draftJson : input.draft,
      JSON.stringify({ pins: ['private workflow input'] }),
      input.status ?? 'AWAITING_APPROVAL',
      input.status ?? 'AWAITING_APPROVAL',
      now,
      now,
      input.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
    )
    .run();
}

function approvalInput(id = runId) {
  return {
    runId: id,
    userId: 'owner',
    draftJson,
    draftHash: 'approved-draft-digest',
    target,
  };
}

async function observePr(store: PublicationStore): Promise<void> {
  await store.approve(approvalInput());
  await store.savePrepared(runId, prepared);
  await store.saveCommit(runId, 'approved-commit');
  await store.recordAttempt(runId);
  await store.recordPullRequest(runId, prUrl);
}

describe('PublicationStore durable approval', () => {
  it('claims exactly one immutable approval with its full-id branch and target', async () => {
    const { db, store } = database();
    await seedRun(db);
    const first = await store.approve(approvalInput());
    expect(first).toMatchObject({
      run_id: runId,
      approved_by: 'owner',
      draft_hash: 'approved-draft-digest',
      draft_json: draftJson,
      owner: target.owner,
      repo: target.repo,
      base_branch: target.baseBranch,
      branch: `hanni/archive-${runId}`,
      outcome: 'requested',
    });
    expect(await new RunStore(db).get(runId)).toMatchObject({
      status: 'CREATING_PR',
      draft_json: draftJson,
    });

    const replay = await store.approve({
      ...approvalInput(),
      draftJson: JSON.stringify({ title: 'A later draft' }),
      draftHash: 'different-digest',
      target: { owner: 'other', repo: 'other', baseBranch: 'other' },
    });
    expect(replay).toEqual(first);
    expect(
      await store.approve({ ...approvalInput(), userId: 'not-the-owner' }),
    ).toBeNull();
  });

  it('serializes racing approvals without replacing the winning consent', async () => {
    const { db, store } = database();
    await seedRun(db);
    const approvals = await Promise.all([
      store.approve(approvalInput()),
      store.approve({
        ...approvalInput(),
        target: { owner: 'changed', repo: 'changed', baseBranch: 'changed' },
      }),
    ]);
    expect(approvals[0]).not.toBeNull();
    expect(approvals[1]).toEqual(approvals[0]);
    expect(await store.get(runId)).toEqual(approvals[0]);
  });

  it('rejects a stale exact-byte draft but accepts the current draft', async () => {
    const { db, store } = database();
    await seedRun(db);
    const edited = JSON.stringify({ title: 'Edited private draft' });
    await db
      .prepare('UPDATE runs SET draft_json = ? WHERE id = ?')
      .bind(edited, runId)
      .run();
    expect(await store.approve(approvalInput())).toBeNull();
    expect(await store.get(runId)).toBeNull();
    expect(await new RunStore(db).get(runId)).toMatchObject({
      status: 'AWAITING_APPROVAL',
      draft_json: edited,
    });
    expect(
      await store.approve({
        ...approvalInput(),
        draftJson: edited,
        draftHash: 'edited-digest',
      }),
    ).toMatchObject({ draft_json: edited, draft_hash: 'edited-digest' });
  });

  it('enforces ownership, expiry, and the expiry boundary inside the claim', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T10:00:00.000Z'));
    const { db, store } = database();
    await seedRun(db);
    expect(
      await store.approve({ ...approvalInput(), userId: 'attacker' }),
    ).toBeNull();
    await db
      .prepare('UPDATE runs SET expires_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), runId)
      .run();
    expect(await store.approve(approvalInput())).toBeNull();
    expect(await store.get(runId)).toBeNull();
    expect(await new RunStore(db).get(runId)).toMatchObject({
      status: 'AWAITING_APPROVAL',
      draft_json: draftJson,
    });
  });

  it.each(['CANCELLED', 'EXPIRED', 'COMPLETED', 'FAILED_EXTERNAL'])(
    'does not approve or alter a %s run',
    async (status) => {
      const { db, store } = database();
      await seedRun(db, { status });
      const before = await new RunStore(db).get(runId);
      expect(await store.approve(approvalInput())).toBeNull();
      expect(await store.get(runId)).toBeNull();
      expect(await new RunStore(db).get(runId)).toEqual(before);
    },
  );

  it('gives cancellation and approval an atomic, exclusive winner', async () => {
    const { db, store } = database();
    await seedRun(db);
    const [cancelled, approval] = await Promise.all([
      new RunStore(db).cancel(runId),
      store.approve(approvalInput()),
    ]);
    expect(cancelled).toBe(true);
    expect(approval).toBeNull();
    expect(await store.get(runId)).toBeNull();

    await seedRun(db, { id: 'approval-wins' });
    const [claimed, cancellation] = await Promise.all([
      store.approve(approvalInput('approval-wins')),
      new RunStore(db).cancel('approval-wins'),
    ]);
    expect(claimed).not.toBeNull();
    expect(cancellation).toBe(false);
  });

  it.each([1, 2])(
    'rolls back approval and run claim when batch statement %i fails',
    async (index) => {
      let failure: number | null = null;
      const { db, store } = database({
        beforeStatement(_query, batchIndex) {
          if (failure !== null && batchIndex === failure) {
            failure = null;
            throw new Error('injected approval storage failure');
          }
        },
      });
      await seedRun(db);
      failure = index;
      await expect(store.approve(approvalInput())).rejects.toThrow('injected');
      expect(await store.get(runId)).toBeNull();
      expect(await new RunStore(db).get(runId)).toMatchObject({
        status: 'AWAITING_APPROVAL',
        draft_json: draftJson,
      });
      expect(await store.approve(approvalInput())).not.toBeNull();
    },
  );
});

describe('PublicationStore recoverable checkpoints', () => {
  it('saves the first prepared plan and commit immutably across racing calls', async () => {
    const { db, store } = database();
    await seedRun(db);
    await store.approve(approvalInput());
    const results = await Promise.all([
      store.savePrepared(runId, prepared),
      store.savePrepared(runId, {
        ...prepared,
        readme: 'A later repository snapshot',
      }),
    ]);
    expect(results).toEqual([prepared, prepared]);
    expect(await store.saveCommit(runId, 'approved-commit')).toBe(
      'approved-commit',
    );
    expect(await store.saveCommit(runId, 'approved-commit')).toBe(
      'approved-commit',
    );
    await expect(store.saveCommit(runId, 'different-commit')).rejects.toThrow(
      'publication_commit_conflict',
    );
    expect(await store.get(runId)).toMatchObject({
      prepared_json: JSON.stringify(prepared),
      commit_sha: 'approved-commit',
    });
  });

  it('keeps the full recovery payload and observed PR when the outcome is unknown', async () => {
    const { db, store } = database();
    await seedRun(db);
    await observePr(store);
    await store.markUnknown(runId, 'completion_storage_unavailable');
    await store.recordAttempt(runId);
    expect(await store.get(runId)).toMatchObject({
      outcome: 'unknown',
      error_category: 'completion_storage_unavailable',
      draft_json: draftJson,
      prepared_json: JSON.stringify(prepared),
      commit_sha: 'approved-commit',
      pr_url: prUrl,
    });
    expect(await new RunStore(db).get(runId)).toMatchObject({
      status: 'CREATING_PR',
      current_step: 'PUBLICATION_RECOVERY',
      error_category: 'completion_storage_unavailable',
      interaction_token: 'private-token',
      draft_json: draftJson,
      github_branch: `hanni/archive-${runId}`,
      github_pr_url: prUrl,
    });
    expect(await store.listRecoverable()).toHaveLength(1);
    await expect(store.fail(runId, 'must-not-destroy-pr')).rejects.toThrow(
      'publication_pr_already_observed',
    );
    expect((await store.get(runId))?.draft_json).toBe(draftJson);
  });

  it('refuses another PR URL without replacing the saved observation or run mirror', async () => {
    const { db, store } = database();
    await seedRun(db);
    await observePr(store);
    const before = await store.get(runId);
    await expect(
      store.recordPullRequest(runId, 'https://github.com/other/repo/pull/1'),
    ).rejects.toThrow('publication_pr_conflict');
    expect(await store.get(runId)).toEqual(before);
    expect((await new RunStore(db).get(runId))?.github_pr_url).toBe(prUrl);
    await store.recordPullRequest(runId, prUrl);
    expect((await store.get(runId))?.pr_url).toBe(prUrl);
  });

  it('rolls back a PR observation if mirroring its run fails, then permits replay', async () => {
    let fail = false;
    const { db, store } = database({
      beforeStatement(_query, batchIndex) {
        if (fail && batchIndex === 1) {
          fail = false;
          throw new Error('injected mirror failure');
        }
      },
    });
    await seedRun(db);
    await store.approve(approvalInput());
    fail = true;
    await expect(store.recordPullRequest(runId, prUrl)).rejects.toThrow(
      'injected',
    );
    expect(await store.get(runId)).toMatchObject({
      pr_url: null,
      draft_json: draftJson,
    });
    expect((await new RunStore(db).get(runId))?.github_pr_url).toBeNull();
    await store.recordPullRequest(runId, prUrl);
    expect((await new RunStore(db).get(runId))?.github_pr_url).toBe(prUrl);
  });

  it('lists only recoverable publication/run pairs and enforces the bound', async () => {
    const { db, store } = database();
    for (let index = 0; index < 23; index += 1) {
      const id = `recoverable-${index}`;
      await seedRun(db, { id });
      await store.approve(approvalInput(id));
      if (index === 0) {
        await store.recordAttempt(id);
      } else if (index === 1) {
        await store.markUnknown(id, 'github_http_503');
      }
    }
    await store.fail('recoverable-21', 'permanent');
    await db
      .prepare("UPDATE runs SET status = 'FAILED_TIMEOUT' WHERE id = ?")
      .bind('recoverable-22')
      .run();
    const recoverable = await store.listRecoverable(100);
    expect(recoverable).toHaveLength(21);
    expect(recoverable.map((row) => row.outcome)).toEqual(
      expect.arrayContaining(['requested', 'attempted', 'unknown']),
    );
    expect(await store.listRecoverable()).toHaveLength(20);
    expect(await store.listRecoverable(1)).toHaveLength(1);
    await expect(store.listRecoverable(0)).rejects.toThrow();
    await expect(store.listRecoverable(101)).rejects.toThrow();
  });

  it('rotates checked intents without claiming a write or losing uncertainty', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T10:00:00.000Z'));
    const { db, store } = database();
    for (const id of ['a-pending', 'b-pending']) {
      await seedRun(db, { id });
      await store.approve(approvalInput(id));
    }
    expect((await store.listRecoverable(1))[0]?.run_id).toBe('a-pending');
    vi.setSystemTime(new Date('2026-10-19T10:05:00.000Z'));
    await store.touchDispatch('a-pending');
    expect((await store.listRecoverable(1))[0]?.run_id).toBe('b-pending');
    expect((await store.get('a-pending'))?.outcome).toBe('requested');

    await store.markUnknown('b-pending', 'github_http_503');
    vi.setSystemTime(new Date('2026-10-19T10:10:00.000Z'));
    await store.touchDispatch('b-pending');
    expect(await store.get('b-pending')).toMatchObject({
      outcome: 'unknown',
      error_category: 'github_http_503',
      draft_json: draftJson,
    });
    expect((await store.listRecoverable(1))[0]?.run_id).toBe('a-pending');
  });

  it('validates saved prepared JSON on database reads and rejects malformed checkpoints', async () => {
    const { db, sqlite, store } = database();
    await seedRun(db);
    await store.approve(approvalInput());
    await db
      .prepare(
        'UPDATE archive_publications SET prepared_json = ? WHERE run_id = ?',
      )
      .bind(JSON.stringify({ baseCommitSha: 42 }), runId)
      .run();
    await expect(store.get(runId)).rejects.toThrow();
    await expect(store.listRecoverable()).rejects.toThrow();
    expect(() =>
      sqlite
        .prepare(
          'UPDATE archive_publications SET prepared_json = ? WHERE run_id = ?',
        )
        .run('invalid-json', runId),
    ).toThrow();
  });
});

describe('PublicationStore atomic terminal outcomes', () => {
  it('requires an observed PR before completion and retains approved data on conflict', async () => {
    const { db, store } = database();
    await seedRun(db);
    await store.approve(approvalInput());
    await store.savePrepared(runId, prepared);
    const before = await store.get(runId);
    await expect(store.complete(runId)).rejects.toThrow(
      'publication_completion_conflict',
    );
    expect(await store.get(runId)).toEqual(before);
    expect((await new RunStore(db).get(runId))?.status).toBe('CREATING_PR');
  });

  it.each([0, 1, 2])(
    'preserves observed PR and both private payloads when completion statement %i fails',
    async (index) => {
      let failure: number | null = null;
      const { db, store } = database({
        beforeStatement(_query, batchIndex) {
          if (failure !== null && batchIndex === failure) {
            failure = null;
            throw new Error('injected completion storage failure');
          }
        },
      });
      await seedRun(db);
      await observePr(store);
      const before = await store.get(runId);
      const runBefore = await new RunStore(db).get(runId);
      failure = index;
      await expect(store.complete(runId)).rejects.toThrow('injected');
      expect(await store.get(runId)).toEqual(before);
      expect(await new RunStore(db).get(runId)).toEqual(runBefore);
      await store.markUnknown(runId, 'completion_storage_failure');
      expect(await store.get(runId)).toMatchObject({
        outcome: 'unknown',
        draft_json: draftJson,
        prepared_json: JSON.stringify(prepared),
        pr_url: prUrl,
      });
      await store.complete(runId);
      expect((await store.get(runId))?.outcome).toBe('succeeded');
    },
  );

  it('rolls back actual SQLite statement errors rather than committing half a completion', async () => {
    const { db, sqlite, store } = database();
    await seedRun(db);
    await observePr(store);
    const before = await store.get(runId);
    const runBefore = await new RunStore(db).get(runId);
    sqlite.exec(`CREATE TRIGGER completion_storage_failure
      BEFORE UPDATE OF outcome ON archive_publications
      WHEN NEW.outcome = 'succeeded'
      BEGIN SELECT RAISE(ABORT, 'injected sqlite failure'); END;`);
    await expect(store.complete(runId)).rejects.toThrow(
      'injected sqlite failure',
    );
    expect(await store.get(runId)).toEqual(before);
    expect(await new RunStore(db).get(runId)).toEqual(runBefore);
    sqlite.exec('DROP TRIGGER completion_storage_failure');
    await store.complete(runId);
    expect((await store.get(runId))?.pr_url).toBe(prUrl);
  });

  it('atomically completes, cleans sensitive content, and makes terminal replay immutable', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T10:00:00.000Z'));
    const { db, store } = database();
    await seedRun(db);
    await observePr(store);
    await store.markUnknown(runId, 'previous-uncertainty');
    await store.complete(runId);
    const publication = await store.get(runId);
    const run = await new RunStore(db).get(runId);
    expect(publication).toMatchObject({
      outcome: 'succeeded',
      draft_json: null,
      prepared_json: null,
      error_category: null,
      pr_url: prUrl,
      commit_sha: 'approved-commit',
      draft_hash: 'approved-draft-digest',
      approved_by: 'owner',
      owner: target.owner,
      repo: target.repo,
      base_branch: target.baseBranch,
    });
    expect(run).toMatchObject({
      status: 'COMPLETED',
      interaction_token: null,
      source_url: null,
      draft_json: null,
      workflow_input_json: null,
      github_branch: `hanni/archive-${runId}`,
      github_pr_url: prUrl,
    });
    vi.setSystemTime(new Date('2026-10-19T11:00:00.000Z'));
    await store.complete(runId);
    await store.markUnknown(runId, 'stale');
    await store.recordAttempt(runId);
    await store.fail(runId, 'stale');
    await store.recordPullRequest(runId, prUrl);
    expect(await store.saveCommit(runId, 'approved-commit')).toBe(
      'approved-commit',
    );
    await expect(store.savePrepared(runId, prepared)).rejects.toThrow(
      'publication_state_conflict',
    );
    expect(await store.approve(approvalInput())).toEqual(publication);
    expect(await store.get(runId)).toEqual(publication);
    expect(await new RunStore(db).get(runId)).toEqual(run);
    expect(await store.listRecoverable()).toEqual([]);
  });

  it('cleans a confirmed failure but retains consent, commit, target, and the first terminal category', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T10:00:00.000Z'));
    const { db, store } = database();
    await seedRun(db);
    await store.approve(approvalInput());
    await store.savePrepared(runId, prepared);
    await store.saveCommit(runId, 'approved-commit');
    await store.markUnknown(runId, 'earlier-uncertainty');
    await store.fail(runId, 'github_branch_conflict');
    const publication = await store.get(runId);
    const run = await new RunStore(db).get(runId);
    expect(publication).toMatchObject({
      outcome: 'failed',
      error_category: 'github_branch_conflict',
      draft_json: null,
      prepared_json: null,
      pr_url: null,
      commit_sha: 'approved-commit',
      branch: `hanni/archive-${runId}`,
      draft_hash: 'approved-draft-digest',
      owner: target.owner,
      repo: target.repo,
      base_branch: target.baseBranch,
    });
    expect(run).toMatchObject({
      status: 'FAILED_EXTERNAL',
      interaction_token: null,
      source_url: null,
      draft_json: null,
      workflow_input_json: null,
      error_category: 'github_branch_conflict',
    });
    vi.setSystemTime(new Date('2026-10-19T11:00:00.000Z'));
    await store.fail(runId, 'different-failure');
    await store.markUnknown(runId, 'stale');
    await store.recordAttempt(runId);
    await expect(store.complete(runId)).rejects.toThrow(
      'publication_completion_conflict',
    );
    await expect(store.recordPullRequest(runId, prUrl)).rejects.toThrow(
      'publication_pr_conflict',
    );
    expect(await store.get(runId)).toEqual(publication);
    expect(await new RunStore(db).get(runId)).toEqual(run);
  });

  it('rolls back failure cleanup when its publication write fails', async () => {
    let fail = false;
    const { db, store } = database({
      beforeStatement(_query, batchIndex) {
        if (fail && batchIndex === 1) {
          fail = false;
          throw new Error('injected failure-checkpoint error');
        }
      },
    });
    await seedRun(db);
    await store.approve(approvalInput());
    await store.savePrepared(runId, prepared);
    const before = await store.get(runId);
    const runBefore = await new RunStore(db).get(runId);
    fail = true;
    await expect(store.fail(runId, 'permanent')).rejects.toThrow('injected');
    expect(await store.get(runId)).toEqual(before);
    expect(await new RunStore(db).get(runId)).toEqual(runBefore);
    await store.fail(runId, 'permanent');
    expect((await store.get(runId))?.outcome).toBe('failed');
  });

  it.each([
    'COMPLETED',
    'CANCELLED',
    'EXPIRED',
    'FAILED_TIMEOUT',
    'FAILED_EXTERNAL',
  ])(
    'does not let stale publication writes reopen or alter an independently terminal %s run',
    async (status) => {
      const { db, store } = database();
      await seedRun(db);
      await observePr(store);
      await db
        .prepare('UPDATE runs SET status = ? WHERE id = ?')
        .bind(status, runId)
        .run();
      const publication = await store.get(runId);
      const run = await new RunStore(db).get(runId);
      await store.markUnknown(runId, 'stale');
      await store.recordAttempt(runId);
      await expect(store.complete(runId)).rejects.toThrow(
        'publication_completion_conflict',
      );
      await expect(store.fail(runId, 'stale')).rejects.toThrow();
      await expect(store.recordPullRequest(runId, prUrl)).rejects.toThrow(
        'publication_pr_conflict',
      );
      await expect(store.savePrepared(runId, prepared)).rejects.toThrow(
        'publication_state_conflict',
      );
      await expect(store.saveCommit(runId, 'different-commit')).rejects.toThrow(
        'publication_commit_conflict',
      );
      expect(await store.get(runId)).toEqual(publication);
      expect(await new RunStore(db).get(runId)).toEqual(run);
    },
  );
});

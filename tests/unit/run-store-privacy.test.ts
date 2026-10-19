import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicationStore } from '../../src/storage/publications';
import { RunProgressStore } from '../../src/storage/run-progress';
import { RunStore } from '../../src/storage/runs';
import { runStatusSchema } from '../../src/storage/schema';
import type { RunStatus } from '../../src/types';
import { createTestDatabase, type TestDatabase } from '../helpers/d1';

const draftJson = JSON.stringify({ pins: ['private pin'] });
const databases: TestDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
  vi.useRealTimers();
});

function database(): TestDatabase {
  const result = createTestDatabase();
  databases.push(result);
  return result;
}

async function seedRun(db: D1Database, status: RunStatus): Promise<RunStore> {
  const store = new RunStore(db);
  await store.create({
    id: 'run',
    userId: 'owner',
    guildId: 'guild',
    channelId: 'channel',
    interactionToken: 'private-token',
    sourceUrl: 'https://example.com/private',
    urlHash: 'private-url-hash',
    workflowInput: { pins: ['private pin'] },
    ttlHours: 24,
  });
  await db
    .prepare('UPDATE runs SET status = ?, draft_json = ? WHERE id = ?')
    .bind(status, draftJson, 'run')
    .run();
  return store;
}

describe('RunStore terminal-state privacy', () => {
  it('rejects a status outside the domain state machine', () => {
    expect(runStatusSchema.safeParse('UNKNOWN_STATUS').success).toBe(false);
  });

  it.each([
    { operation: 'cancel', from: 'AWAITING_APPROVAL', expected: 'CANCELLED' },
    { operation: 'fail', from: 'ANALYZING', expected: 'FAILED_EXTERNAL' },
    { operation: 'transition', from: 'AWAITING_APPROVAL', expected: 'EXPIRED' },
    { operation: 'expiry', from: 'AWAITING_APPROVAL', expected: 'EXPIRED' },
    { operation: 'timeout', from: 'ANALYZING', expected: 'FAILED_TIMEOUT' },
  ] as const)(
    'clears private content on $operation',
    async ({ operation, from, expected }) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-07-13T00:00:00.000Z'));
      const { db } = database();
      const store = await seedRun(db, from);
      expect(await store.get('run')).toMatchObject({
        interaction_token: 'private-token',
        source_url: 'https://example.com/private',
        draft_json: draftJson,
        workflow_input_json: JSON.stringify({ pins: ['private pin'] }),
      });
      vi.setSystemTime(new Date('2026-07-15T00:00:00.000Z'));
      switch (operation) {
        case 'cancel':
          await store.cancel('run');
          break;
        case 'fail':
          await store.fail(
            'run',
            'ANALYZING',
            'FAILED_EXTERNAL',
            'external_failure',
          );
          break;
        case 'transition':
          await store.transition(
            'run',
            'AWAITING_APPROVAL',
            'EXPIRED',
            'approval_timeout',
          );
          break;
        case 'expiry':
          await store.expireOldRuns();
          break;
        case 'timeout':
          await store.failStaleRuns(new Date(Date.now() - 5 * 60_000));
          break;
      }
      expect(await store.get('run')).toMatchObject({
        id: 'run',
        status: expected,
        interaction_token: null,
        source_url: null,
        draft_json: null,
        workflow_input_json: null,
      });
    },
  );

  it('does not erase content when a competing transition has changed the state', async () => {
    const { db } = database();
    const store = await seedRun(db, 'AWAITING_APPROVAL');
    const before = await store.get('run');
    expect(
      await store.fail('run', 'ANALYZING', 'FAILED_EXTERNAL', 'late_failure'),
    ).toBe(false);
    expect(await store.get('run')).toEqual(before);
  });

  it('rejects late progress without changing a terminal run or adding an event', async () => {
    const { db } = database();
    const store = await seedRun(db, 'AWAITING_APPROVAL');
    await store.cancel('run');
    const before = await store.get('run');
    expect(
      await new RunProgressStore(db).progress(
        'run',
        'ENSURING_ARCHIVE_PR',
        'late progress',
      ),
    ).toBe(false);
    expect(await store.get('run')).toEqual(before);
    const events = await db
      .prepare('SELECT * FROM run_events WHERE run_id = ?')
      .bind('run')
      .all();
    expect(events.results).toEqual([]);
  });

  it('rolls back the progress update if its event cannot be persisted', async () => {
    const { db, sqlite } = database();
    const store = await seedRun(db, 'ANALYZING');
    const before = await store.get('run');
    sqlite.exec(`CREATE TRIGGER interrupt_progress BEFORE INSERT ON run_events
      BEGIN SELECT RAISE(ABORT, 'progress_storage_interrupted'); END;`);
    await expect(
      new RunProgressStore(db).progress('run', 'PUBLISHING_PREVIEW', 'working'),
    ).rejects.toThrow('progress_storage_interrupted');
    expect(await store.get('run')).toEqual(before);
    const events = await db
      .prepare('SELECT * FROM run_events WHERE run_id = ?')
      .bind('run')
      .all();
    expect(events.results).toEqual([]);
  });

  it('preserves an approved publication beyond both approval expiry and stale-run timeout', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-13T00:00:00.000Z'));
    const { db } = database();
    const store = await seedRun(db, 'AWAITING_APPROVAL');
    const publications = new PublicationStore(db);
    await publications.approve({
      runId: 'run',
      userId: 'owner',
      draftJson,
      draftHash: 'approved-digest',
      target: { owner: 'archive-owner', repo: 'archive', baseBranch: 'main' },
    });
    vi.setSystemTime(new Date('2026-07-15T00:00:00.000Z'));
    await store.expireOldRuns();
    await store.failStaleRuns(new Date(Date.now() - 5 * 60_000));
    expect(await store.get('run')).toMatchObject({
      status: 'CREATING_PR',
      draft_json: draftJson,
    });
    expect(await publications.get('run')).toMatchObject({
      outcome: 'requested',
      draft_json: draftJson,
    });
    expect(
      (await publications.listRecoverable()).map((row) => row.run_id),
    ).toEqual(['run']);
  });
});

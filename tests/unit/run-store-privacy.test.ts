import { describe, expect, it } from 'vitest';
import { RunMetricsStore } from '../../src/storage/run-metrics';
import { RunProgressStore } from '../../src/storage/run-progress';
import { RunStore } from '../../src/storage/runs';
import { runStatusSchema } from '../../src/storage/schema';

function database(
  changes = 1,
  firstRow?: Record<string, unknown>,
): {
  db: D1Database;
  statements: string[];
} {
  const statements: string[] = [];
  const db = {
    prepare(sql: string) {
      statements.push(sql);
      return {
        bind() {
          return this;
        },
        async run() {
          return { meta: { changes } };
        },
        async first() {
          return firstRow ?? null;
        },
      };
    },
    async batch(statements: D1PreparedStatement[]) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  } as unknown as D1Database;
  return { db, statements };
}

describe('RunStore terminal-state privacy', () => {
  it('rejects a status outside the domain state machine', () => {
    expect(runStatusSchema.safeParse('UNKNOWN_STATUS').success).toBe(false);
  });

  it('removes user content and interaction credentials on cancellation', async () => {
    const { db, statements } = database();
    expect(await new RunStore(db).cancel('run')).toBe(true);
    expect(statements[0]).toContain('interaction_token = NULL');
    expect(statements[0]).toContain('source_url = NULL');
    expect(statements[0]).toContain('draft_json = NULL');
    expect(statements[0]).toContain('workflow_input_json = NULL');
  });

  it('removes user content and interaction credentials on failure', async () => {
    const { db, statements } = database();
    await new RunStore(db).fail('run', 'ANALYZING', 'FAILED_EXTERNAL', 'test');
    expect(statements[0]).toContain('interaction_token = NULL');
    expect(statements[0]).toContain('source_url = NULL');
    expect(statements[0]).toContain('draft_json = NULL');
    expect(statements[0]).toContain('workflow_input_json = NULL');
  });

  it('removes sensitive data on a generic terminal transition', async () => {
    const { db, statements } = database();
    await new RunStore(db).transition(
      'run',
      'AWAITING_APPROVAL',
      'EXPIRED',
      'approval_timeout',
    );
    expect(statements[0]).toContain('interaction_token = NULL');
    expect(statements[0]).toContain('source_url = NULL');
    expect(statements[0]).toContain('draft_json = NULL');
    expect(statements[0]).toContain('workflow_input_json = NULL');
  });

  it('reports terminal mutation conflicts', async () => {
    const { db } = database(0);
    await expect(
      new RunStore(db).complete('run', 'branch', 'pr'),
    ).resolves.toBe(false);
    await expect(
      new RunStore(db).fail('run', 'ANALYZING', 'FAILED_EXTERNAL', 'test'),
    ).resolves.toBe(false);
  });

  it('guards progress and event writes against terminal states', async () => {
    const { db, statements } = database(0);
    await expect(
      new RunProgressStore(db).progress('run', 'PUBLISHING_PREVIEW', 'done'),
    ).resolves.toBe(false);

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('status IN');
    expect(statements[1]).toContain('status IN');
  });

  it('records active progress and its event in one batch', async () => {
    const { db, statements } = database();
    await expect(
      new RunProgressStore(db).progress('run', 'PUBLISHING_PREVIEW', 'working'),
    ).resolves.toBe(true);

    expect(statements[0]).toContain('UPDATE runs');
    expect(statements[1]).toContain('INSERT INTO run_events');
  });

  it('uses ISO timestamps for monthly cost summaries', async () => {
    const { db, statements } = database(1, {
      run_count: 0,
      completed_count: 0,
      failed_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      estimated_cost_usd: 0,
      max_cost_usd: 0,
    });
    await new RunMetricsStore(db).costSummary('owner');

    expect(statements[0]).toContain(
      "strftime('%Y-%m-01T00:00:00.000Z', 'now')",
    );
    expect(statements[0]).not.toContain("datetime('now', 'start of month')");
    expect(statements[0]).toContain(
      "COALESCE(SUM(CASE WHEN status = 'COMPLETED'",
    );
  });
});

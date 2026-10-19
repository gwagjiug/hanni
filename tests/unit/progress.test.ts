import { describe, expect, it, vi } from 'vitest';
import { formatRunStatus } from '../../src/agent/progress';
import type { RunRow } from '../../src/types';

describe('run progress', () => {
  it('computes elapsed time from the last heartbeat', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T04:10:30.000Z'));
    const row = {
      id: 'run-id',
      status: 'ANALYZING',
      current_step: 'CLASSIFYING_ENTRY',
      last_heartbeat_at: '2026-07-13T04:10:20.000Z',
      updated_at: '2026-07-13T04:10:20.000Z',
      retry_count: 1,
      error_category: null,
      github_pr_url: null,
    } as RunRow;

    const message = formatRunStatus(row, 'running');
    expect(message).toContain('마지막 진행: 10초 전');
    vi.useRealTimers();
  });
});

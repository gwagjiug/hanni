import { describe, expect, it, vi } from 'vitest';
import { formatRunStatus, progressLabel } from '../../src/agent/progress';
import type { RunRow } from '../../src/types';

describe('run progress', () => {
  it('shows a user-facing label for each analysis step', () => {
    expect(progressLabel('FETCHING_METADATA')).toBe('문서 제목 확인');
    expect(progressLabel('CLASSIFYING_ENTRY')).toBe('카테고리와 PR 설명 생성');
  });

  it('includes heartbeat, retry and Workflow state in status output', () => {
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
    expect(message).toContain('카테고리와 PR 설명 생성');
    expect(message).toContain('마지막 진행: 10초 전');
    expect(message).toContain('재시도: 1회');
    expect(message).toContain('Workflow: running');
    vi.useRealTimers();
  });
});

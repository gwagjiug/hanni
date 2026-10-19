import type { RunRow } from '../types';

const stepLabels: Record<string, string> = {
  RECEIVED: '요청 접수',
  VALIDATING: '입력 검증',
  VALIDATING_INPUT: 'URL과 Pin 검증',
  ANALYZING: '분석 시작',
  READING_ARCHIVE: 'archive 저장소 조회',
  FETCHING_METADATA: '문서 제목 확인',
  CLASSIFYING_ENTRY: '카테고리와 PR 설명 생성',
  RENDERING_DRAFT: 'README와 Pin 파일 렌더링',
  PUBLISHING_PREVIEW: 'Discord 미리보기 게시',
  AWAITING_APPROVAL: '사용자 승인 대기',
  CREATING_PR: 'Draft PR 생성',
  REVALIDATING_ARCHIVE: '승인 내용과 최신 archive 검증',
  CREATING_ARCHIVE_COMMIT: 'archive commit 준비',
  ENSURING_ARCHIVE_BRANCH: '실행 전용 브랜치 확인',
  ENSURING_ARCHIVE_PR: '기존 PR 확인과 Draft PR 생성',
  PUBLICATION_RECOVERY: 'PR 생성 결과 확인과 복구 대기',
  COMPLETED: '완료',
  CANCELLED: '취소',
  EXPIRED: '승인 만료',
  FAILED_EXTERNAL: '외부 서비스 오류',
  FAILED_BUDGET: '실행 예산 초과',
  FAILED_TIMEOUT: '실행 중단 감지',
};

export function progressLabel(step: string | null): string {
  return step ? (stepLabels[step] ?? step) : '아직 기록되지 않음';
}

export function formatRunStatus(row: RunRow, workflowStatus?: string): string {
  const lastProgress = row.last_heartbeat_at ?? row.updated_at;
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(lastProgress)) / 1_000),
  );
  const lines = [
    `최근 실행 \`${row.id}\``,
    `상태: **${row.status}**`,
    `현재 작업: ${progressLabel(row.current_step)}`,
    `마지막 진행: ${elapsedSeconds}초 전`,
    `재시도: ${row.retry_count}회`,
  ];
  if (workflowStatus) {
    lines.push(`Workflow: ${workflowStatus}`);
  }
  if (row.error_category) {
    lines.push(`최근 오류: \`${row.error_category}\``);
  }
  if (row.github_pr_url) {
    lines.push(row.github_pr_url);
  }
  return lines.join('\n');
}

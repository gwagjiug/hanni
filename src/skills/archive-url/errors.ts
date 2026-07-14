export function isBudgetFailure(category: string): boolean {
  return category === 'max_cost_exceeded' || category.startsWith('circuit_');
}

export function errorCategory(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.split(':', 1)[0]?.slice(0, 100) ?? 'unknown_error';
}

export function userFacingError(error: unknown): string {
  const category = errorCategory(error);
  if (category === 'archive_duplicate_url') {
    return '이 URL은 archive에 이미 등록되어 있어요.';
  }
  if (category === 'metadata_title_missing') {
    return '문서 제목을 확인하지 못했어요. 현재 MVP에서는 자동 생성을 중단합니다.';
  }
  if (isBudgetFailure(category)) {
    return '실행 제한을 초과해 archive 변경 없이 중단했어요.';
  }
  return `변경안을 준비하지 못했어요. 오류 분류: \`${category}\``;
}

export function approvalFailureMessage(error: unknown): string {
  const category = errorCategory(error);
  if (category === 'pr_created_but_completion_state_conflicted') {
    return (
      'Draft PR은 생성됐지만 Hanni 실행 상태 저장에 실패했어요. ' +
      `GitHub에서 PR을 확인해주세요. 오류 분류: \`${category}\``
    );
  }
  return `PR을 만들지 못했어요. 오류 분류: \`${category}\``;
}

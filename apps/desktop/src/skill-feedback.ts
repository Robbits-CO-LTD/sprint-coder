export const SKILL_CONFLICT_REASONS = {
  nameExists: '同名のSkillが既に存在します。',
  autoSelectionLimit: '自動選択を許可できるSkillは最大32件です。',
  exportExists: '書き出し先に同名のフォルダーがあります。',
} as const;

export function skillActionFailure(action: string, error: unknown, fallback: string): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'NOT_FOUND':
      return `${action}。対象が見つかりません。再読み込みしてください。`;
    case 'OPERATION_CONFLICT': {
      const reason =
        error instanceof Error
          ? Object.values(SKILL_CONFLICT_REASONS).find((message) => message === error.message)
          : undefined;
      return reason === undefined
        ? `${action}。対象が変更されたか、操作の条件を満たしていません。再読み込みしてください。`
        : `${action}。${reason}`;
    }
    case 'FORBIDDEN':
      return `${action}。アクセス権限や保存場所を確認してください。${fallback}`;
    case 'INVALID_REQUEST':
      return `${action}。対象や設定内容を確認してください。${fallback}`;
    default:
      return `${action}。${fallback}`;
  }
}

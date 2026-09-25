import type { TeamDetail } from '../types/sprint-coder';

/**
 * How a retained worktree's recorded integration is named once Main checked it against the
 * Workspace's current history. The retained worktree list and the Worker card use the same words,
 * so they never describe one repository differently (issue #579).
 */
export const RETAINED_WORKTREE_INTEGRATION_LABELS = {
  confirmed: '統合済み（片付けに失敗）',
  unconfirmed: '統合を確認できません（Workspaceの履歴に見つかりません）',
} as const;

/**
 * How many worktrees this Team's Workers left on disk (issue #544): the isolation repositories
 * recorded as `quarantined`. It is read from the Team detail the views already hold, so the count
 * follows every Team update without another IPC call; Main still decides which ones may go.
 */
export function retainedWorktreeCount(detail: TeamDetail | null | undefined): number {
  if (detail == null) return 0;
  let count = 0;
  for (const execution of detail.executions)
    for (const repository of execution.isolation?.repositories ?? [])
      if (repository.state === 'quarantined') count += 1;
  return count;
}

/**
 * Changes whenever anything Main's discard rule reads from the Team detail changes: an execution's
 * state, its isolation phase or resume kind, or a repository's state. The retained worktree list is
 * fetched again then, and not on every streamed Worker output.
 */
export function retainedWorktreesKey(detail: TeamDetail | null | undefined): string {
  if (detail == null) return '';
  return detail.executions
    .filter(({ isolation }) => isolation != null)
    .map(({ id, state, isolation }) =>
      [
        id,
        state,
        isolation?.phase,
        isolation?.resumeKind ?? '',
        ...(isolation?.repositories ?? []).map(
          ({ ordinal, state: repositoryState }) => `${ordinal}:${repositoryState}`,
        ),
      ].join('|'),
    )
    .join(';');
}

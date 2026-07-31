export const OPEN_PROJECT_CONTEXT_EVENT = 'sprint-coder:open-project-context';

export function openProjectContext(taskId: string, turnId: string | null = null): void {
  window.dispatchEvent(new CustomEvent(OPEN_PROJECT_CONTEXT_EVENT, { detail: { taskId, turnId } }));
}

export function isProjectContextRequest(
  value: unknown,
): value is { taskId: string; turnId: string | null } {
  if (typeof value !== 'object' || value === null) return false;
  const detail = value as { taskId?: unknown; turnId?: unknown };
  return (
    typeof detail.taskId === 'string' &&
    (detail.turnId === null || typeof detail.turnId === 'string')
  );
}

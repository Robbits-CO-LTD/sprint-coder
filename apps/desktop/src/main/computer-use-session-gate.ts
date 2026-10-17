/**
 * Whether a Computer Use session may begin in a Task (the controller's `canStartSession`).
 *
 * Three things must hold:
 *   - the Task is not archived. An archived conversation is closed: archiving ends its permission and
 *     drops what a session had copied (`taskClosed`), so a new session must not begin in it (#785
 *     T15-E (5): this check was missing, and an archived Task could start a session and `copy`).
 *     A Task that cannot be read is not one a session may begin in either;
 *   - the Turn that is running is the owner of the start: a panel start (`ownerTurnId` null) needs an
 *     idle Task, and `computer_start`, which runs inside a Turn, needs that Turn to still be the active
 *     one;
 *   - no worker of the Task's team is busy.
 */
export type ComputerUseSessionGateDeps = Readonly<{
  persistence: Readonly<{
    getTask(taskId: string): Readonly<{ archived: boolean }>;
    getActiveTurnId(taskId: string): string | null;
  }>;
  hasBusyWorkers(taskId: string): boolean;
}>;

export function computerUseSessionMayStart(
  deps: ComputerUseSessionGateDeps,
  taskId: string,
  ownerTurnId: string | null,
): boolean {
  try {
    if (deps.persistence.getTask(taskId).archived === true) return false;
  } catch {
    return false;
  }
  return deps.persistence.getActiveTurnId(taskId) === ownerTurnId && !deps.hasBusyWorkers(taskId);
}

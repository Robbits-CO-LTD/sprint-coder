import type { TaskSummary } from '../types/sprint-coder';

export type CreateTaskOptions = {
  /** `false` always makes a new Task. Default: an unstarted Task in the same place is reused. */
  reuseUnstarted?: boolean;
};

/**
 * The unstarted Task that "新規タスク" should open instead of making another empty one.
 *
 * A Task counts as reusable when it sits in the same place (`projectId`; no Project means
 * `null`), has no user message yet (`hasConversation === false`), is not archived, and is not
 * excluded by the caller (for example while its first send is still in flight). The selected
 * Task wins; otherwise the most recently created one.
 */
export function findReusableUnstartedTask(
  tasks: readonly TaskSummary[],
  projectId: string | null,
  selectedTaskId: string | null,
  isExcluded: (taskId: string) => boolean = () => false,
): TaskSummary | null {
  const candidates = tasks.filter(
    (task) =>
      (task.projectId ?? null) === projectId &&
      task.hasConversation === false &&
      !task.archived &&
      !isExcluded(task.id),
  );
  if (candidates.length === 0) return null;
  const selected = candidates.find((task) => task.id === selectedTaskId);
  if (selected !== undefined) return selected;
  return candidates.reduce((newest, task) =>
    task.createdAt > newest.createdAt ||
    (task.createdAt === newest.createdAt && task.id.localeCompare(newest.id) > 0)
      ? task
      : newest,
  );
}

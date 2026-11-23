import type { ProjectSummary, TaskSummary } from '../types/sprint-coder';

type WorkspacePath = Readonly<{ path: string }> | null | undefined;

/** Mirrors Main's effective Workspace fallback without treating a loaded `null` as a root. */
export function hasEffectiveWorkspaceRoot(
  workspace: WorkspacePath,
  legacyTaskPath: string | null | undefined,
  projectFolderCount: number | undefined,
): boolean {
  return Boolean(workspace?.path || legacyTaskPath || (projectFolderCount ?? 0) > 0);
}

export function taskHasEffectiveWorkspaceRoot(
  taskId: string,
  {
    tasks,
    projects,
    workspaceByTask,
  }: {
    tasks: readonly Pick<TaskSummary, 'id' | 'projectId' | 'workspacePath'>[];
    projects: readonly Pick<ProjectSummary, 'id' | 'folderCount'>[];
    workspaceByTask: Readonly<Record<string, WorkspacePath>>;
  },
): boolean {
  const task = tasks.find(({ id }) => id === taskId);
  const project = projects.find(({ id }) => id === task?.projectId);
  const workspace = workspaceByTask[taskId];
  return hasEffectiveWorkspaceRoot(
    workspace,
    workspace === undefined ? task?.workspacePath : null,
    project?.folderCount,
  );
}

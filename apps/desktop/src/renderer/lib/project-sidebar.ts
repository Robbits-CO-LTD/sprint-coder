import type { ProjectSummary, TaskSummary } from '../types/sprint-coder';

export type ProjectSidebarGroup = {
  project: ProjectSummary;
  tasks: TaskSummary[];
  archivedTasks: TaskSummary[];
  forceExpanded: boolean;
  forceArchivedExpanded: boolean;
};

export type ProjectSidebarProjection = {
  activeProjects: ProjectSidebarGroup[];
  unassignedTasks: TaskSummary[];
  unassignedArchivedTasks: TaskSummary[];
  archivedProjects: ProjectSidebarGroup[];
  forceUnassignedArchivedExpanded: boolean;
  forceArchivedProjectsExpanded: boolean;
};

function byTaskOrder(a: TaskSummary, b: TaskSummary): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? -1 : 1;
  return a.id.localeCompare(b.id);
}

function byProjectOrder(a: ProjectSummary, b: ProjectSummary): number {
  if (a.lastActivityAt !== b.lastActivityAt) return a.lastActivityAt > b.lastActivityAt ? -1 : 1;
  return a.id.localeCompare(b.id);
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/** Pure sidebar projection. Expansion preferences stay outside this function: search and the
 * selected Task only return temporary `force*` flags and therefore never overwrite user choices. */
export function projectSidebarProjection(
  projects: readonly ProjectSummary[],
  tasks: readonly TaskSummary[],
  query: string,
  selectedTaskId: string | null,
): ProjectSidebarProjection {
  const q = normalized(query);
  const isSearching = q !== '';
  const taskMatches = (task: TaskSummary): boolean => normalized(task.title).includes(q);
  const taskVisibleInSearch = (task: TaskSummary, projectMatches: boolean): boolean =>
    !isSearching || projectMatches || taskMatches(task) || task.id === selectedTaskId;

  const tasksByProject = new Map<string, TaskSummary[]>();
  for (const task of tasks) {
    if (task.projectId === null) continue;
    const current = tasksByProject.get(task.projectId) ?? [];
    current.push(task);
    tasksByProject.set(task.projectId, current);
  }

  const groups = [...projects].sort(byProjectOrder).flatMap((project) => {
    const projectMatches = isSearching && normalized(project.name).includes(q);
    const allTasks = tasksByProject.get(project.id) ?? [];
    const selectedDescendant = allTasks.some((task) => task.id === selectedTaskId);
    const visible = allTasks.filter((task) => taskVisibleInSearch(task, projectMatches));
    const matchingDescendant = isSearching && visible.some(taskMatches);
    if (isSearching && !projectMatches && !matchingDescendant && !selectedDescendant) return [];
    const activeTasks = visible.filter((task) => !task.archived).sort(byTaskOrder);
    const archivedTasks = visible.filter((task) => task.archived).sort(byTaskOrder);
    return [
      {
        project,
        tasks: activeTasks,
        archivedTasks,
        forceExpanded: selectedDescendant || projectMatches || matchingDescendant,
        forceArchivedExpanded:
          archivedTasks.some((task) => task.id === selectedTaskId) ||
          (isSearching && archivedTasks.some((task) => projectMatches || taskMatches(task))),
      },
    ];
  });

  const unassigned = tasks.filter((task) => task.projectId === null);
  // An empty DB Task is normally implementation scaffolding, not history. A Project is an explicit
  // organizing action and therefore shows its empty Tasks; only unassigned empty Tasks stay hidden.
  const visibleUnassigned = unassigned.filter(
    (task) =>
      (task.hasConversation !== false || task.id === selectedTaskId) &&
      (!isSearching || taskMatches(task) || task.id === selectedTaskId),
  );
  const unassignedTasks = visibleUnassigned.filter((task) => !task.archived).sort(byTaskOrder);
  const unassignedArchivedTasks = visibleUnassigned
    .filter((task) => task.archived)
    .sort(byTaskOrder);

  const activeProjects = groups.filter(({ project }) => !project.archived);
  const archivedProjects = groups.filter(({ project }) => project.archived);
  return {
    activeProjects,
    unassignedTasks,
    unassignedArchivedTasks,
    archivedProjects,
    forceUnassignedArchivedExpanded:
      unassignedArchivedTasks.some((task) => task.id === selectedTaskId) ||
      (isSearching && unassignedArchivedTasks.some(taskMatches)),
    forceArchivedProjectsExpanded:
      archivedProjects.some(({ forceExpanded }) => forceExpanded) ||
      (isSearching && archivedProjects.length > 0),
  };
}

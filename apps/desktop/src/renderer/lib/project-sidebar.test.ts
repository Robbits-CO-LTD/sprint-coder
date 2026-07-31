import { describe, expect, it } from 'vitest';
import type { ProjectSummary, TaskSummary } from '../types/sprint-coder';
import { projectSidebarProjection } from './project-sidebar';

const project = (overrides: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id: 'project-a',
  name: 'Alpha',
  archived: false,
  revision: 0,
  taskCount: 0,
  lastActivityAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const task = (overrides: Partial<TaskSummary> = {}): TaskSummary => ({
  id: 'task-a',
  projectId: null,
  title: 'First task',
  pinned: false,
  archived: false,
  goal: null,
  workspacePath: null,
  localOnly: false,
  hasConversation: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('projectSidebarProjection', () => {
  it('orders Projects by activity and Tasks by pin, recency and id', () => {
    const result = projectSidebarProjection(
      [
        project({ id: 'older', lastActivityAt: '2026-01-01T00:00:00.000Z' }),
        project({ id: 'newer', lastActivityAt: '2026-01-02T00:00:00.000Z' }),
      ],
      [
        task({ id: 'b', projectId: 'newer', updatedAt: '2026-01-03T00:00:00.000Z' }),
        task({ id: 'a', projectId: 'newer', updatedAt: '2026-01-03T00:00:00.000Z' }),
        task({ id: 'pinned', projectId: 'newer', pinned: true }),
      ],
      '',
      null,
    );
    expect(result.activeProjects.map(({ project }) => project.id)).toEqual(['newer', 'older']);
    expect(result.activeProjects[0]?.tasks.map(({ id }) => id)).toEqual(['pinned', 'a', 'b']);
  });

  it('shows empty Tasks inside a Project but hides unassigned empty Tasks unless selected', () => {
    const emptyProjectTask = task({ id: 'inside', projectId: 'project-a', hasConversation: false });
    const emptyLooseTask = task({ id: 'loose', hasConversation: false });
    const result = projectSidebarProjection(
      [project()],
      [emptyProjectTask, emptyLooseTask],
      '',
      null,
    );
    expect(result.activeProjects[0]?.tasks.map(({ id }) => id)).toEqual(['inside']);
    expect(result.unassignedTasks).toEqual([]);
    expect(
      projectSidebarProjection([], [emptyLooseTask], '', 'loose').unassignedTasks,
    ).toHaveLength(1);
  });

  it('shows every child for a Project-name match and only matching Tasks otherwise', () => {
    const tasks = [
      task({ id: 'one', projectId: 'project-a', title: 'Compile docs' }),
      task({ id: 'two', projectId: 'project-a', title: 'Ship build' }),
    ];
    expect(
      projectSidebarProjection([project()], tasks, 'alpha', null).activeProjects[0]?.tasks,
    ).toHaveLength(2);
    const taskMatch = projectSidebarProjection([project()], tasks, 'compile', null);
    expect(taskMatch.activeProjects[0]?.tasks.map(({ id }) => id)).toEqual(['one']);
  });

  it('temporarily expands search and selected ancestors, including archived disclosures', () => {
    const archivedTask = task({
      id: 'archived-task',
      projectId: 'archived-project',
      archived: true,
      title: 'Needle',
    });
    const result = projectSidebarProjection(
      [project({ id: 'archived-project', archived: true })],
      [archivedTask],
      'needle',
      'archived-task',
    );
    expect(result.forceArchivedProjectsExpanded).toBe(true);
    expect(result.archivedProjects[0]).toMatchObject({
      forceExpanded: true,
      forceArchivedExpanded: true,
    });
  });
});

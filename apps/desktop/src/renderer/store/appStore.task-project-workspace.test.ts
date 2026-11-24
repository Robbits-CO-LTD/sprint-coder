import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskSummary } from '../types/sprint-coder';
import { taskHasEffectiveWorkspaceRoot } from '../lib/effective-workspace-root';
import { useAppStore } from './appStore';

const task: TaskSummary = {
  id: 'task-a',
  projectId: null,
  title: '新しいタスク',
  pinned: false,
  archived: false,
  goal: null,
  goalState: null,
  workspacePath: 'C:\\old-workspace',
  localOnly: false,
  hasConversation: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const oldWorkspace = { path: 'C:\\old-workspace', name: 'old-workspace' };

afterEach(() => vi.unstubAllGlobals());

describe('Task workspace after Project reassignment', () => {
  it('shows the folder picker when a Task moves to a Project with no folders', async () => {
    const projectId = 'empty-project';
    const updated = { ...task, projectId };
    const assignTask = vi.fn().mockResolvedValue(updated);
    const getWorkspace = vi.fn().mockResolvedValue(null);
    vi.stubGlobal('window', {
      sprintCoder: { projects: { assignTask }, workspace: { get: getWorkspace } },
    });
    useAppStore.setState({
      tasks: [task],
      projects: [],
      selectedTaskId: task.id,
      workspaceByTask: { [task.id]: oldWorkspace },
    });
    expect(taskHasEffectiveWorkspaceRoot(task.id, useAppStore.getState())).toBe(true);

    expect(await useAppStore.getState().assignTaskToProject(task.id, projectId)).toBe(updated);

    expect(taskHasEffectiveWorkspaceRoot(task.id, useAppStore.getState())).toBe(false);
    expect(getWorkspace).toHaveBeenCalledWith(task.id);
  });

  it('restores the standalone workspace after leaving a Project, even with an older read pending', async () => {
    const projectId = 'empty-project';
    const updated = { ...task, projectId };
    const assignTask = vi.fn().mockResolvedValue(updated);
    const unassignTask = vi.fn().mockResolvedValue(task);
    let finishOldProjectRead!: (workspace: null) => void;
    const oldProjectRead = new Promise<null>((resolve) => (finishOldProjectRead = resolve));
    const getWorkspace = vi
      .fn()
      .mockReturnValueOnce(oldProjectRead)
      .mockResolvedValueOnce(oldWorkspace);
    vi.stubGlobal('window', {
      sprintCoder: { projects: { assignTask, unassignTask }, workspace: { get: getWorkspace } },
    });
    useAppStore.setState({
      tasks: [task],
      projects: [],
      selectedTaskId: 'another-task',
      workspaceByTask: { [task.id]: oldWorkspace },
    });

    const moving = useAppStore.getState().assignTaskToProject(task.id, projectId);
    await vi.waitFor(() => expect(getWorkspace).toHaveBeenCalledOnce());
    expect(taskHasEffectiveWorkspaceRoot(task.id, useAppStore.getState())).toBe(false);

    await useAppStore.getState().unassignTaskFromProject(task.id);
    finishOldProjectRead(null);
    await moving;

    expect(getWorkspace).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().workspaceByTask[task.id]).toEqual(oldWorkspace);
    expect(taskHasEffectiveWorkspaceRoot(task.id, useAppStore.getState())).toBe(true);
  });
});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { TaskSummary } from '../../types/sprint-coder';
import { useAppStore, type WorkspaceInfo } from '../../store/appStore';
import { WorkspaceFolderButton } from './WorkspaceFolderButton';

it('discards a folder selection made before the Task moved to a Project and back', async () => {
  const now = '2026-01-01T00:00:00.000Z';
  const task: TaskSummary = {
    id: 'task-a',
    projectId: null,
    title: 'Task',
    pinned: false,
    archived: false,
    goal: null,
    goalState: null,
    workspacePath: null,
    localOnly: false,
    hasConversation: false,
    createdAt: now,
    updatedAt: now,
  };
  const targetProjectId = 'empty-project';
  const selection = { path: '/old-workspace', name: 'old-workspace' };
  let finishSelection!: (value: WorkspaceInfo) => void;
  const pending = new Promise<WorkspaceInfo>((resolve) => (finishSelection = resolve));
  const select = vi.fn().mockReturnValue(pending);
  const previous = useAppStore.getState();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('sprintCoder', {
    projects: {
      assignTask: vi.fn().mockResolvedValue({ ...task, projectId: targetProjectId }),
      unassignTask: vi.fn().mockResolvedValue(task),
    },
    workspace: { get: vi.fn().mockResolvedValue(null), select },
  });
  const rootElement = document.createElement('div');
  const root = createRoot(rootElement);
  try {
    useAppStore.setState({
      tasks: [task],
      projects: [],
      workspaceByTask: { [task.id]: null },
    });
    await act(async () => root.render(<WorkspaceFolderButton taskId={task.id} />));
    await act(async () => rootElement.querySelector('button')!.click());
    expect(select).toHaveBeenCalledWith(task.id);

    await act(async () => {
      await useAppStore.getState().assignTaskToProject(task.id, targetProjectId);
      await useAppStore.getState().unassignTaskFromProject(task.id);
      finishSelection(selection);
    });

    expect(useAppStore.getState().workspaceByTask[task.id]).toBeNull();
  } finally {
    await act(async () => root.unmount());
    useAppStore.setState(previous);
    vi.unstubAllGlobals();
  }
});

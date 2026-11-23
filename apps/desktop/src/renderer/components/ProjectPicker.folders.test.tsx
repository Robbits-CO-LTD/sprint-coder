// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useAppStore } from '../store/appStore';
import type { ProjectSummary, TaskSummary } from '../types/sprint-coder';
import { ProjectPicker } from './ProjectPicker';

const now = '2026-11-23T00:00:00.000Z';
const project: ProjectSummary = {
  id: 'project-1',
  name: 'Empty Project',
  archived: false,
  revision: 1,
  taskCount: 1,
  folderCount: 0,
  primaryFolder: null,
  lastActivityAt: now,
  createdAt: now,
  updatedAt: now,
};
const task: TaskSummary = {
  id: 'task-1',
  title: 'Existing Task',
  projectId: project.id,
  pinned: false,
  archived: false,
  goal: null,
  goalState: null,
  workspacePath: null,
  localOnly: false,
  hasConversation: true,
  activeTurnId: null,
  runningWork: null,
  createdAt: now,
  updatedAt: now,
};

it.each(['create', 'task', 'list'] as const)(
  'shows the Project folder warning and opens the right editor from %s',
  async (entry) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const showModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true;
      },
    });
    const previous = useAppStore.getState();
    const assignTask = vi.fn();
    const createTask = vi.fn();
    const listProjectFolders = vi.fn().mockResolvedValue([]);
    const configuredProject: ProjectSummary = {
      ...project,
      id: 'project-2',
      name: 'Configured Project',
      folderCount: 1,
      primaryFolder: { id: 'root-2', path: '/workspace', label: 'workspace' },
    };
    const currentProject = entry === 'list' ? configuredProject : project;
    useAppStore.setState({
      tasks: [{ ...task, projectId: currentProject.id }],
      projects: [project, configuredProject],
      assignTaskToProject: assignTask,
      createTask,
      listProjectFolders,
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    function findButton(label: string) {
      return [...container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === label,
      );
    }
    try {
      await act(async () => root.render(<ProjectPicker taskId={task.id} />));
      if (entry !== 'task') {
        await act(async () => findButton(currentProject.name)?.click());
      }
      if (entry === 'create') {
        await act(async () => findButton('新しいProject')?.click());
        expect(container.querySelector('dialog[open] h2')?.textContent).toBe('新しいProject');
        expect(
          container.querySelector('dialog[open] .project-folders-empty')?.textContent,
        ).toContain('ファイルの読み書きやコマンドの実行はできません');
      } else {
        const action =
          entry === 'task'
            ? findButton('フォルダー未設定・追加')
            : container.querySelector<HTMLButtonElement>(
                '[aria-label="Empty Projectにフォルダーを追加"]',
              );
        if (entry === 'list')
          expect(container.querySelector('[aria-label="Project一覧"] small')?.textContent).toBe(
            'フォルダー未設定',
          );
        expect(action).toBeTruthy();
        await act(async () => action?.click());
        expect(container.querySelector('dialog[open] h2')?.textContent).toBe('Projectを編集');
        expect(container.querySelector<HTMLInputElement>('dialog[open] input')?.value).toBe(
          project.name,
        );
        expect(listProjectFolders).toHaveBeenCalledWith(project.id);
      }
      expect(assignTask).not.toHaveBeenCalled();
      expect(createTask).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      useAppStore.setState(previous, true);
      if (showModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', showModal);
      else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
      vi.unstubAllGlobals();
    }
  },
);

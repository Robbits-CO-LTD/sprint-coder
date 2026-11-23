// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAppStore } from '../../store/appStore';
import type { ProjectSummary, TaskSummary } from '../../types/sprint-coder';
import { Timeline } from './Timeline';

const now = '2026-11-23T00:00:00.000Z';
const task: TaskSummary = {
  id: 'task-1',
  projectId: null,
  title: 'New Task',
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
const initial = useAppStore.getState();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useAppStore.setState(initial, true);
  vi.unstubAllGlobals();
});

function button(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === text,
  );
}

it('offers conversation starters and lets the Task choose its own folder', async () => {
  const select = vi.fn().mockResolvedValue({ path: '/workspace', name: 'workspace' });
  vi.stubGlobal('sprintCoder', { tasks: {}, workspace: { select } });
  useAppStore.setState({
    tasks: [task],
    commandSandbox: { available: true, backend: 'sandbox', reason: null, probedAt: now },
  });
  await act(async () => root.render(<Timeline taskId={task.id} />));

  expect(container.textContent).toContain('作業フォルダーを選ぶと、ファイルとコマンドを使えます');
  expect(container.textContent).not.toContain('このリポジトリの構成を教えて');
  await act(async () => button('仕事の優先順位を整理する方法を教えて')?.click());
  expect(useAppStore.getState().draftByTask[task.id]).toBe('仕事の優先順位を整理する方法を教えて');

  await act(async () => button('作業フォルダーを選ぶ')?.click());
  expect(select).toHaveBeenCalledExactlyOnceWith(task.id);
  expect(container.textContent).toContain('このリポジトリの構成を教えて');
  expect(button('作業フォルダーを選ぶ')).toBeUndefined();
});

it('opens the current Project editor when its Task needs a folder', async () => {
  const select = vi.fn();
  vi.stubGlobal('sprintCoder', { workspace: { select } });
  const showModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  const listProjectFolders = vi.fn().mockResolvedValue([]);
  useAppStore.setState({
    tasks: [{ ...task, projectId: project.id }],
    projects: [project],
    listProjectFolders,
  });
  try {
    await act(async () => root.render(<Timeline taskId={task.id} />));
    await act(async () => button('作業フォルダーを選ぶ')?.click());
    expect(container.querySelector('dialog[open] h2')?.textContent).toBe('Projectを編集');
    expect(listProjectFolders).toHaveBeenCalledExactlyOnceWith(project.id);
    expect(select).not.toHaveBeenCalled();
  } finally {
    if (showModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', showModal);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  }
});

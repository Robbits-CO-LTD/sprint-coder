// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar, TaskActivityIndicator, TaskRow } from './Sidebar';
import { TaskBoundaryProvider } from './TaskBoundary';
import { useAppStore } from '../store/appStore';
import type { ApprovalSummary, TaskSummary } from '../types/sprint-coder';

const task: TaskSummary = {
  id: 'task-1',
  projectId: null,
  title: 'ログイン画面を直す',
  pinned: false,
  archived: false,
  goal: null,
  goalState: null,
  workspacePath: null,
  localOnly: false,
  hasConversation: true,
  activeTurnId: null,
  runningWork: null,
  createdAt: '2026-11-14T00:00:00.000Z',
  updatedAt: '2026-11-14T00:00:00.000Z',
};

const runningTurn = {
  turnId: 'turn-1',
  status: 'running' as const,
  stage: 'executing' as const,
  runtimeStarting: false,
  reachedStageIndex: 2,
  startedAt: 0,
  streamingMessageId: null,
  streamingContent: '',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  useAppStore.setState({
    tasks: [],
    projects: [],
    projectLoadState: 'ready',
    selectedTaskId: null,
    turnByTask: {},
    approvalsByTask: {},
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useAppStore.setState({
    tasks: [],
    projects: [],
    selectedTaskId: null,
    turnByTask: {},
    approvalsByTask: {},
  });
  vi.unstubAllGlobals();
});

async function renderSidebar(createTask = vi.fn(async () => null)) {
  await act(async () =>
    root.render(
      <TaskBoundaryProvider value={{ selectTask: vi.fn(async () => true), createTask }}>
        <Sidebar />
      </TaskBoundaryProvider>,
    ),
  );
  return createTask;
}

async function search(value: string) {
  const input = container.querySelector<HTMLInputElement>('.sb-search input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return input;
}

describe('the sidebar with nothing to list', () => {
  it('says there is no Task yet and points at the key that starts one', async () => {
    const createTask = await renderSidebar();
    const empty = container.querySelector('.sb-empty')!;
    expect(empty.textContent).toBe('Taskはまだありません「新規タスク」から始められます。');
    // No second button for it: the key the hint names is the one in the panel.
    expect(empty.querySelector('button')).toBeNull();
    const key = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-new-task-button"]',
    )!;
    expect(key.textContent).toBe(' 新規タスク');
    await act(async () => key.click());
    expect(createTask).toHaveBeenCalledExactlyOnceWith();
  });

  it('tells a search that found nothing from an empty history, and clears the search', async () => {
    useAppStore.setState({ tasks: [task] });
    await renderSidebar();
    expect(container.querySelector('[data-task-id="task-1"]')).not.toBeNull();

    const input = await search('見つからない');
    expect(container.querySelector('[data-task-id="task-1"]')).toBeNull();
    const empty = container.querySelector('.sb-empty')!;
    expect(empty.getAttribute('role')).toBe('status');
    expect(empty.textContent).toContain('一致するProject・Taskはありません');
    expect(empty.textContent).not.toContain('Taskはまだありません');

    const clear = [...empty.querySelectorAll('button')].find(
      (button) => button.textContent === '検索をクリア',
    )!;
    await act(async () => clear.click());
    expect(input.value).toBe('');
    expect(container.querySelector('[data-task-id="task-1"]')).not.toBeNull();
  });
});

describe('a Task row’s end column', () => {
  const approval = { id: 'approval-1' } as ApprovalSummary;

  async function renderRow(row: TaskSummary, selected: boolean) {
    await act(async () =>
      root.render(
        <TaskRow
          task={row}
          selectedTaskId={selected ? row.id : 'other'}
          onSelect={vi.fn()}
          canManage
          canMove={false}
          activeProjects={[]}
          onMove={vi.fn()}
          onTogglePin={vi.fn()}
          onToggleArchive={vi.fn()}
        />,
      ),
    );
  }

  it('says the selected Task waits for an approval, in a different shape from running', async () => {
    useAppStore.setState({
      turnByTask: { 'task-1': runningTurn },
      approvalsByTask: { 'task-1': [approval] },
    });
    await renderRow(task, true);
    expect(container.querySelector('[aria-label="承認待ち"]')?.getAttribute('role')).toBe('status');
    expect(container.querySelector('[aria-label="実行中"]')).toBeNull();
    // The answer is given: the Turn runs again.
    await act(async () => useAppStore.setState({ approvalsByTask: { 'task-1': [] } }));
    expect(container.querySelector('[aria-label="承認待ち"]')).toBeNull();
    expect(container.querySelector('[aria-label="実行中"]')).not.toBeNull();
  });

  it('does not say so for a Task that is not selected: its approvals are not followed', async () => {
    // What is left in the store from when the Task was last open may be answered since.
    useAppStore.setState({ approvalsByTask: { 'task-1': [approval] } });
    await renderRow({ ...task, activeTurnId: 'turn-1' }, false);
    expect(container.querySelector('[aria-label="承認待ち"]')).toBeNull();
    expect(container.querySelector('[aria-label="実行中"]')).not.toBeNull();
  });

  it('does not say a finished Turn waits', async () => {
    useAppStore.setState({
      turnByTask: { 'task-1': { ...runningTurn, status: 'completed' } },
      approvalsByTask: { 'task-1': [approval] },
    });
    await renderRow(task, true);
    expect(container.querySelector('[aria-label="承認待ち"]')).toBeNull();
    expect(container.querySelector('[aria-label="完了"]')).not.toBeNull();
  });

  it('keeps the title the row button’s whole name, with pin and 未開始 beside it', async () => {
    await renderRow({ ...task, pinned: true, hasConversation: false }, false);
    const button = container.querySelector<HTMLButtonElement>('.sb-item')!;
    expect(button.querySelector('.sb-item-title')?.textContent).toBe('ログイン画面を直す');
    expect(button.querySelector('.sb-item-meta')?.textContent).toBe('未開始');
    expect(button.querySelector('.sb-item-meta svg')).not.toBeNull();
  });

  it('draws waiting as its own mark', () => {
    const markup = renderToStaticMarkup(<TaskActivityIndicator activity="waiting" />);
    expect(markup).toContain('sb-task-activity--waiting');
    expect(markup).toContain('aria-label="承認待ち"');
  });
});

// The contrast audit (lib/contrast.test.ts) is over tokens. A literal colour here would pass it
// unseen, so the panel's stylesheet may name colours by token only.
describe('sidebar.css', () => {
  const css = readFileSync(join(__dirname, '..', 'sidebar.css'), 'utf8');

  it('names every colour by token', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });

  it('leaves nothing transformed after a list opens, so the menus’ fixed popovers stay put', () => {
    // A transformed ancestor becomes the containing block of a `position: fixed` descendant.
    const open = /@keyframes sb-open\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(open).toContain('from');
    expect(open).not.toMatch(/\bto\b\s*\{/);
    const tasks = /\.sb-project-tasks\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(tasks).toMatch(/animation:\s*sb-open/);
    expect(tasks).not.toMatch(/forwards|both/);
  });

  it('stops the running ring for people who asked for less motion', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1];
    expect(reduced).toContain('.sb-task-activity--running');
    expect(reduced).toMatch(/animation:\s*none/);
  });
});

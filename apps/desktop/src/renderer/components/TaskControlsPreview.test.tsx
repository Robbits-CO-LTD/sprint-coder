// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Composer } from './ChatSurface/Composer';
import { TaskHeader } from './TaskHeader';
import { useAppStore } from '../store/appStore';
import type { ApprovalSummary, TaskSummary } from '../types/sprint-coder';

const initial = useAppStore.getInitialState();
const task: TaskSummary = {
  id: 'task-1',
  title: 'UIを整える',
  projectId: null,
  pinned: false,
  archived: false,
  goal: null,
  goalState: null,
  workspacePath: null,
  localOnly: true,
  createdAt: '',
  updatedAt: '',
};
const node = document.createElement('div');
document.body.append(node);
let root = createRoot(node);

afterEach(async () => {
  await act(async () => root.unmount());
  useAppStore.setState(initial, true);
  Reflect.deleteProperty(window, 'sprintCoder');
  document.querySelectorAll('.timeline-scroll').forEach((timeline) => timeline.remove());
  vi.unstubAllGlobals();
  root = createRoot(node);
});

const testId = <T extends HTMLElement>(value: string) =>
  node.querySelector<T>('[data-testid="' + value + '"]');

it('shows Task activity and focuses the matching Task approval, not another Task', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const turn = {
    turnId: 'turn-1',
    status: 'running' as const,
    stage: 'executing' as const,
    runtimeStarting: false,
    reachedStageIndex: 2,
    startedAt: 0,
    streamingMessageId: null,
    streamingContent: '',
  };
  useAppStore.setState({ turnByTask: { [task.id]: turn } });
  await act(async () => root.render(<TaskHeader task={task} onToggleTeam={() => undefined} />));
  expect(node.querySelector('[role="status"]')?.textContent).toBe('作業中');
  const addApproval = (id: string) => {
    const timeline = document.createElement('div');
    timeline.className = 'timeline-scroll';
    timeline.dataset.taskId = id;
    const card = document.createElement('div');
    card.dataset.testid = 'approval-card';
    card.tabIndex = -1;
    card.scrollIntoView = vi.fn();
    timeline.append(card);
    document.body.append(timeline);
    return card;
  };
  const other = addApproval('other-task');
  const current = addApproval(task.id);
  const approval = { id: 'approval-1' } as ApprovalSummary;
  await act(async () => useAppStore.setState({ approvalsByTask: { [task.id]: [approval] } }));
  expect(node.querySelector('[role="status"]')?.textContent).toBe('承認待ち');
  await act(async () => testId<HTMLButtonElement>('task-header-approval')?.click());
  expect(current.scrollIntoView).toHaveBeenCalledOnce();
  expect(other.scrollIntoView).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(current);
  await act(async () =>
    useAppStore.setState({
      approvalsByTask: {},
      turnByTask: { [task.id]: { ...turn, status: 'completed' } },
    }),
  );
  expect(node.querySelector('[role="status"]')?.textContent).toBe('完了');
});

it.each([false, true])(
  'shows Effort only inside the selected Model picker (V2: %s)',
  async (enabled) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const setCodexEffort = vi.fn(async () => {});
    const selection = {
      connectionId: 'builtin:codex-cli',
      requestedProvider: 'openai',
      requestedModel: 'sample',
    };
    Object.defineProperty(window, 'sprintCoder', {
      configurable: true,
      value: {
        settings: { setModel: vi.fn(), setCodexEffort: vi.fn() },
        models: {
          query: vi.fn(async () => ({
            revision: 1,
            total: 0,
            items: [],
            nextCursor: null,
            selection,
            multiProviderModelPickerV2: true,
          })),
        },
      },
    });
    useAppStore.setState({
      selectedTaskId: task.id,
      tasks: [task],
      modelPicker: { taskId: task.id, enabled, selection },
      setCodexEffort,
      runtime: {
        ...initial.runtime,
        kind: 'codex',
        codexReadiness: 'ready',
        model: 'sample',
        codexEffort: 'medium',
        models: [
          {
            id: 'sample',
            displayName: 'Sample',
            description: '',
            defaultEffort: 'medium',
            efforts: [
              { id: 'medium', description: 'Standard' },
              { id: 'high', description: 'Deeper' },
            ],
          },
        ],
      },
    });
    await act(async () => root.render(<Composer taskId={task.id} />));
    expect(testId('effort-selector')).toBeNull();
    await act(async () =>
      testId<HTMLButtonElement>(enabled ? 'model-picker-v2-trigger' : 'model-selector')?.click(),
    );
    const effort = testId<HTMLSelectElement>('effort-selector')!;
    expect(effort.value).toBe('medium');
    await act(async () => {
      effort.value = 'high';
      effort.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(setCodexEffort).toHaveBeenCalledExactlyOnceWith('high');
  },
);

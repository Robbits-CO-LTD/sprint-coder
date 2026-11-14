import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskSummary } from '../types/sprint-coder';
import { useAppStore } from './appStore';

const task = (overrides: Partial<TaskSummary> = {}): TaskSummary => ({
  id: 'task-a',
  projectId: null,
  title: '新しいタスク',
  pinned: false,
  archived: false,
  goal: null,
  goalState: null,
  workspacePath: null,
  localOnly: false,
  hasConversation: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

function stubCreate(created: TaskSummary) {
  const create = vi.fn().mockResolvedValue(created);
  vi.stubGlobal('window', { localStorage: null, sprintCoder: { tasks: { create } } });
  return create;
}

const originalSelectTask = useAppStore.getState().selectTask;
// Selection loads messages, the workspace and more over IPC; here only "which Task" matters.
const selectTask = vi.fn(async (taskId: string) => {
  useAppStore.setState({ selectedTaskId: taskId });
});

beforeEach(() => {
  selectTask.mockClear();
  useAppStore.setState({
    selectTask,
    tasks: [],
    selectedTaskId: null,
    draftByTask: {},
    sendingByTask: {},
    pendingOptimisticIdByTask: {},
    error: null,
  });
});

afterEach(() => {
  useAppStore.setState({ selectTask: originalSelectTask });
  vi.unstubAllGlobals();
});

describe('createTask reuses an unstarted Task', () => {
  it('opens the unstarted Task in the same place without creating one, keeping its draft', async () => {
    const empty = task({ id: 'empty', title: '手で付けた題', workspacePath: 'C:\\work' });
    useAppStore.setState({
      tasks: [empty],
      selectedTaskId: 'empty',
      draftByTask: { empty: '書きかけ' },
    });
    const create = stubCreate(task({ id: 'fresh' }));

    const result = await useAppStore.getState().createTask();

    expect(result).toBe(empty);
    expect(create).not.toHaveBeenCalled();
    expect(selectTask).not.toHaveBeenCalled();
    expect(useAppStore.getState()).toMatchObject({
      tasks: [empty],
      selectedTaskId: 'empty',
      draftByTask: { empty: '書きかけ' },
    });
  });

  it('selects a hidden unstarted Task rather than creating another one', async () => {
    const started = task({ id: 'started', hasConversation: true });
    const empty = task({ id: 'empty' });
    useAppStore.setState({ tasks: [started, empty], selectedTaskId: 'started' });
    const create = stubCreate(task({ id: 'fresh' }));

    const result = await useAppStore.getState().createTask();

    expect(result).toBe(empty);
    expect(create).not.toHaveBeenCalled();
    expect(selectTask).toHaveBeenCalledWith('empty');
  });

  it('creates a Task once the conversation has started', async () => {
    useAppStore.setState({
      tasks: [task({ id: 'started', hasConversation: true })],
      selectedTaskId: 'started',
    });
    const create = stubCreate(task({ id: 'fresh' }));

    const result = await useAppStore.getState().createTask();

    expect(create).toHaveBeenCalledOnce();
    expect(result?.id).toBe('fresh');
    expect(selectTask).toHaveBeenCalledWith('fresh');
  });

  it('does not reuse an archived unstarted Task', async () => {
    useAppStore.setState({ tasks: [task({ id: 'archived', archived: true })] });
    const create = stubCreate(task({ id: 'fresh' }));

    await useAppStore.getState().createTask();

    expect(create).toHaveBeenCalledOnce();
  });

  it('creates a Task while the unstarted Task is still sending its first message', async () => {
    useAppStore.setState({
      tasks: [task({ id: 'sending' })],
      selectedTaskId: 'sending',
      sendingByTask: { sending: true },
    });
    const create = stubCreate(task({ id: 'fresh' }));

    await useAppStore.getState().createTask();

    expect(create).toHaveBeenCalledOnce();
  });

  it('always creates a Task when reuse is turned off', async () => {
    useAppStore.setState({ tasks: [task({ id: 'empty' })], selectedTaskId: 'empty' });
    const create = stubCreate(task({ id: 'fresh' }));

    const result = await useAppStore.getState().createTask(undefined, { reuseUnstarted: false });

    expect(create).toHaveBeenCalledWith({});
    expect(useAppStore.getState().error).toBeNull();
    expect(result?.id).toBe('fresh');
    expect(useAppStore.getState().tasks.map(({ id }) => id)).toEqual(['fresh', 'empty']);
  });

  it('creates a Task in another Project even when an unassigned one is unstarted', async () => {
    useAppStore.setState({ tasks: [task({ id: 'loose' })], selectedTaskId: 'loose' });
    const create = stubCreate(task({ id: 'fresh', projectId: 'project-a' }));
    vi.stubGlobal('window', {
      localStorage: null,
      sprintCoder: { tasks: { create }, projects: { list: vi.fn().mockResolvedValue([]) } },
    });

    await useAppStore.getState().createTask('project-a');

    expect(create).toHaveBeenCalledWith({ projectId: 'project-a' });
  });
});

// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore, type TurnStatus } from '../store/appStore';
import type { TaskSummary, TeamDetail, WorkerSummary } from '../types/sprint-coder';
import { TeamListView } from './TeamListView';
import { TeamCanvas } from './TeamCanvas/TeamCanvas';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const task: TaskSummary = {
  id: 'task-stop-all',
  projectId: null,
  title: 'Stop all',
  pinned: false,
  archived: false,
  goal: null,
  goalState: null,
  workspacePath: null,
  localOnly: true,
  createdAt: '2026-10-27T00:00:00Z',
  updatedAt: '2026-10-27T00:00:00Z',
};

function worker(id: string, state: WorkerSummary['state']): WorkerSummary {
  return {
    id,
    teamId: 'team-stop-all',
    threadId: `thread-${id}`,
    taskId: task.id,
    kind: 'worker',
    role: id,
    state,
    objective: 'Stop fixture',
    writeCapable: false,
    currentActivity: null,
    engine: 'mock',
    connectionId: null,
    requestedProvider: null,
    requestedModel: null,
    parentAgentId: 'leader',
    depth: 1,
    canDelegate: false,
    managerPolicy: null,
    liveOutput: '',
    reasoningActive: false,
    usage: { costCents: 0, tokens: 0, timeMs: 0, toolCalls: 0 },
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function detail(
  workers: WorkerSummary[],
  state: TeamDetail['team']['state'] = 'active',
): TeamDetail {
  return {
    team: {
      id: 'team-stop-all',
      taskId: task.id,
      leaderAgentId: 'leader',
      state,
      budget: {},
      policy: {
        maxAgentDepth: 4,
        maxConcurrentExecutions: 8,
        allowWorkerDirectMessages: true,
        budgetMode: 'bounded',
      },
      revision: 1,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    },
    workers,
    messages: [],
    executions: [],
    missions: [],
    activities: [],
    budgets: [],
  };
}

function leaderTurn(status: TurnStatus) {
  return {
    turnId: 'leader-turn',
    stage: 'executing' as const,
    reachedStageIndex: 2,
    status,
    startedAt: 1,
    streamingMessageId: null,
    streamingContent: '',
    runtimeStarting: false,
  };
}

// Captured once so a test that swaps the action for a spy cannot leak it into the next test.
const { stopAllTeamWorkers } = useAppStore.getState();
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  useAppStore.setState({
    selectedTaskId: task.id,
    teamByTask: {},
    teamLoadFailedByTask: {},
    turnByTask: {},
    queuedByTask: {},
    teamBusy: false,
    teamBusyByTask: {},
    error: null,
    stopAllTeamWorkers,
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe.each(['list', 'canvas'] as const)('%s stop-all control', (view) => {
  const render = () =>
    act(() =>
      root.render(
        view === 'list' ? (
          <TeamListView task={task} onBack={vi.fn()} onSwitchToCanvasView={vi.fn()} />
        ) : (
          <TeamCanvas
            task={task}
            leaderRef={createRef()}
            leaderAnchorRef={createRef()}
            onRequestExit={vi.fn()}
            onSwitchToListView={vi.fn()}
          />
        ),
      ),
    );
  const stopAllButton = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="team-stop-all"]')!;

  it.each([
    // Leader still running before any Worker is hired (issue #962).
    ['running Leader, no Workers', 'running', [], 'active', false, true],
    ['running Leader, only stopped Workers', 'running', ['stopped'], 'active', false, true],
    ['running Leader, completed Team', 'running', [], 'completed', false, true],
    ['running Leader, busy Workers', 'running', ['busy'], 'active', false, true],
    // Existing Worker-side entry stays as it was.
    ['no Leader Turn, ready Worker', undefined, ['ready'], 'active', false, true],
    ['finished Leader, busy Worker', 'completed', ['busy'], 'active', false, true],
    ['finished Leader, done Worker', 'completed', ['done'], 'active', false, true],
    ['finished Leader, failed Worker', 'failed', ['failed'], 'active', false, true],
    // Nothing left to stop.
    ['no Leader Turn, no Workers', undefined, [], 'active', false, false],
    ['canceled Leader, no Workers', 'canceled', [], 'active', false, false],
    ['canceled Leader, only stopped Workers', 'canceled', ['stopped'], 'active', false, false],
    ['finished Leader, completed Team', 'completed', ['done'], 'completed', false, false],
    // A stop is already in flight.
    ['canceling Leader, no Workers', 'canceling', [], 'active', false, false],
    ['canceling Leader, busy Worker', 'canceling', ['busy'], 'active', false, false],
    ['Team operation in flight', 'running', ['busy'], 'active', true, false],
  ] as const)('%s', (_name, leader, workerStates, teamState, teamBusy, enabled) => {
    useAppStore.setState({
      teamByTask: {
        [task.id]: detail(
          workerStates.map((state, index) => worker(`worker-${index + 1}`, state)),
          teamState,
        ),
      },
      turnByTask: { [task.id]: leader === undefined ? undefined : leaderTurn(leader) },
      teamBusy,
    });
    render();
    expect(stopAllButton().disabled).toBe(!enabled);
  });

  it('stops a running Leader with no Workers through the existing store action', () => {
    const stopAllSpy = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      teamByTask: { [task.id]: detail([]) },
      turnByTask: { [task.id]: leaderTurn('running') },
      stopAllTeamWorkers: stopAllSpy,
    });
    render();
    act(() => stopAllButton().click());
    expect(stopAllSpy).toHaveBeenCalledTimes(1);
    expect(stopAllSpy).toHaveBeenCalledWith(task.id);
  });

  it('cancels the Leader before stopping Workers and refuses a second request meanwhile', async () => {
    let resolveCancel!: () => void;
    const cancel = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        resolveCancel = resolve;
      }),
    );
    const stopped = detail([]);
    const stopAll = vi.fn().mockResolvedValue(stopped);
    vi.stubGlobal('sprintCoder', { turns: { cancel }, teams: { stopAll } });
    useAppStore.setState({
      teamByTask: { [task.id]: detail([]) },
      turnByTask: { [task.id]: leaderTurn('running') },
      queuedByTask: { [task.id]: [{ ordinal: 1, text: 'queued' }] },
    });
    render();

    act(() => stopAllButton().click());
    expect(stopAllButton().disabled).toBe(true);
    act(() => stopAllButton().click());
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith({
      taskId: task.id,
      turnId: 'leader-turn',
      startNextQueued: false,
    });
    expect(stopAll).not.toHaveBeenCalled();

    await act(async () => resolveCancel());
    expect(stopAll).toHaveBeenCalledTimes(1);
    expect(stopAll).toHaveBeenCalledWith(task.id);
    // turn.completed has not arrived yet: the Leader is still canceling, so no second stop.
    expect(stopAllButton().disabled).toBe(true);

    act(() => useAppStore.setState({ turnByTask: { [task.id]: leaderTurn('canceled') } }));
    expect(stopAllButton().disabled).toBe(true);
    expect(useAppStore.getState().queuedByTask[task.id]).toEqual([{ ordinal: 1, text: 'queued' }]);
    expect(useAppStore.getState().error).toBeNull();
  });

  it('keeps the control available and the error visible when the Leader cannot be stopped', async () => {
    const cancel = vi.fn().mockRejectedValue(new Error('leader cancel failed'));
    const stopAll = vi.fn();
    vi.stubGlobal('sprintCoder', { turns: { cancel }, teams: { stopAll } });
    useAppStore.setState({
      teamByTask: { [task.id]: detail([]) },
      turnByTask: { [task.id]: leaderTurn('running') },
    });
    render();

    await act(async () => stopAllButton().click());

    expect(stopAll).not.toHaveBeenCalled();
    expect(useAppStore.getState().turnByTask[task.id]?.status).toBe('running');
    expect(useAppStore.getState().error).toBe('leader cancel failed');
    expect(stopAllButton().disabled).toBe(false);
  });
});

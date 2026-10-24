// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamListView } from './TeamListView';
import { TeamCanvas } from './TeamCanvas/TeamCanvas';
import { Timeline } from './ChatSurface/Timeline';
import { useAppStore } from '../store/appStore';
import type {
  TaskSummary,
  TeamDetail,
  TeamExecutionSummary,
  WorkerSummary,
  TeamExecutionIsolation,
} from '../types/sprint-coder';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const at = '2026-10-24T00:00:00Z';
const task: TaskSummary = {
  id: 'task-phase',
  projectId: null,
  title: 'Synthetic Team',
  pinned: false,
  archived: false,
  goal: null,
  goalState: null,
  workspacePath: null,
  localOnly: true,
  createdAt: at,
  updatedAt: at,
};
const worker: WorkerSummary = {
  id: 'worker-phase',
  teamId: 'team-phase',
  threadId: 'thread-phase',
  taskId: task.id,
  kind: 'worker',
  role: '担当',
  state: 'busy',
  objective: 'synthetic',
  writeCapable: true,
  currentActivity: '古い作業状況',
  engine: 'mock',
  connectionId: 'builtin:codex-cli',
  requestedProvider: null,
  requestedModel: null,
  parentAgentId: 'leader-phase',
  depth: 1,
  canDelegate: false,
  managerPolicy: null,
  liveOutput: '',
  reasoningActive: true,
  usage: { costCents: 0, tokens: 0, timeMs: 0, toolCalls: 0 },
  createdAt: at,
  updatedAt: at,
};
function execution(phase: TeamExecutionIsolation['phase']): TeamExecutionSummary {
  return {
    id: 'exec-phase',
    teamId: worker.teamId,
    assigneeAgentId: worker.id,
    createdByAgentId: worker.parentAgentId!,
    accessMode: 'workspace-write',
    state: 'running',
    instructionPreview: 'synthetic',
    instructionRevision: 1,
    queueOrdinal: null,
    queueReason: null,
    connectionId: worker.connectionId,
    requestedModel: null,
    attemptStartReason: 'initial',
    lastProgressAt: at,
    terminalReason: null,
    missionId: null,
    missionStepOrdinal: null,
    missionStepCount: null,
    worktree: null,
    isolation: { phase, resumeKind: null, repositories: [], roots: [], reason: null },
    assignedAt: at,
    queuedAt: null,
    startedAt: at,
    completedAt: null,
    updatedAt: at,
  };
}
function detail(row: TeamExecutionSummary): TeamDetail {
  return {
    team: {
      id: worker.teamId,
      taskId: task.id,
      state: 'active',
      leaderAgentId: worker.parentAgentId!,
      budget: {},
      policy: {
        maxAgentDepth: 4,
        maxConcurrentExecutions: 100,
        allowWorkerDirectMessages: true,
        budgetMode: 'unlimited',
      },
      revision: 1,
      createdAt: at,
      updatedAt: at,
    },
    workers: [worker],
    executions: [row],
    messages: [],
    missions: [],
    activities: [],
    budgets: [],
  };
}
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
    teamByTask: {},
    teamLoadFailedByTask: {},
    teamBusy: false,
    messagesByTask: {},
    turnDiffByTask: {},
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

describe.each(['canvas', 'list'] as const)('%s work phase projection', (view) => {
  it('keeps manual-resume attention visible without an active work indicator', () => {
    const row = execution('waiting_integration');
    row.state = 'waiting_resume';
    useAppStore.setState({ teamByTask: { [task.id]: detail(row) } });
    act(() =>
      root.render(
        view === 'list' ? (
          <TeamListView task={task} onBack={() => {}} onSwitchToCanvasView={() => {}} />
        ) : (
          <TeamCanvas
            task={task}
            leaderRef={createRef()}
            leaderAnchorRef={createRef()}
            onRequestExit={() => {}}
            onSwitchToListView={() => {}}
          />
        ),
      ),
    );
    const card = container.querySelector('[data-testid="team-worker"]')!;
    expect(card.querySelector('.team-status')?.textContent).toBe('再開待ち');
    expect(card.querySelector('[data-testid="team-integration-resume"]')).not.toBeNull();
    expect(card.textContent).toContain('既存変更を確認してから再開');
    expect(card.querySelector('.w-run-title')).toBeNull();
    expect(container.querySelector('[data-testid="team-work-counts"]')).toBeNull();
  });
  it.each([
    ['running', '作業中', '作業中 1人 · 統合待ち 0人 · 統合中 0人'],
    ['waiting_integration', '統合待ち', '作業中 0人 · 統合待ち 1人 · 統合中 0人'],
    ['integrating', '統合中', '作業中 0人 · 統合待ち 0人 · 統合中 1人'],
  ] as const)(
    'shows %s consistently on the badge, accessible name and headcount',
    (phase, label, counts) => {
      const row = execution(phase);
      useAppStore.setState({ teamByTask: { [task.id]: detail(row) } });
      act(() =>
        root.render(
          view === 'list' ? (
            <TeamListView task={task} onBack={() => {}} onSwitchToCanvasView={() => {}} />
          ) : (
            <TeamCanvas
              task={task}
              leaderRef={createRef()}
              leaderAnchorRef={createRef()}
              onRequestExit={() => {}}
              onSwitchToListView={() => {}}
            />
          ),
        ),
      );
      const card = container.querySelector('[data-testid="team-worker"]')!;
      expect(card.getAttribute('aria-label')).toBe(`Worker 担当 · ${label}`);
      expect(card.querySelector('.team-status')?.textContent).toBe(label);
      expect(container.querySelector('[data-testid="team-work-counts"]')?.textContent).toBe(counts);
      if (phase !== 'running') {
        expect(
          card.querySelector('.w-run-title')?.textContent ??
            card.querySelector('.tlv-activity')?.textContent,
        ).toContain(label);
        expect(card.querySelector('.w-run-detail')).toBeNull();
      }
      expect(row.state).toBe('running');
    },
  );
});

describe('Timeline phase parity', () => {
  it.each([
    ['running', 'running', '作業中'],
    ['waiting_integration', 'running', '統合待ち'],
    ['integrating', 'running', '統合中'],
    ['waiting_integration', 'waiting_resume', '再開待ち'],
  ] as const)(
    'describes %s / %s using the shared phase without losing resume attention',
    (phase, state, label) => {
      const row = execution(phase);
      row.state = state;
      useAppStore.setState({
        teamByTask: { [task.id]: detail(row) },
        messagesByTask: {
          [task.id]: [
            {
              id: 'user-phase',
              taskId: task.id,
              turnId: 'turn-phase',
              author: 'user',
              content: 'synthetic request',
              attachments: [],
              createdAt: at,
            },
            {
              id: 'reply-phase',
              taskId: task.id,
              turnId: 'turn-phase',
              author: 'assistant',
              content: 'synthetic response',
              attachments: [],
              createdAt: at,
            },
          ],
        },
        turnDiffByTask: {
          [task.id]: {
            turnId: 'turn-phase',
            entries: [
              {
                ordinal: 1,
                kind: 'update',
                path: 'result.txt',
                destination: null,
                preHash: null,
                postHash: null,
                provenance: 'agent_edit',
                status: 'applied',
                actualHash: null,
              },
            ],
          },
        },
      });
      act(() => root.render(<Timeline taskId={task.id} />));
      expect(container.innerHTML).toContain(`<span>担当</span><span>${label}</span>`);
    },
  );
});

it('does not show an outdated thinking indicator outside an active work phase', () => {
  const row = execution('completed');
  useAppStore.setState({ teamByTask: { [task.id]: detail(row) } });
  act(() =>
    root.render(
      <TeamCanvas
        task={task}
        leaderRef={createRef()}
        leaderAnchorRef={createRef()}
        onRequestExit={() => {}}
        onSwitchToListView={() => {}}
      />,
    ),
  );
  expect(container.querySelector('[data-testid="team-worker"] .w-run-title')).toBeNull();
  expect(container.querySelector('[data-testid="team-work-counts"]')).toBeNull();
  expect(row.state).toBe('running');
});

import { describe, expect, it } from 'vitest';
import type { TeamDetail, TeamMessageSummary, WorkerSummary } from '../types/sprint-coder';
import { currentTeamWorkerCount, teamRunProgress } from './team-progress';
import {
  EXTERNAL_API_RUNTIME_LABEL,
  LEADER_MESSAGE_PEER_LABEL,
  UNKNOWN_MESSAGE_PEER_LABEL,
  describeMessagePeer,
  workerRuntimeLabel,
} from './team-activity-display';

function worker(id: string, role: string, state: WorkerSummary['state']): WorkerSummary {
  return {
    id,
    teamId: 'team-1',
    threadId: `thread-${id}`,
    taskId: 'task-1',
    kind: 'worker',
    role,
    state,
    objective: 'objective',
    writeCapable: false,
    currentActivity: null,
    engine: 'mock',
    connectionId: null,
    requestedProvider: null,
    requestedModel: null,
    parentAgentId: 'leader-1',
    depth: 1,
    canDelegate: false,
    managerPolicy: null,
    liveOutput: '',
    reasoningActive: false,
    usage: { costCents: 0, tokens: 0, timeMs: 0, toolCalls: 0 },
    createdAt: '',
    updatedAt: '',
  };
}

function detail(
  workers: WorkerSummary[],
  reports: Array<{ id: string; workerId: string }> = [],
): TeamDetail {
  return {
    team: {
      id: 'team-1',
      taskId: 'task-1',
      state: 'active',
      leaderAgentId: 'leader-1',
      budget: {},
      policy: {
        maxAgentDepth: 4,
        maxConcurrentExecutions: 8,
        allowWorkerDirectMessages: true,
        budgetMode: 'bounded',
      },
      revision: 1,
      createdAt: '',
      updatedAt: '',
    },
    workers,
    messages: reports.map(({ id, workerId }, index) => ({
      id,
      teamId: 'team-1',
      sourceAgentId: workerId,
      targetAgentId: 'leader-1',
      sourceKind: 'worker',
      targetKind: 'leader',
      seq: index + 1,
      state: 'acknowledged',
      content: 'report',
      executionId: null,
      attemptId: null,
      deliveryState: 'acked',
      attempt: 1,
      createdAt: '',
      updatedAt: '',
    })),
    executions: [],
    missions: [],
    activities: [],
    budgets: [],
  };
}

describe('teamRunProgress', () => {
  it('keeps ordinary non-Team turns on the generic Run Card status', () => {
    expect(teamRunProgress(null)).toBeNull();
  });

  it('shows the active Worker role instead of a generic thinking label', () => {
    expect(
      teamRunProgress(
        detail([
          worker('w1', '技術担当', 'done'),
          worker('w2', '倫理担当', 'busy'),
          worker('w3', '実務担当', 'ready'),
        ]),
      ),
    ).toEqual({ label: 'Team実行中', detail: '倫理担当が作業中' });
  });

  it('shows real report progress and final synthesis', () => {
    const workers = [
      worker('w1', '技術担当', 'done'),
      worker('w2', '倫理担当', 'ready'),
      worker('w3', '実務担当', 'ready'),
    ];
    expect(teamRunProgress(detail(workers, [{ id: 'r1', workerId: 'w1' }]))).toEqual({
      label: 'Team実行中',
      detail: '報告を受信中（1/3）',
    });
    expect(
      teamRunProgress(
        detail(workers, [
          { id: 'r1', workerId: 'w1' },
          { id: 'r2', workerId: 'w2' },
          { id: 'r3', workerId: 'w3' },
        ]),
      ),
    ).toEqual({ label: 'Team実行中', detail: '報告を統合中（3/3）' });
  });

  it('does not count stopped Workers as current Team members', () => {
    const workers = [
      worker('old-1', '停止1', 'stopped'),
      worker('old-2', '停止2', 'stopped'),
      worker('old-3', '停止3', 'stopped'),
      worker('w1', '現役1', 'done'),
      worker('w2', '現役2', 'done'),
      worker('w3', '現役3', 'done'),
    ];
    expect(teamRunProgress(detail(workers))).toEqual({
      label: 'Team実行中',
      detail: '3人のWorkerへ依頼中',
    });
    expect(currentTeamWorkerCount(detail(workers))).toBe(3);
  });
});

// The runtime name the Canvas card and the List row both put beside the objective. `engine` is a
// backend-compatibility field that is always one of mock/codex/claude — including for Workers
// hired against an external Provider API — so `connectionId` is what decides here.
describe('workerRuntimeLabel', () => {
  function hired(overrides: Pick<WorkerSummary, 'connectionId' | 'engine'>): WorkerSummary {
    return { ...worker('w1', '技術担当', 'ready'), ...overrides };
  }

  it('names the built-in CLIs by their product name', () => {
    const claude = hired({ connectionId: 'builtin:claude-cli', engine: 'claude' });
    const codex = hired({ connectionId: 'builtin:codex-cli', engine: 'codex' });
    expect(workerRuntimeLabel(claude)).toBe('Claude');
    expect(workerRuntimeLabel(codex)).toBe('Codex');
  });

  it('ignores the compatibility engine once a Connection is recorded', () => {
    // The exact regression: an OpenAI-backed Worker still persists `engine: 'claude'`, and the
    // card used to read that field straight out and announce the Worker as Claude.
    const openai = hired({ connectionId: 'conn-openai-1', engine: 'claude' });
    const gemini = hired({ connectionId: 'conn-gemini-1', engine: 'codex' });
    const mockEngine = hired({ connectionId: 'conn-anthropic-api-1', engine: 'mock' });
    expect(workerRuntimeLabel(openai)).toBe(EXTERNAL_API_RUNTIME_LABEL);
    expect(workerRuntimeLabel(gemini)).toBe(EXTERNAL_API_RUNTIME_LABEL);
    expect(workerRuntimeLabel(mockEngine)).toBe(EXTERNAL_API_RUNTIME_LABEL);
    expect(EXTERNAL_API_RUNTIME_LABEL).toBe('API');
  });

  it('never guesses a Provider name out of the connection id', () => {
    // The id may well carry a Provider's name; it is still not a display name this contract
    // carries, so the row states what it knows instead of inventing "OpenAI".
    const looksBuiltin = hired({ connectionId: 'builtin:openai-cli', engine: 'claude' });
    expect(workerRuntimeLabel(looksBuiltin)).toBe(EXTERNAL_API_RUNTIME_LABEL);
  });

  it('falls back to the engine only for legacy rows that recorded no Connection', () => {
    expect(workerRuntimeLabel(hired({ connectionId: null, engine: 'claude' }))).toBe('Claude');
    expect(workerRuntimeLabel(hired({ connectionId: null, engine: 'codex' }))).toBe('Codex');
    expect(workerRuntimeLabel(hired({ connectionId: null, engine: 'mock' }))).toBe('Mock');
    // A Connection the backend recorded as whitespace is the same fact as none at all.
    expect(workerRuntimeLabel(hired({ connectionId: '  ', engine: 'codex' }))).toBe('Codex');
  });
});

// The tag on a Worker card's message line. The backend persists both endpoints and lets a Manager
// Worker message its own children, so "every incoming line is from the Leader" was simply false —
// a Worker A -> Worker B message rendered as if the Leader had sent it.
describe('describeMessagePeer', () => {
  const LEADER = 'leader-1';
  const SELF = 'w1';
  const SIBLING = 'w2';
  // The two facts each surface resolves against: the Team's Leader id and its Worker list. Built
  // once here because the Canvas card and the List row build the SAME context — see the parity
  // test at the bottom of this block.
  const AGENTS = [worker(SELF, '技術担当', 'busy'), worker(SIBLING, '倫理担当', 'ready')];

  function message(sourceAgentId: string, targetAgentId: string): TeamMessageSummary {
    return {
      id: `m-${sourceAgentId}-${targetAgentId}`,
      teamId: 'team-1',
      sourceAgentId,
      targetAgentId,
      sourceKind: sourceAgentId === LEADER ? 'leader' : 'worker',
      targetKind: targetAgentId === LEADER ? 'leader' : 'worker',
      seq: 1,
      state: 'acknowledged',
      content: 'body',
      executionId: null,
      attemptId: null,
      deliveryState: 'acked',
      attempt: 1,
      createdAt: '',
      updatedAt: '',
    };
  }

  function peerOf(m: TeamMessageSummary, agentId = SELF) {
    return describeMessagePeer(m, { agentId, leaderAgentId: LEADER, agents: AGENTS });
  }

  it('names the Leader on both directions of a Leader exchange', () => {
    expect(peerOf(message(LEADER, SELF))).toEqual({
      direction: 'incoming',
      peerAgentId: LEADER,
      peerLabel: LEADER_MESSAGE_PEER_LABEL,
      tagLabel: 'Leaderから',
    });
    // The outgoing side used to read "報告" regardless of where it was actually going.
    expect(peerOf(message(SELF, LEADER))).toEqual({
      direction: 'outgoing',
      peerAgentId: LEADER,
      peerLabel: LEADER_MESSAGE_PEER_LABEL,
      tagLabel: 'Leaderへ',
    });
  });

  it('names a sibling Worker by its own role instead of attributing it to the Leader', () => {
    // The exact regression: both of these used to render as a Leader exchange.
    expect(peerOf(message(SIBLING, SELF))).toMatchObject({
      direction: 'incoming',
      peerAgentId: SIBLING,
      tagLabel: '倫理担当から',
    });
    expect(peerOf(message(SELF, SIBLING))).toMatchObject({
      direction: 'outgoing',
      peerAgentId: SIBLING,
      tagLabel: '倫理担当へ',
    });
  });

  it('states a generic Agent for a legacy or corrupted row rather than guessing', () => {
    // An id belonging to no agent this renderer knows: a Worker removed from the Team, or a row
    // written before the id existed. The id itself is never leaked into the sentence, and neither
    // the message's own kinds nor any Connection/model id stands in for a role.
    const orphan = message('agent-gone', SELF);
    expect(peerOf(orphan)).toEqual({
      direction: 'incoming',
      peerAgentId: 'agent-gone',
      peerLabel: UNKNOWN_MESSAGE_PEER_LABEL,
      tagLabel: 'Agentから',
    });
    expect(peerOf(message(SELF, 'agent-gone'))).toMatchObject({ tagLabel: 'Agentへ' });
    // A recorded-but-empty id, and an agent whose role is blank, are the same "not known" fact.
    expect(peerOf(message('', SELF))).toMatchObject({ tagLabel: 'Agentから' });
    const blankRole = describeMessagePeer(message(SIBLING, SELF), {
      agentId: SELF,
      leaderAgentId: LEADER,
      agents: [{ id: SIBLING, role: '  ' }],
    });
    expect(blankRole).toMatchObject({ peerLabel: UNKNOWN_MESSAGE_PEER_LABEL });
  });

  it('decides direction exactly as both surfaces already did', () => {
    // Target-is-me wins, so a self-addressed row stays on the incoming branch it rendered on
    // before — message order and styling are untouched by this change.
    expect(peerOf(message(SELF, SELF)).direction).toBe('incoming');
    // The same message read from the OTHER card is the mirror image, never a second "incoming".
    expect(peerOf(message(SELF, SIBLING), SIBLING)).toMatchObject({
      direction: 'incoming',
      tagLabel: '技術担当から',
    });
  });

  it('tags identically on the Canvas card and the List row (parity)', () => {
    // Both surfaces select their lines with the same filter/sort and then call this helper with
    // the same two facts; the List additionally shows only the last four. Same inputs, same tags —
    // the windowing can change WHICH lines appear, never what they say.
    const messages = [
      message(LEADER, SELF),
      message(SIBLING, SELF),
      message(SELF, SIBLING),
      message(SELF, LEADER),
    ].map((m, index) => ({ ...m, seq: index + 1 }));
    const select = (limit?: number) => {
      const rows = messages
        .filter((m) => m.targetAgentId === SELF || m.sourceAgentId === SELF)
        .sort((a, b) => a.seq - b.seq);
      return (limit === undefined ? rows : rows.slice(-limit)).map((m) => peerOf(m).tagLabel);
    };
    expect(select()).toEqual(['Leaderから', '倫理担当から', '倫理担当へ', 'Leaderへ']);
    expect(select(4)).toEqual(select());
  });
});

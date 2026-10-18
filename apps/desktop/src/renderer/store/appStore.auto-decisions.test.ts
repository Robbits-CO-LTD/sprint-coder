import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutoPermissionDecision, TurnEvent } from '../types/sprint-coder';
import {
  AUTO_DECISION_RETAIN_LIMIT,
  appendAutoDecisions,
  countAutoDecisions,
  handleTurnEvent,
  useAppStore,
} from './appStore';

type AppState = ReturnType<typeof useAppStore.getState>;

function decision(index: number, overrides: Partial<AutoPermissionDecision> = {}) {
  return {
    id: `auto-${index}`,
    taskId: 'task-1',
    turnId: 'turn-1',
    callId: `call-${index}`,
    reviewRequestId: `review-${index}`,
    capability: 'workspace.read',
    source: 'policy',
    decision: 'allow',
    outcome: 'allow',
    reason: `reason ${index}`,
    risk: 'low',
    model: 'fixture',
    templateVersion: '1',
    requestFingerprint: 'f'.repeat(64),
    executionSpecDigest: 'd'.repeat(64),
    inputDigest: 'e'.repeat(64),
    policyEpoch: 0,
    createdAt: new Date(Date.UTC(2026, 9, 18, 0, 0, index)).toISOString(),
    ...overrides,
  } satisfies AutoPermissionDecision;
}

function autoDecided(seq: number, autoDecision: AutoPermissionDecision): TurnEvent {
  return {
    type: 'permission.auto_decided',
    seq,
    taskId: autoDecision.taskId,
    turnId: autoDecision.turnId,
    autoDecision,
  } as TurnEvent;
}

function fakeStore() {
  let state = {
    lastSeqByTask: {},
    autoDecisionsByTask: {},
    autoDecisionCountsByTask: {},
  } as unknown as AppState;
  const updates: Partial<AppState>[] = [];
  const apply = (fn: (current: AppState) => Partial<AppState>) => {
    const update = fn(state);
    updates.push(update);
    state = { ...state, ...update };
  };
  return { apply, updates, state: () => state };
}

describe('Auto decisions in the store (issue #863)', () => {
  afterEach(() => vi.useRealTimers());

  it('appends in arrival order, replaces a known id in place, and keeps the newest 200', () => {
    const first = appendAutoDecisions([], [decision(1), decision(2)]);
    expect(first.map(({ id }) => id)).toEqual(['auto-1', 'auto-2']);

    const replaced = appendAutoDecisions(first, [decision(1, { reason: 'updated' }), decision(3)]);
    expect(replaced.map(({ id }) => id)).toEqual(['auto-1', 'auto-2', 'auto-3']);
    expect(replaced[0]?.reason).toBe('updated');

    const many = Array.from({ length: AUTO_DECISION_RETAIN_LIMIT + 50 }, (_, index) =>
      decision(index + 10),
    );
    const capped = appendAutoDecisions(replaced, many);
    expect(capped).toHaveLength(AUTO_DECISION_RETAIN_LIMIT);
    expect(capped[0]?.id).toBe(`auto-${10 + 50}`);
    expect(capped.at(-1)?.id).toBe(`auto-${10 + AUTO_DECISION_RETAIN_LIMIT + 49}`);
  });

  it('keeps denials when a stream of allows passes the limit', () => {
    const denials = [1, 2, 3].map((index) => decision(index, { decision: 'deny' }));
    const allows = Array.from({ length: AUTO_DECISION_RETAIN_LIMIT + 100 }, (_, index) =>
      decision(index + 10, { turnId: 'turn-2' }),
    );
    const kept = appendAutoDecisions(denials, allows);
    expect(kept.filter(({ decision: kind }) => kind === 'deny').map(({ id }) => id)).toEqual([
      'auto-1',
      'auto-2',
      'auto-3',
    ]);
    expect(kept.filter(({ decision: kind }) => kind !== 'deny')).toHaveLength(
      AUTO_DECISION_RETAIN_LIMIT,
    );
    // Denials have their own limit too, so the list stays bounded.
    const manyDenials = Array.from({ length: AUTO_DECISION_RETAIN_LIMIT + 5 }, (_, index) =>
      decision(index + 1_000, { decision: 'deny' }),
    );
    expect(appendAutoDecisions(kept, manyDenials)).toHaveLength(AUTO_DECISION_RETAIN_LIMIT * 2);
  });

  it('counts every decision of each Turn, even after its rows leave the window', () => {
    vi.useFakeTimers();
    const store = fakeStore();
    let seq = 0;
    for (let index = 1; index <= 3; index += 1)
      handleTurnEvent(
        'task-1',
        autoDecided((seq += 1), decision(index, { decision: 'deny', outcome: 'deny' })),
        store.apply,
      );
    handleTurnEvent(
      'task-1',
      autoDecided((seq += 1), decision(4, { decision: 'allow_once' })),
      store.apply,
    );
    for (let index = 0; index < AUTO_DECISION_RETAIN_LIMIT + 50; index += 1)
      handleTurnEvent(
        'task-1',
        autoDecided((seq += 1), decision(100 + index, { turnId: 'turn-2' })),
        store.apply,
      );
    vi.runAllTimers();

    const rows = store.state().autoDecisionsByTask['task-1'] ?? [];
    // Turn 1's allow_once row was pushed out by Turn 2's allows; its denials were not.
    expect(rows.filter(({ turnId }) => turnId === 'turn-1').map(({ id }) => id)).toEqual([
      'auto-1',
      'auto-2',
      'auto-3',
    ]);
    expect(store.state().autoDecisionCountsByTask['task-1']).toEqual({
      throughSeq: seq,
      byTurn: {
        'turn-1': { allow: 0, allowOnce: 1, deny: 3 },
        'turn-2': { allow: AUTO_DECISION_RETAIN_LIMIT + 50, allowOnce: 0, deny: 0 },
      },
    });
  });

  it('does not count an event at or below the counted sequence again', () => {
    const counts = countAutoDecisions(
      { throughSeq: 10, byTurn: { 'turn-1': { allow: 4, allowOnce: 0, deny: 1 } } },
      [
        { seq: 9, decision: decision(9) },
        { seq: 10, decision: decision(10, { decision: 'deny' }) },
        { seq: 11, decision: decision(11, { decision: 'deny' }) },
      ],
    );
    expect(counts).toEqual({
      throughSeq: 11,
      byTurn: { 'turn-1': { allow: 4, allowOnce: 0, deny: 2 } },
    });
  });

  it('folds the decisions that arrive together into one store update', () => {
    vi.useFakeTimers();
    const store = fakeStore();
    for (let index = 1; index <= 5; index += 1)
      handleTurnEvent('task-1', autoDecided(index, decision(index)), store.apply);
    // The sequence position is still recorded per event; the decisions wait for the next frame.
    expect(store.state().lastSeqByTask['task-1']).toBe(5);
    expect(store.state().autoDecisionsByTask['task-1']).toBeUndefined();

    vi.runAllTimers();
    expect(store.updates.filter((update) => 'autoDecisionsByTask' in update)).toHaveLength(1);
    expect(store.state().autoDecisionsByTask['task-1']?.map(({ id }) => id)).toEqual([
      'auto-1',
      'auto-2',
      'auto-3',
      'auto-4',
      'auto-5',
    ]);
  });
});

describe('Auto decisions restored with a Task (issue #863)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('takes the rows and counts from the snapshot, so a denial recorded while it waited is in both', async () => {
    // Main read the snapshot after a mutation released the Task's mailbox: the denial recorded
    // meanwhile (seq 7) is in its rows, its counts and its lastSeq together.
    const denial = decision(7, { decision: 'deny', outcome: 'deny', reason: 'outside the roots' });
    const subscribe = vi.fn().mockReturnValue(vi.fn());
    vi.stubGlobal('window', {
      sprintCoder: {
        tasks: { messages: vi.fn().mockResolvedValue([]) },
        turns: {
          snapshot: vi.fn().mockResolvedValue({
            lastSeq: 7,
            activeTurn: null,
            queued: [],
            pendingApprovals: [],
            activatedSkills: [],
            latestTurnDiff: null,
            autoDecisions: [decision(6), denial],
            autoDecisionCounts: [{ turnId: 'turn-1', allow: 1, allowOnce: 0, deny: 1 }],
          }),
          subscribe,
        },
      },
    });

    await useAppStore.getState().selectTask('task-1');

    const state = useAppStore.getState();
    expect(state.autoDecisionsByTask['task-1']?.map(({ id, reason }) => [id, reason])).toEqual([
      ['auto-6', 'reason 6'],
      ['auto-7', 'outside the roots'],
    ]);
    expect(state.autoDecisionCountsByTask['task-1']).toEqual({
      throughSeq: 7,
      byTurn: { 'turn-1': { allow: 1, allowOnce: 0, deny: 1 } },
    });
    // The subscription resumes after the same lastSeq, so nothing up to it is replayed again.
    expect(subscribe).toHaveBeenCalledWith('task-1', expect.any(Function), { afterSeq: 7 });
  });
});

describe('an older selection of the same Task (issue #863)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function deferredSnapshot() {
    let resolve!: (value: unknown) => void;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  function snapshotAt(lastSeq: number, decisions: AutoPermissionDecision[]) {
    const tally = { allow: 0, allowOnce: 0, deny: 0 };
    for (const { decision: kind } of decisions)
      if (kind === 'deny') tally.deny += 1;
      else if (kind === 'allow_once') tally.allowOnce += 1;
      else tally.allow += 1;
    return {
      lastSeq,
      activeTurn: null,
      queued: [],
      pendingApprovals: [],
      activatedSkills: [],
      latestTurnDiff: null,
      autoDecisions: decisions,
      autoDecisionCounts: [{ turnId: 'turn-1', ...tally }],
    };
  }

  function stubSnapshots(snapshots: Promise<unknown>[]) {
    const snapshot = vi.fn();
    for (const next of snapshots) snapshot.mockReturnValueOnce(next);
    snapshot.mockResolvedValue(null);
    vi.stubGlobal('window', {
      sprintCoder: {
        tasks: { messages: vi.fn().mockResolvedValue([]) },
        turns: { snapshot, subscribe: vi.fn().mockReturnValue(vi.fn()) },
      },
    });
  }

  const older = [decision(10)];
  const newer = [decision(10), decision(11, { decision: 'deny', outcome: 'deny' })];

  function expectNewer() {
    const state = useAppStore.getState();
    expect(state.autoDecisionsByTask['task-1']?.map(({ id }) => id)).toEqual([
      'auto-10',
      'auto-11',
    ]);
    expect(state.autoDecisionCountsByTask['task-1']).toEqual({
      throughSeq: 11,
      byTurn: { 'turn-1': { allow: 1, allowOnce: 0, deny: 1 } },
    });
    expect(state.lastSeqByTask['task-1']).toBe(11);
  }

  it('keeps the newer reads when the first of two selections of the same Task answers last', async () => {
    const first = deferredSnapshot();
    const second = deferredSnapshot();
    stubSnapshots([first.promise, second.promise]);

    const firstSelection = useAppStore.getState().selectTask('task-1');
    const secondSelection = useAppStore.getState().selectTask('task-1');
    second.resolve(snapshotAt(11, newer));
    await secondSelection;
    expectNewer();

    first.resolve(snapshotAt(10, older));
    await firstSelection;
    expectNewer();
  });

  it('keeps the newer reads across A→B→A when the first A answers last', async () => {
    const firstA = deferredSnapshot();
    const secondA = deferredSnapshot();
    stubSnapshots([firstA.promise, Promise.resolve(null), secondA.promise]);

    const firstSelection = useAppStore.getState().selectTask('task-1');
    await useAppStore.getState().selectTask('task-2');
    const secondSelection = useAppStore.getState().selectTask('task-1');
    secondA.resolve(snapshotAt(11, newer));
    await secondSelection;
    expectNewer();

    firstA.resolve(snapshotAt(10, older));
    await firstSelection;
    expectNewer();
  });
});

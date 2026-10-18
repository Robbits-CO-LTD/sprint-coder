import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutoPermissionDecision, TurnEvent } from '@sprint-coder/contracts';
import {
  AUTO_DECISION_RETAIN_LIMIT,
  appendAutoDecisions,
  handleTurnEvent,
  type AppState,
} from './appStore';

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

  it('folds the decisions that arrive together into one store update', () => {
    vi.useFakeTimers();
    let state = { lastSeqByTask: {}, autoDecisionsByTask: {} } as unknown as AppState;
    const updates: Partial<AppState>[] = [];
    const apply = (fn: (current: AppState) => Partial<AppState>) => {
      const update = fn(state);
      updates.push(update);
      state = { ...state, ...update };
    };

    for (let index = 1; index <= 5; index += 1)
      handleTurnEvent(
        'task-1',
        {
          type: 'permission.auto_decided',
          seq: index,
          taskId: 'task-1',
          turnId: 'turn-1',
          autoDecision: decision(index),
        } as TurnEvent,
        apply,
      );
    // The sequence position is still recorded per event; the decisions wait for the next frame.
    expect(state.lastSeqByTask['task-1']).toBe(5);
    expect(state.autoDecisionsByTask['task-1']).toBeUndefined();

    vi.runAllTimers();
    expect(updates.filter((update) => 'autoDecisionsByTask' in update)).toHaveLength(1);
    expect(state.autoDecisionsByTask['task-1']?.map(({ id }) => id)).toEqual([
      'auto-1',
      'auto-2',
      'auto-3',
      'auto-4',
      'auto-5',
    ]);
  });
});

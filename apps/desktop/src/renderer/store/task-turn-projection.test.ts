import { describe, expect, it } from 'vitest';
import type { TurnSnapshot } from '../types/sprint-coder';
import {
  applyTaskTurnEvent,
  hydrateTaskTurn,
  type TaskTurnEvent,
  type TaskTurnProjection,
} from './task-turn-projection';

type Saved = Pick<TurnSnapshot, 'activeTurn' | 'queued'>;
const taskId = 'task';
const firstAt = Date.parse('2026-10-20T01:00:00.000Z');
const secondAt = firstAt + 10_000;
const queue = [{ ordinal: 1, text: '  synthetic queue\n' }];
function accepted(seq: number, turnId: string, at: number): TaskTurnEvent {
  return {
    type: 'turn.accepted',
    seq,
    taskId,
    turnId,
    userMessage: {
      id: `user-${turnId}`,
      taskId,
      turnId,
      author: 'user',
      content: 'synthetic',
      attachments: [],
      createdAt: new Date(at).toISOString(),
    },
  };
}
const approval: Extract<TaskTurnEvent, { type: 'approval.requested' }> = {
  type: 'approval.requested',
  seq: 5,
  taskId,
  turnId: 'a',
  approvalId: 'approval',
  approval: {
    id: 'approval',
    taskId,
    turnId: 'a',
    callId: 'call',
    state: 'pending',
    decision: null,
    revision: 0,
    policyEpoch: 0,
    toolName: 'read_file',
    reason: 'synthetic',
    target: 'sample',
    impact: 'read',
    execution: 'synthetic',
    risk: 'low',
    capability: 'workspace.read',
    challenge: 'challenge',
    createdAt: new Date(firstAt).toISOString(),
    expiresAt: new Date(secondAt).toISOString(),
  },
};
const history: TaskTurnEvent[] = [
  accepted(1, 'a', firstAt),
  { type: 'queue.changed', seq: 2, taskId, queued: queue },
  { type: 'stage.changed', seq: 3, taskId, turnId: 'a', stage: 'executing' },
  { type: 'message.delta', seq: 4, taskId, turnId: 'a', messageId: 'reply-a', delta: 'alpha' },
  approval,
  { type: 'stage.changed', seq: 6, taskId, turnId: 'a', stage: 'executing' },
  { type: 'message.delta', seq: 7, taskId, turnId: 'a', messageId: 'reply-a', delta: '\nomega' },
  { type: 'turn.completed', seq: 8, taskId, turnId: 'a', state: 'completed', diff: [] },
  { type: 'queue.changed', seq: 9, taskId, queued: [] },
  accepted(10, 'b', secondAt),
  { type: 'message.delta', seq: 11, taskId, turnId: 'b', messageId: 'reply-b', delta: 'beta' },
  { type: 'stage.changed', seq: 12, taskId, turnId: 'b', stage: 'planning' },
];
// Authored independently from the projector: persisted fields at explicit history cuts.
const snapshots: { lastSeq: number; saved: Saved }[] = [
  { lastSeq: 0, saved: { activeTurn: null, queued: [] } },
  {
    lastSeq: 1,
    saved: {
      activeTurn: {
        turnId: 'a',
        stage: 'understanding',
        startedAtEpochMs: firstAt,
        messageId: null,
        streamedText: '',
      },
      queued: [],
    },
  },
  {
    lastSeq: 4,
    saved: {
      activeTurn: {
        turnId: 'a',
        stage: 'executing',
        startedAtEpochMs: firstAt,
        messageId: 'reply-a',
        streamedText: 'alpha',
      },
      queued: queue,
    },
  },
  {
    lastSeq: 5,
    saved: {
      activeTurn: {
        turnId: 'a',
        stage: 'waiting_approval',
        startedAtEpochMs: firstAt,
        messageId: 'reply-a',
        streamedText: 'alpha',
      },
      queued: queue,
    },
  },
  {
    lastSeq: 6,
    saved: {
      activeTurn: {
        turnId: 'a',
        stage: 'executing',
        startedAtEpochMs: firstAt,
        messageId: 'reply-a',
        streamedText: 'alpha',
      },
      queued: queue,
    },
  },
  { lastSeq: 8, saved: { activeTurn: null, queued: queue } },
  {
    lastSeq: 10,
    saved: {
      activeTurn: {
        turnId: 'b',
        stage: 'understanding',
        startedAtEpochMs: secondAt,
        messageId: null,
        streamedText: '',
      },
      queued: [],
    },
  },
  {
    lastSeq: 12,
    saved: {
      activeTurn: {
        turnId: 'b',
        stage: 'planning',
        startedAtEpochMs: secondAt,
        messageId: 'reply-b',
        streamedText: 'beta',
      },
      queued: [],
    },
  },
];
function savedFields({ turn, queued }: TaskTurnProjection): Saved {
  return {
    queued,
    activeTurn:
      turn && (turn.status === 'running' || turn.status === 'canceling')
        ? {
            turnId: turn.turnId,
            stage: turn.stage,
            startedAtEpochMs: turn.startedAt,
            messageId: turn.streamingMessageId,
            streamedText: turn.streamingContent,
          }
        : null,
  };
}
function replay(start: TaskTurnProjection, events: TaskTurnEvent[]) {
  return events.reduce(
    (state, event) => applyTaskTurnEvent(state, event, secondAt + 60_000 + event.seq),
    start,
  );
}

describe('Task active-Turn and queue projection', () => {
  it.each(snapshots)(
    'matches independent snapshot at seq $lastSeq and every later cut after resuming',
    ({ lastSeq, saved }) => {
      const live = replay({ turn: undefined, queued: [] }, history.slice(0, lastSeq));
      expect(savedFields(live)).toEqual(saved);
      const restored = hydrateTaskTurn(saved);
      expect(savedFields(restored)).toEqual(saved);
      for (const later of snapshots.filter((cut) => cut.lastSeq >= lastSeq)) {
        const resumed = replay(restored, history.slice(lastSeq, later.lastSeq));
        expect(savedFields(resumed)).toEqual(later.saved);
        expect(savedFields(resumed)).toEqual(
          savedFields(replay({ turn: undefined, queued: [] }, history.slice(0, later.lastSeq))),
        );
      }
    },
  );

  it('separates startup, historical high stage, cancellation and terminal receipt time from persisted parity', () => {
    const initial = applyTaskTurnEvent({ turn: undefined, queued: [] }, history[0]!, secondAt);
    expect(initial.turn).toMatchObject({
      runtimeStarting: true,
      startedAt: firstAt,
      reachedStageIndex: 0,
    });
    const restored = hydrateTaskTurn(snapshots[1]!.saved);
    expect(restored.turn).toMatchObject({ runtimeStarting: false, startedAt: firstAt });
    const high = applyTaskTurnEvent(
      initial,
      { type: 'stage.changed', seq: 2, taskId, turnId: 'a', stage: 'synthesizing' },
      secondAt,
    );
    const waiting = applyTaskTurnEvent(high, approval, secondAt);
    const back = applyTaskTurnEvent(waiting, history[5]!, secondAt);
    expect(back.turn).toMatchObject({
      stage: 'executing',
      reachedStageIndex: 4,
      runtimeStarting: false,
    });
    expect(hydrateTaskTurn(savedFields(back)).turn?.reachedStageIndex).toBe(2);
    const canceling: TaskTurnProjection = { ...back, turn: { ...back.turn!, status: 'canceling' } };
    const streamed = applyTaskTurnEvent(canceling, history[3]!, secondAt);
    expect(streamed.turn).toMatchObject({ status: 'canceling', streamingContent: 'alpha' });
    expect(hydrateTaskTurn(savedFields(streamed)).turn?.status).toBe('running');
    const terminal = applyTaskTurnEvent(streamed, history[7]!, secondAt + 55);
    expect(terminal.turn).toMatchObject({
      status: 'completed',
      finishedAt: secondAt + 55,
      streamingContent: 'alpha',
    });
    expect(savedFields(terminal).activeTurn).toBeNull();
    expect(hydrateTaskTurn(savedFields(terminal)).turn).toBeUndefined();
  });

  it('retains existing approval semantics without resetting transient progress or adding a turn-id guard', () => {
    const current = applyTaskTurnEvent({ turn: undefined, queued: [] }, history[0]!, secondAt);
    const waiting = applyTaskTurnEvent(current, { ...approval, turnId: 'older' }, secondAt);
    expect(waiting.turn).toMatchObject({
      turnId: 'a',
      stage: 'waiting_approval',
      runtimeStarting: true,
      reachedStageIndex: 0,
    });
  });

  it('ignores other-Turn stages/deltas/completion and keeps the first streaming message id', () => {
    const current = replay({ turn: undefined, queued: [] }, history.slice(0, 4));
    for (const event of [history[2]!, history[3]!, history[7]!]) {
      if (!('turnId' in event)) throw new Error('fixture must be Turn-scoped');
      expect(applyTaskTurnEvent(current, { ...event, turnId: 'other' }, secondAt)).toBe(current);
    }
    expect(
      applyTaskTurnEvent(
        current,
        { type: 'message.delta', taskId, turnId: 'a', seq: 5, messageId: 'later-id', delta: '!' },
        secondAt,
      ).turn,
    ).toMatchObject({ streamingMessageId: 'reply-a', streamingContent: 'alpha!' });
  });

  it('does not mutate snapshot, queue, current Turn or event payloads', () => {
    const saved = structuredClone(snapshots[2]!.saved);
    Object.freeze(saved.activeTurn);
    Object.freeze(saved.queued);
    Object.freeze(saved);
    const current = hydrateTaskTurn(saved);
    Object.freeze(current.turn);
    Object.freeze(current);
    const before = structuredClone(current);
    const event = Object.freeze(history[6]!);
    const next = applyTaskTurnEvent(current, event, secondAt);
    expect(current).toEqual(before);
    expect(saved).toEqual(snapshots[2]!.saved);
    expect(next.turn?.streamingContent).toBe('alpha\nomega');
    expect(next.queued).toBe(saved.queued);
  });
});

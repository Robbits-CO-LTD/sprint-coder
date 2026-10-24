import type { QueuedInput, TurnEvent, TurnSnapshot, TurnStage } from '../types/sprint-coder';
import { advanceStageIndex } from '../lib/turn-progress';

export type TurnStatus =
  'running' | 'canceling' | 'completed' | 'canceled' | 'failed' | 'interrupted';

export type TurnRuntimeState = {
  turnId: string;
  stage: TurnStage;
  /** Transient only: true after Main accepts the Turn and before the Runtime emits its first stage. */
  runtimeStarting: boolean;
  /** Highest stage index reached, clamped so it never decreases (issue #16). `stage` alone is not
   * enough: `waiting_approval` sits between `executing` and `synthesizing` in STAGE_ORDER, so a turn
   * that returns to `executing` for a later tool would make a stage-derived gauge walk backwards. */
  reachedStageIndex: number;
  status: TurnStatus;
  startedAt: number;
  /** Set when the terminal event arrives so completed-work duration freezes truthfully. Historical
   * snapshots do not currently carry this timestamp; restored turns omit it instead of guessing. */
  finishedAt?: number;
  streamingMessageId: string | null;
  streamingContent: string;
};

/** One Task's Turn/queue display. Sequence recovery, Task selection and effects belong to the store.
 * runtimeStarting, reachedStageIndex, finishedAt and optimistic canceling are not persisted facts. */
export type TaskTurnProjection = {
  turn: TurnRuntimeState | undefined;
  queued: QueuedInput[];
};

export type TaskTurnEvent = Extract<
  TurnEvent,
  {
    type:
      | 'turn.accepted'
      | 'stage.changed'
      | 'approval.requested'
      | 'message.delta'
      | 'turn.completed'
      | 'queue.changed';
  }
>;

export function hydrateTaskTurn(
  snapshot: Pick<TurnSnapshot, 'activeTurn' | 'queued'>,
): TaskTurnProjection {
  const active = snapshot.activeTurn;
  return {
    turn: active
      ? {
          turnId: active.turnId,
          stage: active.stage,
          runtimeStarting: false,
          // A snapshot cannot recover the highest stage visited before its current stage.
          reachedStageIndex: advanceStageIndex(0, active.stage),
          status: 'running',
          startedAt: active.startedAtEpochMs,
          streamingMessageId: active.messageId,
          streamingContent: active.streamedText,
        }
      : undefined,
    queued: snapshot.queued,
  };
}

export function applyTaskTurnEvent(
  current: TaskTurnProjection,
  event: TaskTurnEvent,
  receivedAt: number,
): TaskTurnProjection {
  const turn = current.turn;
  switch (event.type) {
    case 'queue.changed':
      return { ...current, queued: event.queued };
    case 'turn.accepted':
      return {
        ...current,
        turn: {
          turnId: event.turnId,
          stage: 'understanding',
          runtimeStarting: true,
          reachedStageIndex: 0,
          status: 'running',
          // Main creates the user message and Turn with the same persisted timestamp.
          startedAt: Date.parse(event.userMessage.createdAt),
          streamingMessageId: null,
          streamingContent: '',
        },
      };
    case 'approval.requested':
      // Preserve the existing Task-level approval projection, including its transient fields.
      return turn ? { ...current, turn: { ...turn, stage: 'waiting_approval' } } : current;
    case 'stage.changed':
      return turn?.turnId === event.turnId
        ? {
            ...current,
            turn: {
              ...turn,
              stage: event.stage,
              runtimeStarting: false,
              reachedStageIndex: advanceStageIndex(turn.reachedStageIndex, event.stage),
            },
          }
        : current;
    case 'message.delta':
      return turn?.turnId === event.turnId
        ? {
            ...current,
            turn: {
              ...turn,
              streamingMessageId: turn.streamingMessageId ?? event.messageId,
              streamingContent: turn.streamingContent + event.delta,
            },
          }
        : current;
    case 'turn.completed':
      // Keep terminal UI data for RunCard/Timeline even though snapshots have no active Turn.
      return turn?.turnId === event.turnId
        ? { ...current, turn: { ...turn, status: event.state, finishedAt: receivedAt } }
        : current;
  }
}

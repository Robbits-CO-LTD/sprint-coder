import { STAGE_ORDER } from './stages';
import type { TurnStage } from '../types/sprint-coder';

// Progress arithmetic shared by running-Turn status surfaces. The Claude CLI does not settle a
// step count in advance, so this reports discrete stages rather than inventing a percentage.
//
// Kept as pure functions on a stage + status pair so the two properties that matter (never going
// backwards, never reaching complete before the turn does) are unit-testable without a DOM.

export type SegmentState = 'pending' | 'done' | 'current' | 'waiting' | 'failed' | 'complete';

export type TurnProgress = {
  segments: SegmentState[];
  /** Always null. Present so a caller cannot accidentally start rendering an invented number. */
  percent: null;
};

export const PROGRESS_SEGMENT_COUNT = STAGE_ORDER.length;

/**
 * Highest stage index this turn has reached.
 *
 * Clamped with `Math.max` against the previous value because stage events are not monotonic in
 * practice — `waiting_approval` sits between `executing` and `synthesizing` in STAGE_ORDER, so a
 * turn that goes executing → synthesizing → (approval on a later tool) → executing would otherwise
 * make the gauge walk backwards. A gauge that retreats reads as the work being undone.
 */
export function advanceStageIndex(previousIndex: number, stage: TurnStage): number {
  return Math.max(previousIndex, STAGE_ORDER.indexOf(stage));
}

export function turnProgress(input: {
  reachedIndex: number;
  stage: TurnStage;
  status: 'running' | 'canceling' | 'completed' | 'canceled' | 'failed' | 'interrupted';
}): TurnProgress {
  const terminal = input.status !== 'running' && input.status !== 'canceling';
  const failed = input.status === 'failed' || input.status === 'interrupted';
  const segments = STAGE_ORDER.map((_stage, index): SegmentState => {
    if (input.status === 'completed') return 'complete';
    if (failed) return index <= input.reachedIndex ? 'failed' : 'pending';
    // Canceled: what was reached stays reached, but nothing claims completion.
    if (terminal) return index <= input.reachedIndex ? 'done' : 'pending';
    if (index < input.reachedIndex) return 'done';
    if (index > input.reachedIndex) return 'pending';
    return input.stage === 'waiting_approval' ? 'waiting' : 'current';
  });
  return { segments, percent: null };
}

/**
 * True only for a turn that actually finished successfully.
 *
 * The issue asks that the gauge not read as complete before `turn.completed`; expressing that as its
 * own predicate keeps the rule in one place rather than spread across the renderer.
 */
export function isProgressComplete(progress: TurnProgress): boolean {
  return progress.segments.every((segment) => segment === 'complete');
}

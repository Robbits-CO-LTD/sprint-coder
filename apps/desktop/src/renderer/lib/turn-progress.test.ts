import { describe, expect, it } from 'vitest';
import { STAGE_ORDER } from './stages';
import {
  PROGRESS_SEGMENT_COUNT,
  advanceStageIndex,
  isProgressComplete,
  turnProgress,
} from './turn-progress';

// Issue #16. Two acceptance criteria are properties of this arithmetic rather than of the UI: the
// gauge must never go backwards, and must never read complete before `turn.completed`. Both are
// checked here so a renderer change cannot quietly break them.

describe('advanceStageIndex', () => {
  it('advances with the stage', () => {
    expect(advanceStageIndex(0, 'planning')).toBe(STAGE_ORDER.indexOf('planning'));
  });

  it('never retreats', () => {
    // The real case this guards: `waiting_approval` sits between `executing` and `synthesizing` in
    // STAGE_ORDER, so a turn that returns to `executing` for a later tool would make a
    // stage-derived gauge walk backwards. A gauge that retreats reads as work being undone.
    const executing = STAGE_ORDER.indexOf('executing');
    const synthesizing = STAGE_ORDER.indexOf('synthesizing');
    expect(advanceStageIndex(synthesizing, 'executing')).toBe(synthesizing);
    expect(advanceStageIndex(synthesizing, 'understanding')).toBe(synthesizing);
    expect(advanceStageIndex(executing, 'synthesizing')).toBe(synthesizing);
  });
});

describe('turnProgress', () => {
  const reached = (stage: (typeof STAGE_ORDER)[number]) => STAGE_ORDER.indexOf(stage);

  it('always yields exactly one segment per stage', () => {
    const progress = turnProgress({ reachedIndex: 0, stage: 'understanding', status: 'running' });
    expect(progress.segments).toHaveLength(PROGRESS_SEGMENT_COUNT);
    expect(PROGRESS_SEGMENT_COUNT).toBe(STAGE_ORDER.length);
  });

  it('never reports a percentage', () => {
    // The Claude CLI settles no step count in advance, so any number here would be invented — the
    // issue's "推定 % を演じない". Typed as `null` so a caller cannot start rendering one by accident.
    for (const status of ['running', 'completed', 'failed', 'canceled'] as const) {
      expect(turnProgress({ reachedIndex: 2, stage: 'executing', status }).percent).toBeNull();
    }
  });

  it('marks reached stages done and the current one current', () => {
    const progress = turnProgress({
      reachedIndex: reached('executing'),
      stage: 'executing',
      status: 'running',
    });
    expect(progress.segments[0]).toBe('done');
    expect(progress.segments[reached('executing')]).toBe('current');
    expect(progress.segments.at(-1)).toBe('pending');
  });

  it('distinguishes waiting on approval from working', () => {
    // Not decoration: an approval-blocked turn is stopped on the *user*, and showing it as active
    // work hides whose turn it is.
    const progress = turnProgress({
      reachedIndex: reached('waiting_approval'),
      stage: 'waiting_approval',
      status: 'running',
    });
    expect(progress.segments[reached('waiting_approval')]).toBe('waiting');
  });

  it('is not complete while the turn is still running, even at the last stage', () => {
    const progress = turnProgress({
      reachedIndex: STAGE_ORDER.length - 1,
      stage: 'synthesizing',
      status: 'running',
    });
    expect(isProgressComplete(progress)).toBe(false);
    expect(progress.segments).toContain('current');
  });

  it('is complete only once the turn completed', () => {
    expect(
      isProgressComplete(
        turnProgress({ reachedIndex: 0, stage: 'understanding', status: 'completed' }),
      ),
    ).toBe(true);
  });

  it('marks a failed or interrupted turn failed up to where it got', () => {
    for (const status of ['failed', 'interrupted'] as const) {
      const progress = turnProgress({
        reachedIndex: reached('executing'),
        stage: 'executing',
        status,
      });
      expect(progress.segments[0]).toBe('failed');
      expect(progress.segments.at(-1)).toBe('pending');
      expect(isProgressComplete(progress)).toBe(false);
    }
  });

  it('keeps a canceled turn at what it reached without claiming completion', () => {
    const progress = turnProgress({
      reachedIndex: reached('planning'),
      stage: 'planning',
      status: 'canceled',
    });
    expect(progress.segments[reached('planning')]).toBe('done');
    expect(progress.segments.at(-1)).toBe('pending');
    expect(isProgressComplete(progress)).toBe(false);
  });
});

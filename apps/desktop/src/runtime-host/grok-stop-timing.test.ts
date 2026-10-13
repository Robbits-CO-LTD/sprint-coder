import { describe, expect, it } from 'vitest';
import { GrokStopTimingRecorder } from './grok-stop-timing';
import { GROK_STOP_TIMING_MS_MAX } from './protocol';

describe('GrokStopTimingRecorder (issue #749)', () => {
  it('reports offsets from the first stop request and null for unobserved events', () => {
    let now = 1_000;
    const recorder = new GrokStopTimingRecorder(() => now);
    recorder.requested();
    now = 3_000;
    recorder.observe({ signal: 'SIGTERM', event: 'exit', exitCode: 128 });
    now = 3_050;
    recorder.requested(); // A later request does not move the origin.
    recorder.observe({ signal: 'SIGKILL', event: 'start' });
    expect(recorder.snapshot(1)).toEqual({
      settledMs: null,
      signalTaskkillExitMs: 2_000,
      signalTaskkillExitCode: 128,
      forceTaskkillStartMs: 2_050,
      forceTaskkillExitMs: null,
      forceTaskkillExitCode: null,
      rootExitMs: null,
      rootCloseMs: null,
      isolationRemaining: 1,
    });
  });

  it('clamps a root exit that preceded the stop to 0 and caps long offsets', () => {
    let now = 500;
    const recorder = new GrokStopTimingRecorder(() => now);
    recorder.rootExited();
    now = 1_000;
    recorder.requested();
    now = 1_000 + GROK_STOP_TIMING_MS_MAX + 5_000;
    recorder.rootClosed();
    recorder.settled();
    expect(recorder.snapshot(0)).toMatchObject({
      rootExitMs: 0,
      rootCloseMs: GROK_STOP_TIMING_MS_MAX,
      settledMs: GROK_STOP_TIMING_MS_MAX,
      isolationRemaining: 0,
    });
  });
});

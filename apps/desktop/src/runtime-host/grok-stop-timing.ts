import { GROK_STOP_TIMING_MS_MAX, type GrokStopTiming } from './protocol';
import type { RuntimeProcessTreeObservation } from './process-tree';

/**
 * Records when the pieces of a Grok stop happened (issue #749). It only observes: nothing here
 * decides whether the stop is confirmed. Offsets are from the first stop request.
 */
export class GrokStopTimingRecorder {
  private requestedAt: number | null = null;
  private settledAt: number | null = null;
  private rootExitAt: number | null = null;
  private rootCloseAt: number | null = null;
  private signalExitAt: number | null = null;
  private signalExitCode: number | null = null;
  private forceStartAt: number | null = null;
  private forceExitAt: number | null = null;
  private forceExitCode: number | null = null;

  constructor(private readonly now: () => number = () => performance.now()) {}

  requested(): void {
    this.requestedAt ??= this.now();
  }

  settled(): void {
    this.settledAt ??= this.now();
  }

  rootExited(): void {
    this.rootExitAt ??= this.now();
  }

  rootClosed(): void {
    this.rootCloseAt ??= this.now();
  }

  readonly observe = (observation: RuntimeProcessTreeObservation): void => {
    const at = this.now();
    const code = observation.exitCode ?? null;
    if (observation.signal === 'SIGTERM') {
      if (observation.event === 'exit') {
        this.signalExitAt ??= at;
        this.signalExitCode = code;
      }
    } else if (observation.event === 'start') this.forceStartAt ??= at;
    else {
      this.forceExitAt ??= at;
      this.forceExitCode = code;
    }
  };

  snapshot(isolationRemaining: 0 | 1): GrokStopTiming {
    const origin = this.requestedAt ?? 0;
    const offset = (at: number | null): number | null =>
      at === null ? null : Math.min(Math.max(0, Math.round(at - origin)), GROK_STOP_TIMING_MS_MAX);
    return {
      settledMs: offset(this.settledAt),
      signalTaskkillExitMs: offset(this.signalExitAt),
      signalTaskkillExitCode: this.signalExitCode,
      forceTaskkillStartMs: offset(this.forceStartAt),
      forceTaskkillExitMs: offset(this.forceExitAt),
      forceTaskkillExitCode: this.forceExitCode,
      rootExitMs: offset(this.rootExitAt),
      rootCloseMs: offset(this.rootCloseAt),
      isolationRemaining,
    };
  }
}

export type RuntimeProgressTimeoutPhase = 'first_event' | 'idle' | 'total';

export const RUNTIME_FIRST_EVENT_TIMEOUT_MS = 45_000;
export const RUNTIME_IDLE_TIMEOUT_MS = 90_000;

type RuntimeProgressDeadlineOptions = Readonly<{
  firstEventMs: number;
  idleMs: number;
  totalMs: number;
}>;

/**
 * Bounds both complete silence and mid-Turn stalls without shortening a long-running Team Turn.
 * The total deadline remains independent: progress renews only the activity timer.
 */
export class RuntimeProgressDeadline {
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  private totalTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly options: RuntimeProgressDeadlineOptions,
    private readonly onTimeout: (phase: RuntimeProgressTimeoutPhase) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleActivity('first_event', this.options.firstEventMs);
    this.totalTimer = setTimeout(() => this.expire('total'), this.options.totalMs);
    this.totalTimer.unref?.();
  }

  progress(): void {
    if (!this.running) return;
    this.scheduleActivity('idle', this.options.idleMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.activityTimer !== null) clearTimeout(this.activityTimer);
    if (this.totalTimer !== null) clearTimeout(this.totalTimer);
    this.activityTimer = null;
    this.totalTimer = null;
  }

  private scheduleActivity(phase: 'first_event' | 'idle', timeoutMs: number): void {
    if (this.activityTimer !== null) clearTimeout(this.activityTimer);
    this.activityTimer = setTimeout(() => this.expire(phase), timeoutMs);
    this.activityTimer.unref?.();
  }

  private expire(phase: RuntimeProgressTimeoutPhase): void {
    if (!this.running) return;
    this.stop();
    this.onTimeout(phase);
  }
}

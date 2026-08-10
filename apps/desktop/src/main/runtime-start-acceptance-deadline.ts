export const RUNTIME_START_ACCEPTANCE_TIMEOUT_MS = 15_000;

/**
 * Bounds the gap between Main posting a Runtime start envelope and the host confirming that the
 * adapter accepted it. Adapter progress deadlines cannot cover this gap because they start only
 * after the envelope has passed Runtime Host protocol validation.
 */
export class RuntimeStartAcceptanceDeadline {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly timeoutMs: number,
    private readonly onTimeout: () => void,
  ) {}

  start(): void {
    this.stop();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onTimeout();
    }, this.timeoutMs);
    this.timer.unref();
  }

  accept(): void {
    this.stop();
  }

  stop(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

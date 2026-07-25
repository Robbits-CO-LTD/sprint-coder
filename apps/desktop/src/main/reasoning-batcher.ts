// Coalesces reasoning fragments before they cross to the renderer (issue #17, NFR-PERF-05).
//
// Reasoning arrives at a much higher rate than answer text — one `thinking_delta` per few tokens —
// and the existing `message.delta` path already re-renders React once per delta. That only survives
// today because the mock runtime chunks a reply into 32 pieces; forwarding a real reasoning stream
// the same way would commit hundreds of times per turn.
//
// The batching interval mirrors command-runner.ts's own 100ms `batchIntervalMs`, nudged to 120ms
// because reasoning is the higher-frequency source of the two.
//
// This is a *transient* stream. Nothing here writes to the database, so there is no migration, no
// `turn_events` growth, and no replay on re-subscribe — the deliberate consequence of not persisting
// reasoning at all (see the issue's open question 1). The cost is that reopening a Task shows no
// earlier reasoning, which the UI states rather than hides.

export const REASONING_FLUSH_INTERVAL_MS = 120;
/** Flush early once a batch reaches this size, so a burst does not sit waiting for the timer. */
export const REASONING_FLUSH_BYTES = 4 * 1024;
/** Per-turn ceiling. Past this, fragments are dropped and `truncated` latches true. */
export const REASONING_TURN_BUDGET_BYTES = 32 * 1024;

export type ReasoningFlush = { text: string; truncated: boolean };

/**
 * One batcher per turn.
 *
 * Deliberately not a singleton keyed by turnId: the lifetime of the buffer is exactly the lifetime
 * of the turn, and tying it to the object that owns the turn makes "did we leak a timer?" answerable
 * by looking at one place.
 */
export class ReasoningBatcher {
  private buffer = '';
  private bufferedBytes = 0;
  private emittedBytes = 0;
  private truncated = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly emit: (flush: ReasoningFlush) => void,
    private readonly intervalMs = REASONING_FLUSH_INTERVAL_MS,
  ) {}

  push(text: string): void {
    if (this.disposed || text === '') return;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (this.emittedBytes + this.bufferedBytes + bytes > REASONING_TURN_BUDGET_BYTES) {
      // Latches rather than dropping silently: the renderer needs to say the reasoning is
      // incomplete, or a truncated trail reads as the model's whole thought process.
      if (!this.truncated) {
        this.truncated = true;
        this.flush();
      }
      return;
    }
    this.buffer += text;
    this.bufferedBytes += bytes;
    if (this.bufferedBytes >= REASONING_FLUSH_BYTES) {
      this.flush();
      return;
    }
    if (this.timer === null) this.timer = setTimeout(() => this.flush(), this.intervalMs);
  }

  /** Sends whatever is buffered. Safe to call when empty — it emits nothing. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer === '') {
      // Still worth emitting if truncation just latched: that is a state change with no text.
      if (this.truncated) this.emit({ text: '', truncated: true });
      return;
    }
    const text = this.buffer;
    this.buffer = '';
    this.emittedBytes += this.bufferedBytes;
    this.bufferedBytes = 0;
    this.emit({ text, truncated: this.truncated });
  }

  /** Flushes the tail and stops the timer. Must be called when the turn ends. */
  dispose(): void {
    if (this.disposed) return;
    this.flush();
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

import { ReasoningBatcher, type ReasoningFlush } from './reasoning-batcher';
import { createStreamingSecretRedactor, type StreamingSecretRedactor } from './secret-redactor';
import type { WorkspaceWatcher } from './workspace-watcher';

type WatcherGroup = { closed: boolean; watchers: readonly WorkspaceWatcher[] };
type ReasoningSink = (taskId: string, turnId: string, flush: ReasoningFlush) => void;
type WatcherFactory = (isCurrent: () => boolean) => readonly WorkspaceWatcher[];
export type TurnStreamingLease = {
  pushReasoning(text: string): void;
  replaceWatchers(create: WatcherFactory): void;
};

/** Owns only live reasoning buffers and workspace previews, never Runtime or durable Turn state. */
export class TurnStreamingResources {
  private readonly active = new Map<string, ActiveTurnStreamingLease>();
  private disposed = false;

  constructor(private readonly emit: ReasoningSink) {}

  get size(): number {
    return this.active.size;
  }

  begin(taskId: string, turnId: string): TurnStreamingLease | undefined {
    if (this.disposed) return undefined;
    const existing = this.active.get(turnId);
    if (existing !== undefined) {
      if (existing.taskId !== taskId) throw new Error('Turn streaming Task identity mismatch');
      return existing;
    }
    const lease = new ActiveTurnStreamingLease(
      taskId,
      () => !this.disposed,
      (flush) => this.emit(taskId, turnId, flush),
    );
    this.active.set(turnId, lease);
    return lease;
  }

  get(taskId: string, turnId: string): TurnStreamingLease | undefined {
    if (this.disposed) return undefined;
    const lease = this.active.get(turnId);
    return lease?.taskId === taskId ? lease : undefined;
  }

  release(turnId: string): void {
    const lease = this.active.get(turnId);
    this.active.delete(turnId);
    lease?.close();
  }

  dispose(): void {
    if (this.disposed) return;
    // Captured callbacks on every lease must be invalid before the first final emit can reenter.
    this.disposed = true;
    const leases = [...this.active.values()];
    this.active.clear();
    let failure: { cause: unknown } | undefined;
    for (const lease of leases) {
      try {
        lease.close();
      } catch (error) {
        failure ??= { cause: error };
      }
    }
    if (failure !== undefined) throw failure.cause;
  }
}

class ActiveTurnStreamingLease implements TurnStreamingLease {
  private closed = false;
  private redactor: StreamingSecretRedactor | undefined;
  private batcher: ReasoningBatcher | undefined;
  private group: WatcherGroup | undefined;

  constructor(
    readonly taskId: string,
    private readonly registryOpen: () => boolean,
    private readonly emit: (flush: ReasoningFlush) => void,
  ) {}

  private isOpen(): boolean {
    return !this.closed && this.registryOpen();
  }

  pushReasoning(text: string): void {
    if (!this.isOpen()) return;
    this.redactor ??= createStreamingSecretRedactor();
    const safe = this.redactor.write(text);
    this.batcher ??= new ReasoningBatcher(this.emit);
    if (safe !== '') this.batcher.push(safe);
  }

  replaceWatchers(create: WatcherFactory): void {
    if (!this.isOpen()) return;
    const previous = this.detachWatchers();
    const group: WatcherGroup = { closed: false, watchers: [] };
    this.group = group;
    const isCurrent = () => this.isOpen() && !group.closed && this.group === group;
    for (const watcher of previous) watcher.stop();
    // Stopping the old group may have released this Turn or replaced the candidate group.
    if (!isCurrent()) return;
    const watchers = create(isCurrent);
    if (isCurrent()) group.watchers = watchers;
    else for (const watcher of watchers) watcher.stop();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const batcher = this.batcher;
    this.batcher = undefined;
    // The raw redactor carry is deliberately dropped, not ended/flushed.
    this.redactor = undefined;
    const watchers = this.detachWatchers();
    try {
      // Closing blocks new input; it must not suppress this already-redacted buffered tail.
      batcher?.dispose();
    } finally {
      for (const watcher of watchers) watcher.stop();
    }
  }

  private detachWatchers(): readonly WorkspaceWatcher[] {
    const group = this.group;
    this.group = undefined;
    if (group === undefined) return [];
    group.closed = true;
    const watchers = group.watchers;
    group.watchers = [];
    return watchers;
  }
}

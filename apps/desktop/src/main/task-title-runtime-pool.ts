export type TaskTitleRuntimeKind = 'codex' | 'claude' | 'grok';

/**
 * Owns Runtime Hosts used only by background title generation. A host is created lazily per CLI
 * kind, so cancelling or restarting it can never terminate a foreground conversation Turn.
 */
export class TaskTitleRuntimePool<T extends { dispose(): void }> {
  private readonly runtimes = new Map<TaskTitleRuntimeKind, T>();

  constructor(private readonly create: (kind: TaskTitleRuntimeKind) => T) {}

  get(kind: TaskTitleRuntimeKind): T {
    const existing = this.runtimes.get(kind);
    if (existing !== undefined) return existing;
    const runtime = this.create(kind);
    this.runtimes.set(kind, runtime);
    return runtime;
  }

  dispose(): void {
    for (const runtime of this.runtimes.values()) runtime.dispose();
    this.runtimes.clear();
  }
}

/** Tracks provider requests so app teardown can stop background billing/work immediately. */
export class TaskTitleAbortRegistry {
  private readonly controllers = new Set<AbortController>();

  track(controller: AbortController): () => void {
    this.controllers.add(controller);
    return () => this.controllers.delete(controller);
  }

  abortAll(): void {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
}

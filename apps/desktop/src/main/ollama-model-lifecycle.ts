export type OllamaModelTarget = Readonly<{
  endpoint: string;
  modelId: string;
}>;

export type ProviderModelLease = Readonly<{
  release(): Promise<void>;
}>;

type Entry = {
  readonly key: string;
  readonly target: OllamaModelTarget;
  readonly leases: Map<symbol, boolean>;
  pendingUnload: boolean;
  unloadPromise: Promise<void> | null;
};

export class OllamaModelLeaseCoordinator {
  private readonly entries = new Map<string, Entry>();
  private readonly changed = new Set<() => void>();
  private phase: 'open' | 'closing' | 'disposed' = 'open';

  constructor(
    private readonly unload: (target: OllamaModelTarget) => Promise<void>,
    private readonly onUnloadError: (target: OllamaModelTarget, error: unknown) => void,
    private readonly drainTimeoutMs = 2_000,
  ) {}

  async acquire(target: OllamaModelTarget, automaticRelease: boolean): Promise<ProviderModelLease> {
    const key = `${target.endpoint}\u0000${target.modelId}`;
    for (;;) {
      if (this.phase !== 'open') throw new Error('Provider model lifecycle is shutting down');
      let entry = this.entries.get(key);
      if (entry === undefined) {
        entry = {
          key,
          target,
          leases: new Map(),
          pendingUnload: false,
          unloadPromise: null,
        };
        this.entries.set(key, entry);
      }
      const unloading = entry.unloadPromise;
      if (unloading !== null) {
        await unloading;
        continue;
      }
      if (this.phase !== 'open' || this.entries.get(key) !== entry) continue;
      const leaseId = Symbol(key);
      entry.leases.set(leaseId, automaticRelease);
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          await this.release(entry, leaseId);
        },
      };
    }
  }

  async dispose(): Promise<void> {
    if (this.phase === 'disposed') return;
    if (this.phase === 'closing') {
      await this.waitUntilDisposed();
      return;
    }
    this.phase = 'closing';
    this.notifyChanged();
    const deadline = Date.now() + this.drainTimeoutMs;
    while (this.activeLeaseCount() > 0 && Date.now() < deadline)
      await this.waitForChange(Math.max(1, deadline - Date.now()));

    const unloads = [...this.entries.values()].flatMap((entry) => {
      const shouldUnload =
        entry.pendingUnload || [...entry.leases.values()].some((automatic) => automatic);
      return shouldUnload ? [this.ensureUnload(entry)] : [];
    });
    await Promise.all(unloads);
    this.phase = 'disposed';
    this.entries.clear();
    this.notifyChanged();
  }

  private async release(entry: Entry, leaseId: symbol): Promise<void> {
    if (!entry.leases.has(leaseId)) return;
    const automaticRelease = entry.leases.get(leaseId) === true;
    entry.leases.delete(leaseId);
    entry.pendingUnload ||= automaticRelease;
    this.notifyChanged();
    if (this.entries.get(entry.key) !== entry || entry.leases.size > 0) return;
    if (!entry.pendingUnload) {
      this.entries.delete(entry.key);
      return;
    }
    await this.ensureUnload(entry);
  }

  private ensureUnload(entry: Entry): Promise<void> {
    if (entry.unloadPromise !== null) return entry.unloadPromise;
    let failed = false;
    const unloading = this.unload(entry.target)
      .catch((error: unknown) => {
        failed = true;
        try {
          this.onUnloadError(entry.target, error);
        } catch {
          // Cleanup diagnostics must never replace the completed Turn result.
        }
      })
      .finally(() => {
        if (entry.unloadPromise === unloading) entry.unloadPromise = null;
        if (!failed && this.entries.get(entry.key) === entry && entry.leases.size === 0)
          this.entries.delete(entry.key);
        this.notifyChanged();
      });
    entry.unloadPromise = unloading;
    return unloading;
  }

  private activeLeaseCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) count += entry.leases.size;
    return count;
  }

  private waitForChange(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.changed.delete(done);
        resolve();
      }, timeoutMs);
      const done = (): void => {
        clearTimeout(timer);
        this.changed.delete(done);
        resolve();
      };
      this.changed.add(done);
    });
  }

  private async waitUntilDisposed(): Promise<void> {
    while (this.phase !== 'disposed') await this.waitForChange(this.drainTimeoutMs);
  }

  private notifyChanged(): void {
    for (const notify of [...this.changed]) notify();
  }
}

import { randomUUID } from 'node:crypto';

export type TeamIntegrationJob = Readonly<{
  executionId: string;
  mutationKeys: readonly string[];
  run(): Promise<void>;
}>;

type QueuedIntegration = TeamIntegrationJob & {
  /** A read of the parent checkout, not an integration that changes it. */
  exclusiveRead: boolean;
  resolve(): void;
  reject(error: unknown): void;
};

/** Resource-aware FIFO for the short parent-Workspace mutation phase. */
export class TeamIntegrationScheduler {
  private readonly queued: QueuedIntegration[] = [];
  private readonly active = new Map<string, QueuedIntegration>();
  /** How many integrations have started on each mutation key, for `readBesideIntegrations`. */
  private readonly integrationStarts = new Map<string, number>();
  private pumpScheduled = false;

  submit(job: TeamIntegrationJob): Promise<void> {
    return this.enqueue(job, false);
  }

  /**
   * Runs `run` while no integration holds any of `mutationKeys`, so it never overlaps one
   * (issue #853): a read of a parent checkout then sees it only before or after an integration
   * changes it. It waits only for the integrations already running on those keys and goes ahead
   * of the queued ones (issue #864): a read between any two integrations is as good as one after
   * all of them, and waiting for the whole queue held up every assignment behind it. A snapshot
   * lists it under an `exclusive:` ID.
   */
  async runExclusive<T>(mutationKeys: readonly string[], run: () => Promise<T>): Promise<T> {
    let result: { value: T } | undefined;
    await this.enqueue(
      {
        executionId: `exclusive:${randomUUID()}`,
        mutationKeys,
        run: async () => {
          result = { value: await run() };
        },
      },
      true,
    );
    if (result === undefined) throw new Error('Exclusive run completed without a result');
    return result.value;
  }

  /**
   * Runs a read of the parent checkout beside the integrations on `mutationKeys`, without waiting
   * for them (issue #864). An integration leaves its own changes in the checkout only while it
   * runs, so a read that succeeds is kept. A read that fails while an integration ran on those keys
   * may have seen that integration's temporary state (issue #853), so it is read again between
   * integrations with `runExclusive`, which waits for the running integration only. A read that
   * fails with no integration beside it saw the checkout's own state and fails as it is.
   */
  async readBesideIntegrations<T>(
    mutationKeys: readonly string[],
    read: () => Promise<T>,
  ): Promise<T> {
    const keys = normalizedKeys(mutationKeys);
    const integratingBefore = this.integrating(keys);
    const startsBefore = this.integrationStartCount(keys);
    try {
      return await read();
    } catch (error) {
      if (
        !integratingBefore &&
        !this.integrating(keys) &&
        this.integrationStartCount(keys) === startsBefore
      )
        throw error;
      return this.runExclusive(keys, read);
    }
  }

  private integrating(keys: readonly string[]): boolean {
    return [...this.active.values()].some(
      (job) => !job.exclusiveRead && job.mutationKeys.some((key) => keys.includes(key)),
    );
  }

  private integrationStartCount(keys: readonly string[]): number {
    return keys.reduce((sum, key) => sum + (this.integrationStarts.get(key) ?? 0), 0);
  }

  private async enqueue(job: TeamIntegrationJob, exclusiveRead: boolean): Promise<void> {
    const executionId = job.executionId.trim();
    const mutationKeys = normalizedKeys(job.mutationKeys);
    if (executionId === '') throw new Error('Integration execution ID is required');
    if (mutationKeys.length === 0 || mutationKeys.some((key) => key === ''))
      throw new Error('Integration mutation keys are required');
    if (
      this.active.has(executionId) ||
      this.queued.some((candidate) => candidate.executionId === executionId)
    )
      throw new Error('Integration execution is already scheduled');
    return new Promise<void>((resolve, reject) => {
      const queued: QueuedIntegration = {
        ...job,
        executionId,
        mutationKeys,
        exclusiveRead,
        resolve,
        reject,
      };
      // An exclusive read goes after the earlier reads and before every queued integration.
      const index = exclusiveRead
        ? this.queued.findIndex((candidate) => !candidate.exclusiveRead)
        : -1;
      if (index === -1) this.queued.push(queued);
      else this.queued.splice(index, 0, queued);
      this.schedulePump();
    });
  }

  snapshot(): Readonly<{
    activeExecutionIds: readonly string[];
    queuedExecutionIds: readonly string[];
  }> {
    return {
      activeExecutionIds: [...this.active.keys()],
      // The queue is kept in admission order: FIFO, with exclusive reads ahead of integrations.
      queuedExecutionIds: this.queued.map(({ executionId }) => executionId),
    };
  }

  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    for (;;) {
      const index = this.nextAdmissibleIndex();
      if (index === -1) return;
      const [job] = this.queued.splice(index, 1);
      if (job === undefined) return;
      this.active.set(job.executionId, job);
      if (!job.exclusiveRead)
        for (const key of job.mutationKeys)
          this.integrationStarts.set(key, (this.integrationStarts.get(key) ?? 0) + 1);
      void this.run(job);
    }
  }

  private nextAdmissibleIndex(): number {
    const activeKeys = new Set(
      [...this.active.values()].flatMap(({ mutationKeys }) => mutationKeys),
    );
    for (let index = 0; index < this.queued.length; index += 1) {
      const job = this.queued[index];
      if (job === undefined || job.mutationKeys.some((key) => activeKeys.has(key))) continue;
      const blockedByEarlier = this.queued
        .slice(0, index)
        .some((earlier) => earlier.mutationKeys.some((key) => job.mutationKeys.includes(key)));
      if (!blockedByEarlier) return index;
    }
    return -1;
  }

  private async run(job: QueuedIntegration): Promise<void> {
    try {
      await job.run();
      job.resolve();
    } catch (error) {
      job.reject(error);
    } finally {
      this.active.delete(job.executionId);
      this.schedulePump();
    }
  }
}

function normalizedKeys(mutationKeys: readonly string[]): string[] {
  return [...new Set(mutationKeys.map((key) => key.trim()))].sort();
}

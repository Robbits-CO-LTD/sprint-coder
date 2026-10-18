import { randomUUID } from 'node:crypto';

export type TeamIntegrationJob = Readonly<{
  executionId: string;
  mutationKeys: readonly string[];
  run(): Promise<void>;
}>;

type QueuedIntegration = TeamIntegrationJob & {
  ordinal: number;
  resolve(): void;
  reject(error: unknown): void;
};

/** Resource-aware FIFO for the short parent-Workspace mutation phase. */
export class TeamIntegrationScheduler {
  private readonly queued: QueuedIntegration[] = [];
  private readonly active = new Map<string, QueuedIntegration>();
  private nextOrdinal = 1;
  private pumpScheduled = false;

  submit(job: TeamIntegrationJob): Promise<void> {
    return this.enqueue(job);
  }

  /**
   * Runs `run` in the same FIFO as the integrations holding any of `mutationKeys`, so it never
   * overlaps one (issue #853): a read of a parent checkout then sees it only before or after an
   * integration changes it. A snapshot lists it under an `exclusive:` ID.
   */
  async runExclusive<T>(mutationKeys: readonly string[], run: () => Promise<T>): Promise<T> {
    let result: { value: T } | undefined;
    await this.enqueue({
      executionId: `exclusive:${randomUUID()}`,
      mutationKeys,
      run: async () => {
        result = { value: await run() };
      },
    });
    if (result === undefined) throw new Error('Exclusive run completed without a result');
    return result.value;
  }

  private async enqueue(job: TeamIntegrationJob): Promise<void> {
    const executionId = job.executionId.trim();
    const mutationKeys = [...new Set(job.mutationKeys.map((key) => key.trim()))].sort();
    if (executionId === '') throw new Error('Integration execution ID is required');
    if (mutationKeys.length === 0 || mutationKeys.some((key) => key === ''))
      throw new Error('Integration mutation keys are required');
    if (
      this.active.has(executionId) ||
      this.queued.some((candidate) => candidate.executionId === executionId)
    )
      throw new Error('Integration execution is already scheduled');
    return new Promise<void>((resolve, reject) => {
      this.queued.push({
        ...job,
        executionId,
        mutationKeys,
        ordinal: this.nextOrdinal,
        resolve,
        reject,
      });
      this.nextOrdinal += 1;
      this.schedulePump();
    });
  }

  snapshot(): Readonly<{
    activeExecutionIds: readonly string[];
    queuedExecutionIds: readonly string[];
  }> {
    return {
      activeExecutionIds: [...this.active.keys()],
      queuedExecutionIds: [...this.queued]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map(({ executionId }) => executionId),
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

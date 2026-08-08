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

  async submit(job: TeamIntegrationJob): Promise<void> {
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

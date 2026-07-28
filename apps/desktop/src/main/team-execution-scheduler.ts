export const TEAM_GLOBAL_EXECUTION_LIMIT = 8;

export type TeamExecutionJob = Readonly<{
  executionId: string;
  teamId: string;
  teamLimit: number;
  run(): Promise<void>;
}>;

export type TeamExecutionSchedulerSnapshot = Readonly<{
  activeCount: number;
  queuedExecutionIds: readonly string[];
  activeExecutionIds: readonly string[];
}>;

type QueuedJob = TeamExecutionJob & { ordinal: number };

/**
 * Core-only admission control for local Claude/Codex executions.
 *
 * Provider/Connection rate limits deliberately do not live here. P1B adds the second admission
 * stage around this global Team boundary while keeping built-in CLI Connections exempt.
 */
export class TeamExecutionScheduler {
  private readonly queued: QueuedJob[] = [];
  private readonly active = new Map<string, QueuedJob>();
  private readonly requeueAfterRun = new Map<string, TeamExecutionJob>();
  private nextOrdinal = 1;
  private pumpScheduled = false;

  constructor(private readonly globalLimit = TEAM_GLOBAL_EXECUTION_LIMIT) {
    if (!Number.isSafeInteger(globalLimit) || globalLimit < 1)
      throw new Error('Team global execution limit must be a positive integer');
  }

  submit(job: TeamExecutionJob): void {
    if (job.executionId.trim() === '') throw new Error('Execution ID is required');
    if (job.teamId.trim() === '') throw new Error('Team ID is required');
    if (!Number.isSafeInteger(job.teamLimit) || job.teamLimit < 1)
      throw new Error('Team execution limit must be a positive integer');
    if (
      this.active.has(job.executionId) ||
      this.queued.some(({ executionId }) => executionId === job.executionId)
    )
      throw new Error('Execution is already scheduled');
    this.queued.push({ ...job, ordinal: this.nextOrdinal });
    this.nextOrdinal += 1;
    this.schedulePump();
  }

  cancelQueued(executionId: string): boolean {
    const index = this.queued.findIndex((job) => job.executionId === executionId);
    if (index === -1) return false;
    this.queued.splice(index, 1);
    return true;
  }

  requeueActive(executionId: string, replacement: TeamExecutionJob): boolean {
    if (!this.active.has(executionId)) return false;
    if (replacement.executionId !== executionId)
      throw new Error('A resumed job must keep the same execution ID');
    if (this.requeueAfterRun.has(executionId))
      throw new Error('Execution already has a pending resume');
    this.requeueAfterRun.set(executionId, replacement);
    return true;
  }

  snapshot(): TeamExecutionSchedulerSnapshot {
    return {
      activeCount: this.active.size,
      queuedExecutionIds: [...this.queued]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map(({ executionId }) => executionId),
      activeExecutionIds: [...this.active.keys()],
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
    while (this.active.size < this.globalLimit) {
      const index = this.nextAdmissibleIndex();
      if (index === -1) return;
      const [job] = this.queued.splice(index, 1);
      if (job === undefined) return;
      this.active.set(job.executionId, job);
      // The job owns durable failure recording. Admission control must still release its slot
      // without turning that already-recorded failure into an unhandled process rejection.
      void this.run(job).catch(() => undefined);
    }
  }

  private nextAdmissibleIndex(): number {
    const activeByTeam = new Map<string, number>();
    for (const job of this.active.values())
      activeByTeam.set(job.teamId, (activeByTeam.get(job.teamId) ?? 0) + 1);
    return this.queued.findIndex(
      (job) => (activeByTeam.get(job.teamId) ?? 0) < job.teamLimit,
    );
  }

  private async run(job: QueuedJob): Promise<void> {
    try {
      await job.run();
    } finally {
      this.active.delete(job.executionId);
      const replacement = this.requeueAfterRun.get(job.executionId);
      if (replacement !== undefined) {
        this.requeueAfterRun.delete(job.executionId);
        this.queued.push({ ...replacement, ordinal: this.nextOrdinal });
        this.nextOrdinal += 1;
      }
      this.schedulePump();
    }
  }
}

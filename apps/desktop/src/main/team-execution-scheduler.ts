import type { ProviderConnection } from '@sprint-coder/contracts';
import type {
  ConnectionAdmissionController,
  ConnectionAdmissionCandidate,
  ConnectionWaitReason,
} from './connection-admission';

export const TEAM_GLOBAL_EXECUTION_LIMIT = 8;

export type TeamExecutionJob = Readonly<{
  executionId: string;
  workerId: string;
  teamId: string;
  teamLimit: number;
  connection?: Readonly<{
    connectionId: string;
    queueOrdinal: number;
    queuedAt: string;
    estimatedTokens: number;
  }>;
  onConnectionWait?(reason: ConnectionWaitReason): void;
  onWorkerWaitChanged?(waiting: boolean): void;
  /** Main checks graph dependencies, physical claims and durable resource owners before slots.
   * This read-only observation never replaces the transaction immediately before dispatch. */
  isReady?(): boolean;
  onReadinessError?(error: unknown): void;
  notBeforeMs?: number;
  run(): Promise<void>;
}>;

export type TeamExecutionSchedulerSnapshot = Readonly<{
  activeCount: number;
  queuedExecutionIds: readonly string[];
  activeExecutionIds: readonly string[];
  waitingWorkerExecutionIds: readonly string[];
}>;

type QueuedJob = TeamExecutionJob & { ordinal: number; waitingForWorker: boolean };

/**
 * Core-only admission control for local Claude/Codex executions.
 *
 * Provider/Connection rate limits deliberately do not live here. P1B adds the second admission
 * stage around this global Team boundary while keeping built-in CLI Connections exempt.
 */
export class TeamExecutionScheduler {
  private readonly queued: QueuedJob[] = [];
  private readonly active = new Map<string, QueuedJob>();
  private readonly preflightExecutionIds = new Set<string>();
  private readonly cancellationRequests = new Set<string>();
  private readonly requeueAfterRun = new Map<string, TeamExecutionJob>();
  private nextOrdinal = 1;
  private pumpScheduled = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly globalLimit = TEAM_GLOBAL_EXECUTION_LIMIT,
    private readonly connectionAdmission?: ConnectionAdmissionController,
  ) {
    if (!Number.isSafeInteger(globalLimit) || globalLimit < 1)
      throw new Error('Team global execution limit must be a positive integer');
  }

  configureConnection(connection: ProviderConnection): void {
    this.connectionAdmission?.configure(connection);
  }

  /** State changes outside an active run (for example confirmed recovery) can unblock work. */
  notifyReadinessChanged(): void {
    this.schedulePump();
  }

  submit(job: TeamExecutionJob): void {
    if (job.executionId.trim() === '') throw new Error('Execution ID is required');
    if (job.workerId.trim() === '') throw new Error('Worker ID is required');
    if (job.teamId.trim() === '') throw new Error('Team ID is required');
    if (!Number.isSafeInteger(job.teamLimit) || job.teamLimit < 1)
      throw new Error('Team execution limit must be a positive integer');
    if (
      this.active.has(job.executionId) ||
      this.queued.some(({ executionId }) => executionId === job.executionId)
    )
      throw new Error('Execution is already scheduled');
    this.queued.push({ ...job, ordinal: this.nextOrdinal, waitingForWorker: false });
    this.nextOrdinal += 1;
    this.schedulePump();
  }

  cancelQueued(executionId: string): boolean {
    const index = this.queued.findIndex((job) => job.executionId === executionId);
    if (index !== -1) {
      this.queued.splice(index, 1);
      return true;
    }
    // Admission moves a job to active before Coordinator preflight changes its durable state to
    // running. Preserve a cancellation tombstone across that await window so the admitted job can
    // stop before it dispatches any runtime work.
    if (this.preflightExecutionIds.has(executionId)) {
      this.cancellationRequests.add(executionId);
      this.requeueAfterRun.delete(executionId);
      return true;
    }
    // A rate-limited or steered execution can already be durably waiting while its replacement
    // job is parked here until the current run's finally block. Removing that replacement is part
    // of canceling a queued execution; otherwise a stopped Worker could restart moments later.
    return this.requeueAfterRun.delete(executionId);
  }

  isCancellationRequested(executionId: string): boolean {
    return this.cancellationRequests.has(executionId);
  }

  tryFinishPreflight(executionId: string): boolean {
    if (!this.preflightExecutionIds.has(executionId) || this.cancellationRequests.has(executionId))
      return false;
    this.preflightExecutionIds.delete(executionId);
    return true;
  }

  requeueActive(executionId: string, replacement: TeamExecutionJob): boolean {
    const current = this.active.get(executionId);
    if (!current) return false;
    if (replacement.executionId !== executionId)
      throw new Error('A resumed job must keep the same execution ID');
    if (replacement.workerId !== current.workerId || replacement.teamId !== current.teamId)
      throw new Error('A resumed job must keep its Worker and Team');
    if (this.requeueAfterRun.has(executionId))
      throw new Error('Execution already has a pending resume');
    this.requeueAfterRun.set(executionId, replacement);
    return true;
  }

  snapshot(): TeamExecutionSchedulerSnapshot {
    const workers = new Set([...this.active.values()].map((job) => job.workerId));
    return {
      activeCount: this.active.size,
      queuedExecutionIds: [...this.queued]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map(({ executionId }) => executionId),
      activeExecutionIds: [...this.active.keys()],
      waitingWorkerExecutionIds: this.queued
        .filter((job) => workers.has(job.workerId))
        .map((job) => job.executionId),
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
      if (job.connection !== undefined) this.connectionAdmission?.admit(toAdmissionCandidate(job));
      this.active.set(job.executionId, job);
      this.preflightExecutionIds.add(job.executionId);
      // The job owns durable failure recording. Admission control must still release its slot
      // without turning that already-recorded failure into an unhandled process rejection.
      void this.run(job).catch(() => undefined);
    }
  }

  private nextAdmissibleIndex(): number {
    const activeWorkers = new Set([...this.active.values()].map((job) => job.workerId));
    for (const job of this.queued) {
      const waiting = activeWorkers.has(job.workerId);
      if (waiting !== job.waitingForWorker) {
        job.waitingForWorker = waiting;
        job.onWorkerWaitChanged?.(waiting);
      }
    }
    const activeByTeam = new Map<string, number>();
    for (const job of this.active.values())
      activeByTeam.set(job.teamId, (activeByTeam.get(job.teamId) ?? 0) + 1);
    // A readiness error callback may remove its invalid job. Compute indices after callbacks.
    const ready = new Set([...this.queued].filter((job) => this.isJobReady(job)));
    const teamAdmissible = this.queued
      .map((job, index) => ({ job, index }))
      .filter(
        ({ job }) =>
          !activeWorkers.has(job.workerId) &&
          (activeByTeam.get(job.teamId) ?? 0) < job.teamLimit &&
          ready.has(job),
      );
    if (teamAdmissible.length === 0) return -1;
    const now = Date.now();
    const timeAdmissible = teamAdmissible.filter(
      ({ job }) => job.notBeforeMs === undefined || job.notBeforeMs <= now,
    );
    if (timeAdmissible.length === 0) {
      const earliest = Math.min(...teamAdmissible.map(({ job }) => job.notBeforeMs ?? now));
      this.scheduleRetry(Math.max(1, earliest - now));
      return -1;
    }
    if (this.connectionAdmission === undefined) return timeAdmissible[0]!.index;
    const withConnection = timeAdmissible.filter(({ job }) => job.connection !== undefined);
    if (withConnection.length === 0) return timeAdmissible[0]!.index;
    const selected = this.connectionAdmission.selectNext(
      withConnection.map(({ job }) => toAdmissionCandidate(job)),
    );
    if (selected !== -1) return withConnection[selected]!.index;
    const legacy = timeAdmissible.find(({ job }) => job.connection === undefined);
    if (legacy !== undefined) return legacy.index;
    for (const { job } of withConnection) {
      const reason = this.connectionAdmission.waitReason(toAdmissionCandidate(job));
      if (reason !== null) job.onConnectionWait?.(reason);
    }
    this.scheduleRetry(250);
    return -1;
  }

  private isJobReady(job: QueuedJob): boolean {
    try {
      return job.isReady?.() ?? true;
    } catch (error) {
      job.onReadinessError?.(error);
      return false;
    }
  }

  private async run(job: QueuedJob): Promise<void> {
    try {
      await job.run();
    } finally {
      this.active.delete(job.executionId);
      this.preflightExecutionIds.delete(job.executionId);
      this.cancellationRequests.delete(job.executionId);
      this.connectionAdmission?.release(job.executionId);
      const replacement = this.requeueAfterRun.get(job.executionId);
      if (replacement !== undefined) {
        this.requeueAfterRun.delete(job.executionId);
        this.queued.push({ ...replacement, ordinal: this.nextOrdinal, waitingForWorker: false });
        this.nextOrdinal += 1;
      }
      this.schedulePump();
    }
  }

  private scheduleRetry(delayMs: number): void {
    if (this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.schedulePump();
    }, delayMs);
    this.retryTimer.unref?.();
  }
}

function toAdmissionCandidate(job: QueuedJob): ConnectionAdmissionCandidate {
  if (job.connection === undefined) throw new Error('Scheduled job has no Connection admission');
  return {
    executionId: job.executionId,
    teamId: job.teamId,
    ...job.connection,
  };
}

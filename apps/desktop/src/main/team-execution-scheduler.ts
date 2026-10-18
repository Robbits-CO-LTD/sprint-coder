import type { ProviderConnection } from '@sprint-coder/contracts';
import {
  nextRateWindowSlot,
  TEAM_ASSIGNMENT_RATE_LIMIT,
  TEAM_DEFAULT_CONCURRENT_EXECUTIONS,
} from '@sprint-coder/domain';
import { secureLogger } from './secure-logger';
import type {
  ConnectionAdmissionController,
  ConnectionAdmissionCandidate,
  ConnectionWaitReason,
} from './connection-admission';

export const TEAM_GLOBAL_EXECUTION_LIMIT = TEAM_DEFAULT_CONCURRENT_EXECUTIONS;

/** A fixed limit, or a reader asked on every admission pass so a changed setting applies to the
 * next execution without a restart (running executions are never preempted by a lower one). */
export type TeamExecutionLimit = number | (() => number);

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
  onConnectionRejected?(reason: 'tokens_per_minute_capacity'): void;
  onWorkerWaitChanged?(waiting: boolean): void;
  /** Main checks graph dependencies, physical claims and durable resource owners before slots.
   * This read-only observation never replaces the transaction immediately before dispatch. */
  isReady?(): boolean;
  onReadinessError?(error: unknown): void;
  notBeforeMs?: number;
  /** Jobs sharing a key (a Team's fresh assignments) start at most `admissionPace.limit` per
   * window. Counted when the job actually starts, not when it was accepted, so a backlog that
   * waited for slots cannot all start at once (Issue #854). Beyond it the job waits, not fails. */
  paceKey?: string;
  run(): Promise<void>;
}>;

export type TeamAdmissionPace = Readonly<{ limit: number; windowMs: number }>;

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
  /** When the timer above fires (`now()` time), so a shorter wait can replace it. */
  private retryAtMs = 0;
  /** The current per-Team limit, read on every admission pass; null keeps each job's own. */
  private teamLimitReader: ((teamId: string) => number) | null = null;
  /** Start times (`now()`) per pace key within the trailing window. */
  private readonly paceWindows = new Map<string, number[]>();

  constructor(
    private readonly globalLimit: TeamExecutionLimit = TEAM_GLOBAL_EXECUTION_LIMIT,
    private readonly connectionAdmission?: ConnectionAdmissionController,
    private readonly admissionPace: TeamAdmissionPace = TEAM_ASSIGNMENT_RATE_LIMIT,
    /** The clock the pace window and retry timing read (milliseconds since the epoch). */
    private readonly now: () => number = () => Date.now(),
  ) {
    if (typeof globalLimit === 'number' && !isPositiveLimit(globalLimit))
      throw new Error('Team global execution limit must be a positive integer');
  }

  /** The earliest time this job's pace allows it to start (now when it has room or no key). */
  private paceSlot(job: QueuedJob, now: number): number {
    if (job.paceKey === undefined) return now;
    const live = (this.paceWindows.get(job.paceKey) ?? []).filter(
      (at) => at > now - this.admissionPace.windowMs,
    );
    this.paceWindows.set(job.paceKey, live);
    return nextRateWindowSlot(live, now, this.admissionPace.limit, this.admissionPace.windowMs);
  }

  private recordPacedStart(job: QueuedJob): void {
    if (job.paceKey === undefined) return;
    const starts = this.paceWindows.get(job.paceKey) ?? [];
    starts.push(this.now());
    this.paceWindows.set(job.paceKey, starts);
  }

  /** The limit this admission pass uses. A reader that fails or returns nonsense falls back to the
   * default rather than stopping every Team. */
  currentGlobalLimit(): number {
    if (typeof this.globalLimit === 'number') return this.globalLimit;
    try {
      const value = this.globalLimit();
      return isPositiveLimit(value) ? value : TEAM_GLOBAL_EXECUTION_LIMIT;
    } catch {
      return TEAM_GLOBAL_EXECUTION_LIMIT;
    }
  }

  /** A raised limit can admit queued work at once; a lowered one only stops new admissions. */
  notifyLimitChanged(): void {
    this.schedulePump();
  }

  /** Reads each Team's limit (its policy) on every admission pass instead of the value a job was
   * submitted with, so a policy changed while work is queued applies to that work too. */
  readTeamLimitsFrom(reader: (teamId: string) => number): void {
    this.teamLimitReader = reader;
    this.schedulePump();
  }

  private teamLimitOf(job: QueuedJob, cache: Map<string, number>): number {
    const cached = cache.get(job.teamId);
    if (cached !== undefined) return cached;
    let limit = job.teamLimit;
    if (this.teamLimitReader !== null)
      try {
        const value = this.teamLimitReader(job.teamId);
        if (isPositiveLimit(value)) limit = value;
      } catch {
        // A Team that cannot be read keeps the limit it was submitted with.
      }
    cache.set(job.teamId, limit);
    return limit;
  }

  configureConnection(connection: ProviderConnection): void {
    this.connectionAdmission?.configure(connection);
    this.schedulePump();
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
    this.rejectImpossibleJobs();
    const globalLimit = this.currentGlobalLimit();
    while (this.active.size < globalLimit) {
      const index = this.nextAdmissibleIndex();
      if (index === -1) return;
      const [job] = this.queued.splice(index, 1);
      if (job === undefined) return;
      if (job.connection !== undefined) this.connectionAdmission?.admit(toAdmissionCandidate(job));
      this.recordPacedStart(job);
      this.active.set(job.executionId, job);
      this.preflightExecutionIds.add(job.executionId);
      // The job owns durable failure recording. Admission control must still release its slot
      // without turning that already-recorded failure into an unhandled process rejection.
      void this.run(job).catch(() => undefined);
    }
  }

  private rejectImpossibleJobs(): void {
    if (this.connectionAdmission === undefined) return;
    for (const job of [...this.queued]) {
      if (
        job.connection === undefined ||
        this.connectionAdmission.waitReason(toAdmissionCandidate(job)) !==
          'tokens_per_minute_capacity'
      )
        continue;
      const index = this.queued.indexOf(job);
      if (index === -1) continue;
      this.queued.splice(index, 1);
      this.notifyConnectionRejected(job);
    }
    // A pending replacement owns no new admission slot. Reject it without touching the active run.
    for (const [id, job] of this.requeueAfterRun) {
      if (
        job.connection === undefined ||
        this.connectionAdmission.waitReason(
          toAdmissionCandidate({ ...job, ordinal: 0, waitingForWorker: false }),
        ) !== 'tokens_per_minute_capacity'
      )
        continue;
      this.requeueAfterRun.delete(id);
      this.notifyConnectionRejected(job);
    }
    if (this.queued.length === 0 && this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private notifyConnectionRejected(job: TeamExecutionJob): void {
    try {
      job.onConnectionRejected?.('tokens_per_minute_capacity');
    } catch {
      secureLogger.error('Connection admission rejection could not be recorded', undefined, {
        category: 'team',
        event: 'connection_admission_rejection_record_failed',
      });
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
    const teamLimits = new Map<string, number>();
    const teamAdmissible = this.queued
      .map((job, index) => ({ job, index }))
      .filter(
        ({ job }) =>
          !activeWorkers.has(job.workerId) &&
          (activeByTeam.get(job.teamId) ?? 0) < this.teamLimitOf(job, teamLimits) &&
          ready.has(job),
      );
    if (teamAdmissible.length === 0) return -1;
    const now = this.now();
    const startAt = new Map(
      teamAdmissible.map(({ job }) => [
        job,
        Math.max(job.notBeforeMs ?? now, this.paceSlot(job, now)),
      ]),
    );
    const timeAdmissible = teamAdmissible.filter(({ job }) => startAt.get(job)! <= now);
    if (timeAdmissible.length === 0) {
      const earliest = Math.min(...startAt.values());
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
    const atMs = this.now() + delayMs;
    // A pending timer that fires no later already covers this wait. A shorter wait (a 250 ms
    // Connection retry behind a minute of assignment pacing) replaces it instead of waiting it out.
    if (this.retryTimer !== null) {
      if (this.retryAtMs <= atMs) return;
      clearTimeout(this.retryTimer);
    }
    this.retryAtMs = atMs;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.schedulePump();
    }, delayMs);
    this.retryTimer.unref?.();
  }
}

function isPositiveLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function toAdmissionCandidate(job: QueuedJob): ConnectionAdmissionCandidate {
  if (job.connection === undefined) throw new Error('Scheduled job has no Connection admission');
  return {
    executionId: job.executionId,
    teamId: job.teamId,
    ...job.connection,
  };
}

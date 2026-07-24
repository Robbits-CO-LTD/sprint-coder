import {
  teamDetailSchema,
  teamMessageSummarySchema,
  workerCompletionSchema,
  workerSummarySchema,
  type TeamDetail,
  type TeamHireWorkerInput,
  type TeamMessageSummary,
  type TeamSendMessageInput,
  type WorkerCompletion,
  type WorkerSummary,
} from '@sprint-coder/contracts';
import {
  assertEnvelopeMatchesClaims,
  assertSpawnAuthority,
  assertTeamMessageRate,
  assertWorkerCeilingForbidsSpawn,
  buildTeamEnvelope,
  TEAM_DELIVERY_MAX_ATTEMPTS,
  TEAM_MESSAGE_RATE_LIMIT,
  type TeamEnvelope,
} from '@sprint-coder/domain';
import { killProcessTree } from './process-tree';
import type {
  AgentRecord,
  PersistenceClient,
  TeamBudgetReservationRecord,
  TeamSnapshot,
} from './persistence';

export type WorkerRuntimeResult = Readonly<{
  claims?: Readonly<{
    deliveryId?: string;
    sourceAgentId?: string;
    targetAgentId?: string;
  }>;
  completion: unknown;
  usage?: Readonly<{
    costCents?: number;
    tokens?: number;
    timeMs?: number;
    toolCalls?: number;
  }>;
}>;

export interface TeamWorkerRuntime {
  start(worker: AgentRecord): Promise<{ pid?: number | null }>;
  execute(input: {
    worker: AgentRecord;
    envelope: TeamEnvelope;
    content: string;
  }): Promise<WorkerRuntimeResult>;
  stop(agentId: string): Promise<void>;
}

export class DeterministicTeamWorkerRuntime implements TeamWorkerRuntime {
  private readonly pids = new Map<string, number>();

  async start(_worker: AgentRecord): Promise<{ pid: null }> {
    return { pid: null };
  }

  async execute(input: {
    worker: AgentRecord;
    envelope: TeamEnvelope;
    content: string;
  }): Promise<WorkerRuntimeResult> {
    return {
      claims: {
        deliveryId: input.envelope.deliveryId,
        sourceAgentId: input.envelope.sourceAgentId,
        targetAgentId: input.envelope.targetAgentId,
      },
      completion: {
        status: 'succeeded',
        summary: `${input.worker.role}が依頼「${input.content}」を完了しました。`,
        artifacts: [],
        verification: [{ name: 'worker-runtime', outcome: 'pass' }],
        risks: [],
      },
      usage: {
        costCents: 0,
        tokens: Math.max(1, Math.ceil(input.content.length / 4)),
        timeMs: 1,
        toolCalls: 0,
      },
    };
  }

  registerProcess(agentId: string, pid: number): void {
    this.pids.set(agentId, pid);
  }

  async stop(agentId: string): Promise<void> {
    const pid = this.pids.get(agentId);
    if (pid === undefined) return;
    this.pids.delete(agentId);
    await killProcessTree(pid);
  }
}

type Publish = (taskId: string, detail: TeamDetail) => void;

const workerCeiling = Object.freeze({
  entries: Object.freeze([]),
  maxWorkerDepth: 0,
  maxConcurrentWorkers: 0,
});
const MAX_WORKERS = 3;
const executionEstimate = Object.freeze({
  costCents: 100,
  tokens: 20_000,
  timeMs: 60_000,
  toolCalls: 10,
});

export class TeamCoordinator {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly persistence: PersistenceClient,
    private readonly runtime: TeamWorkerRuntime = new DeterministicTeamWorkerRuntime(),
    private readonly publish: Publish = () => undefined,
    private readonly now: () => Date = () => new Date(),
    private readonly deliveryTimeoutMs = 10_000,
  ) {}

  get(taskId: string): TeamDetail | null {
    const team = this.persistence.getTeamByTask(taskId);
    return team === null ? null : this.detail(team.id);
  }

  /** Read-only replay for the team_wait_reports Leader tool: sendToWorker already persists the
   * Worker→Leader report synchronously (see persistWorkerResult below), so this just filters
   * messages targeting the Leader by seq watermark — it never mutates Team/Worker state. */
  listWorkerReports(taskId: string, afterSeq: number): readonly TeamMessageSummary[] {
    const team = this.persistence.getTeamByTask(taskId);
    if (team === null) return [];
    const snapshot = this.persistence.getTeamSnapshot(team.id);
    const leader = snapshot.agents.find(({ kind }) => kind === 'leader');
    if (leader === undefined) return [];
    return snapshot.messages
      .filter((message) => message.targetAgentId === leader.id && message.seq > afterSeq)
      .sort((left, right) => left.seq - right.seq)
      .map((message) => this.messageSummaryFromSnapshot(snapshot, message.id));
  }

  async hireWorker(input: TeamHireWorkerInput): Promise<WorkerSummary> {
    return this.enqueue(input.taskId, async () => {
      assertSpawnAuthority('leader');
      assertWorkerCeilingForbidsSpawn(workerCeiling);
      let team = this.persistence.getTeamByTask(input.taskId);
      if (team === null) team = this.persistence.promoteTaskToTeam(input.taskId);
      const before = this.persistence.getTeamSnapshot(team.id);
      const workers = before.agents.filter(({ kind }) => kind === 'worker');
      if (workers.length >= MAX_WORKERS)
        throw new Error(`Team worker hard cap exceeded: ${MAX_WORKERS}`);
      if (team.state === 'draft') team = this.persistence.transitionTeamState(team.id, 'forming');
      if (!['forming', 'active', 'paused'].includes(team.state))
        throw new Error('Team does not accept new workers');

      const worker = this.persistence.registerTeamWorker({
        teamId: team.id,
        role: input.role,
        objective: input.objective,
        contextInheritancePolicy: input.contextInheritancePolicy,
        parentCapabilityCeiling: workerCeiling,
        writeCapable: input.writeCapable,
      });
      const reservations = this.persistence.reserveTeamBudget({
        teamId: team.id,
        entries: [
          { scope: 'global', kind: 'spawnSlots', amount: 1 },
          { scope: 'team', kind: 'spawnSlots', amount: 1 },
        ],
        purpose: `worker-spawn:${worker.id}`,
        now: this.isoNow(),
      });
      try {
        let current = this.persistence.transitionWorkerState(worker.id, 'spawning');
        await this.runtime.start(current);
        current = this.persistence.transitionWorkerState(worker.id, 'ready');
        this.persistence.setWorkerCurrentActivity(worker.id, null, this.isoNow());
        this.persistence.settleTeamBudget({
          reservationIds: reservations.map(({ id }) => id),
          now: this.isoNow(),
        });
        const latestTeam = this.persistence.getTeam(team.id);
        if (latestTeam.state === 'forming') this.persistence.transitionTeamState(team.id, 'active');
        this.emit(input.taskId, team.id);
        return this.workerSummary(current);
      } catch (error) {
        this.releaseReservations(reservations);
        const current = this.persistence
          .getTeamSnapshot(team.id)
          .agents.find(({ id }) => id === worker.id);
        if (current !== undefined && ['invited', 'spawning'].includes(current.state))
          this.persistence.transitionWorkerState(worker.id, 'failed');
        this.emit(input.taskId, team.id);
        throw error;
      }
    });
  }

  async sendToWorker(input: TeamSendMessageInput): Promise<TeamMessageSummary> {
    return this.enqueue(input.taskId, async () => {
      const team = this.persistence.getTeamByTask(input.taskId);
      if (team === null || team.state !== 'active') throw new Error('Team must be active');
      const snapshot = this.persistence.getTeamSnapshot(team.id);
      const leader = snapshot.agents.find(({ kind }) => kind === 'leader');
      const worker = snapshot.agents.find(
        ({ id, kind }) => id === input.targetAgentId && kind === 'worker',
      );
      if (leader === undefined || worker === undefined) throw new Error('Worker not found');
      if (!['ready', 'waiting'].includes(worker.state)) throw new Error('Worker is not ready');
      const since = new Date(this.now().getTime() - TEAM_MESSAGE_RATE_LIMIT.windowMs).toISOString();
      assertTeamMessageRate({
        recentCount: this.persistence.countRecentTeamMessages(team.id, since),
        ...TEAM_MESSAGE_RATE_LIMIT,
      });

      const message = this.persistence.createTeamMessage({
        teamId: team.id,
        sourceAgentId: leader.id,
        targetAgentId: worker.id,
        content: input.content,
      });
      this.persistence.createTeamDelivery({ messageId: message.id, now: this.isoNow() });
      const reservations = this.persistence.reserveTeamBudget({
        teamId: team.id,
        entries: [
          ...Object.entries(executionEstimate).map(([kind, amount]) => ({
            scope: 'team' as const,
            kind: kind as keyof typeof executionEstimate,
            amount,
          })),
          ...Object.entries(executionEstimate).map(([kind, amount]) => ({
            scope: 'worker' as const,
            kind: kind as keyof typeof executionEstimate,
            amount,
            agentId: worker.id,
          })),
        ],
        purpose: `worker-execution:${message.id}`,
        now: this.isoNow(),
      });
      this.persistence.transitionWorkerState(worker.id, 'busy');
      this.persistence.setWorkerCurrentActivity(worker.id, input.content, this.isoNow());

      try {
        const completion = await this.dispatchWithRetry(
          team.id,
          leader,
          worker,
          message.id,
          message.seq,
          input.content,
        );
        this.persistence.transitionTeamMessageState(message.id, 'delivered');
        this.persistence.transitionTeamDelivery({
          messageId: message.id,
          to: 'acked',
          now: this.isoNow(),
        });
        this.settleExecution(reservations, completion.usage);
        this.persistence.transitionWorkerState(worker.id, 'done');
        this.persistence.setWorkerCurrentActivity(worker.id, null, this.isoNow());
        this.persistWorkerResult(team.id, worker, leader, completion.value);
        this.emit(input.taskId, team.id);
        return this.messageSummary(team.id, message.id);
      } catch (error) {
        this.releaseReservations(reservations);
        const current = this.persistence
          .getTeamSnapshot(team.id)
          .agents.find(({ id }) => id === worker.id);
        if (current?.state === 'busy') this.persistence.transitionWorkerState(worker.id, 'failed');
        this.persistence.setWorkerCurrentActivity(worker.id, null, this.isoNow());
        const delivery = this.persistence.getTeamDelivery(message.id);
        if (delivery !== null && !['failed', 'acked'].includes(delivery.state))
          this.persistence.transitionTeamDelivery({
            messageId: message.id,
            to: 'failed',
            now: this.isoNow(),
            error: error instanceof Error ? error.message : 'worker failure',
          });
        this.emit(input.taskId, team.id);
        throw error;
      }
    });
  }

  async stopWorker(taskId: string, agentId: string): Promise<WorkerSummary> {
    return this.enqueue(taskId, async () => {
      const team = this.persistence.getTeamByTask(taskId);
      if (team === null) throw new Error('Team not found');
      const worker = this.persistence
        .getTeamSnapshot(team.id)
        .agents.find(({ id, kind }) => id === agentId && kind === 'worker');
      if (worker === undefined) throw new Error('Worker not found');
      await this.runtime.stop(worker.id);
      const stopped = ['done', 'failed', 'stopped'].includes(worker.state)
        ? worker
        : this.persistence.transitionWorkerState(worker.id, 'stopped');
      this.persistence.setWorkerCurrentActivity(worker.id, null, this.isoNow());
      this.emit(taskId, team.id);
      return this.workerSummary(stopped);
    });
  }

  async stopAll(taskId: string): Promise<TeamDetail> {
    return this.enqueue(taskId, async () => {
      const team = this.persistence.getTeamByTask(taskId);
      if (team === null) throw new Error('Team not found');
      const workers = this.persistence
        .getTeamSnapshot(team.id)
        .agents.filter(({ kind }) => kind === 'worker');
      await Promise.all(workers.map(({ id }) => this.runtime.stop(id)));
      for (const worker of workers) {
        if (!['done', 'failed', 'stopped'].includes(worker.state))
          this.persistence.transitionWorkerState(worker.id, 'stopped');
        this.persistence.setWorkerCurrentActivity(worker.id, null, this.isoNow());
      }
      const current = this.persistence.getTeam(team.id);
      if (current.state === 'active' || current.state === 'paused') {
        this.persistence.transitionTeamState(team.id, 'winding_down');
        this.persistence.transitionTeamState(team.id, 'completed');
      } else if (current.state === 'forming') {
        this.persistence.transitionTeamState(team.id, 'failed');
      }
      this.emit(taskId, team.id);
      return this.detail(team.id);
    });
  }

  recoverOnStartup(): ReturnType<PersistenceClient['recoverTeamsOnStartup']> {
    return this.persistence.recoverTeamsOnStartup(this.isoNow());
  }

  private async dispatchWithRetry(
    teamId: string,
    leader: AgentRecord,
    worker: AgentRecord,
    messageId: string,
    seq: number,
    content: string,
  ): Promise<{ value: WorkerCompletion; usage: WorkerRuntimeResult['usage'] }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= TEAM_DELIVERY_MAX_ATTEMPTS; attempt += 1) {
      if (attempt === 1) this.persistence.transitionTeamMessageState(messageId, 'dispatching');
      const delivery = this.persistence.transitionTeamDelivery({
        messageId,
        to: 'dispatched',
        now: this.isoNow(),
      });
      const envelope = buildTeamEnvelope({
        teamId,
        messageId,
        sourceAgentId: leader.id,
        targetAgentId: worker.id,
        sourceKind: 'leader',
        targetKind: 'worker',
        seq,
        attempt: delivery.attempt,
        issuedAt: this.isoNow(),
      });
      try {
        const result = await withTimeout(
          this.runtime.execute({ worker, envelope, content }),
          this.deliveryTimeoutMs,
        );
        assertEnvelopeMatchesClaims(envelope, result.claims ?? {});
        return { value: workerCompletionSchema.parse(result.completion), usage: result.usage };
      } catch (error) {
        lastError = error;
        this.persistence.transitionTeamDelivery({
          messageId,
          to: 'timedOut',
          now: this.isoNow(),
          error: error instanceof Error ? error.message : 'worker timeout',
        });
        if (attempt === TEAM_DELIVERY_MAX_ATTEMPTS) break;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Worker delivery failed');
  }

  private persistWorkerResult(
    teamId: string,
    worker: AgentRecord,
    leader: AgentRecord,
    completion: WorkerCompletion,
  ): void {
    const result = this.persistence.createTeamMessage({
      teamId,
      sourceAgentId: worker.id,
      targetAgentId: leader.id,
      content: JSON.stringify(completion),
    });
    this.persistence.createTeamDelivery({ messageId: result.id, now: this.isoNow() });
    this.persistence.transitionTeamMessageState(result.id, 'dispatching');
    this.persistence.transitionTeamDelivery({
      messageId: result.id,
      to: 'dispatched',
      now: this.isoNow(),
    });
    this.persistence.transitionTeamMessageState(result.id, 'delivered');
    this.persistence.transitionTeamDelivery({
      messageId: result.id,
      to: 'acked',
      now: this.isoNow(),
    });
  }

  private settleExecution(
    reservations: readonly TeamBudgetReservationRecord[],
    usage: WorkerRuntimeResult['usage'],
  ): void {
    const actuals: Record<string, number> = {};
    for (const reservation of reservations) {
      const value = usage?.[reservation.kind as keyof NonNullable<WorkerRuntimeResult['usage']>];
      if (typeof value === 'number') actuals[reservation.id] = value;
    }
    this.persistence.settleTeamBudget({
      reservationIds: reservations.map(({ id }) => id),
      actuals,
      now: this.isoNow(),
    });
  }

  private releaseReservations(reservations: readonly TeamBudgetReservationRecord[]): void {
    const reserved = reservations.filter(({ state }) => state === 'reserved').map(({ id }) => id);
    if (reserved.length === 0) return;
    try {
      this.persistence.releaseTeamBudget({ reservationIds: reserved, now: this.isoNow() });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('settled -> released')) throw error;
    }
  }

  private detail(teamId: string): TeamDetail {
    const snapshot = this.persistence.getTeamSnapshot(teamId);
    return teamDetailSchema.parse({
      team: snapshot.team,
      workers: snapshot.agents.map((agent) => this.workerSummary(agent)),
      messages: snapshot.messages.map((message) =>
        this.messageSummaryFromSnapshot(snapshot, message.id),
      ),
      budgets: this.persistence.getTeamBudgetStatus(teamId),
    });
  }

  private workerSummary(agent: AgentRecord): WorkerSummary {
    return workerSummarySchema.parse({
      id: agent.id,
      teamId: agent.teamId,
      threadId: agent.threadId,
      taskId: agent.taskId,
      kind: agent.kind,
      role: agent.role,
      state: agent.state,
      objective: agent.objective,
      writeCapable: agent.writeCapable,
      currentActivity: agent.currentActivity,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      usage:
        agent.kind === 'worker'
          ? this.persistence.getWorkerUsageTotals(agent.id)
          : this.persistence.getTeamUsageTotals(agent.teamId ?? ''),
    });
  }

  private messageSummary(teamId: string, messageId: string): TeamMessageSummary {
    return this.messageSummaryFromSnapshot(this.persistence.getTeamSnapshot(teamId), messageId);
  }

  private messageSummaryFromSnapshot(
    snapshot: TeamSnapshot,
    messageId: string,
  ): TeamMessageSummary {
    const message = snapshot.messages.find(({ id }) => id === messageId);
    if (message === undefined) throw new Error('Team message not found');
    const source = snapshot.agents.find(({ id }) => id === message.sourceAgentId);
    const target = snapshot.agents.find(({ id }) => id === message.targetAgentId);
    const delivery = snapshot.deliveries.find(({ messageId: id }) => id === message.id);
    if (source === undefined || target === undefined)
      throw new Error('Team message identity missing');
    return teamMessageSummarySchema.parse({
      id: message.id,
      teamId: message.teamId,
      sourceAgentId: message.sourceAgentId,
      targetAgentId: message.targetAgentId,
      seq: message.seq,
      state: message.state,
      content: message.content,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      sourceKind: source.kind,
      targetKind: target.kind,
      deliveryState: delivery?.state ?? null,
      attempt: delivery?.attempt ?? 0,
    });
  }

  private emit(taskId: string, teamId: string): void {
    this.publish(taskId, this.detail(teamId));
  }

  private enqueue<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(taskId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.queues.set(taskId, next);
    const cleanup = () => {
      if (this.queues.get(taskId) === next) this.queues.delete(taskId);
    };
    void next.then(cleanup, cleanup);
    return next;
  }

  private isoNow(): string {
    return this.now().toISOString();
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Worker delivery timed out')), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

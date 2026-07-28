import {
  teamDetailSchema,
  teamMessageSummarySchema,
  workerCompletionSchema,
  workerReportSchema,
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
  assertTeamMessageRate,
  buildTeamEnvelope,
  TEAM_DELIVERY_MAX_ATTEMPTS,
  TEAM_MESSAGE_RATE_LIMIT,
  type ManagerPolicy,
  type TeamExecutionState,
  type TeamEnvelope,
} from '@sprint-coder/domain';
import { killProcessTree } from './process-tree';
import { TeamExecutionScheduler } from './team-execution-scheduler';
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

export type TeamExecutionSubmission = Readonly<{
  executionId: string;
  state: TeamExecutionState;
}>;
export type WorkerActivityEvent =
  | { type: 'accepted'; at: string }
  | { type: 'activity'; phase: string; label: string; at: string }
  | { type: 'outputDelta'; text: string }
  | { type: 'reasoningPresence'; active: boolean }
  | { type: 'fileChange'; changes: { path: string; kind: 'add' | 'update' | 'delete' }[] }
  | { type: 'completed' }
  | { type: 'failed'; error: string }
  | { type: 'canceled'; reason: string };

export interface TeamWorkerRuntime {
  start(worker: AgentRecord): Promise<{ pid?: number | null }>;
  execute(input: {
    worker: AgentRecord;
    envelope: TeamEnvelope;
    content: string;
    onEvent?: (event: WorkerActivityEvent) => void;
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
    onEvent?: (event: WorkerActivityEvent) => void;
  }): Promise<WorkerRuntimeResult> {
    input.onEvent?.({ type: 'accepted', at: new Date().toISOString() });
    input.onEvent?.({
      type: 'activity',
      phase: 'executing',
      label: '依頼を処理中',
      at: new Date().toISOString(),
    });
    const result = {
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
    input.onEvent?.({ type: 'completed' });
    return result;
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

const leafWorkerCeiling = Object.freeze({
  entries: Object.freeze([]),
  maxWorkerDepth: 0,
  maxConcurrentWorkers: 0,
});
// Local Claude/Codex workers can spend well over ten seconds reasoning before they finish.
// Keep the delivery boundary finite, but do not turn a healthy streaming run into a retry.
const DEFAULT_WORKER_DELIVERY_TIMEOUT_MS = 120_000;
const executionEstimate = Object.freeze({
  costCents: 100,
  tokens: 20_000,
  timeMs: 60_000,
  toolCalls: 10,
});

export class TeamCoordinator {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly transientWorkerActivity = new Map<
    string,
    { liveOutput: string; reasoningActive: boolean }
  >();

  constructor(
    private readonly persistence: PersistenceClient,
    private readonly runtime: TeamWorkerRuntime = new DeterministicTeamWorkerRuntime(),
    private readonly publish: Publish = () => undefined,
    private readonly now: () => Date = () => new Date(),
    private readonly deliveryTimeoutMs = DEFAULT_WORKER_DELIVERY_TIMEOUT_MS,
    private readonly executionScheduler = new TeamExecutionScheduler(),
  ) {}

  private handleWorkerActivity(
    taskId: string,
    teamId: string,
    workerId: string,
    teamTaskId: string,
    event: WorkerActivityEvent,
  ): void {
    const terminal =
      event.type === 'completed' || event.type === 'failed' || event.type === 'canceled';
    const now = this.isoNow();
    const transient = this.transientWorkerActivity.get(workerId) ?? {
      liveOutput: '',
      reasoningActive: false,
    };
    if (event.type === 'outputDelta')
      transient.liveOutput = `${transient.liveOutput}${event.text}`.slice(-20_000);
    if (event.type === 'reasoningPresence') transient.reasoningActive = event.active;
    if (terminal) this.transientWorkerActivity.delete(workerId);
    else this.transientWorkerActivity.set(workerId, transient);

    if (event.type === 'accepted') {
      this.persistence.transitionTeamTask(teamTaskId, 'running', now);
      this.persistence.setWorkerCurrentActivity(workerId, '依頼を受理', now);
    }
    if (event.type === 'activity')
      this.persistence.setWorkerCurrentActivity(workerId, event.label, now);
    if (event.type === 'fileChange')
      this.persistence.setWorkerCurrentActivity(
        workerId,
        `ファイル変更 ${event.changes.length}件`,
        now,
      );
    if (event.type === 'outputDelta' || event.type === 'reasoningPresence') {
      this.emit(taskId, teamId);
      return;
    }
    this.persistence.recordTeamActivity({
      teamTaskId,
      agentId: workerId,
      type: event.type,
      payload: event,
      now,
    });
    this.emit(taskId, teamId);
  }

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
    return this.hireWorkerWithAuthority(input, null, null);
  }

  async hireWorkerAs(
    input: TeamHireWorkerInput,
    requesterAgentId: string,
    childManagerPolicy: ManagerPolicy | null = null,
  ): Promise<WorkerSummary> {
    return this.hireWorkerWithAuthority(input, requesterAgentId, childManagerPolicy);
  }

  private async hireWorkerWithAuthority(
    input: TeamHireWorkerInput,
    requesterAgentId: string | null,
    childManagerPolicy: ManagerPolicy | null,
  ): Promise<WorkerSummary> {
    return this.enqueue(input.taskId, async () => {
      let team = this.persistence.getTeamByTask(input.taskId);
      if (team === null) team = this.persistence.promoteTaskToTeam(input.taskId);
      const before = this.persistence.getTeamSnapshot(team.id);
      const effectiveRequesterId = requesterAgentId ?? team.leaderAgentId;
      const requester = before.agents.find(({ id }) => id === effectiveRequesterId);
      if (requester === undefined) throw new Error('Hiring Agent not found in Team');
      if (team.state === 'draft') team = this.persistence.transitionTeamState(team.id, 'forming');
      if (!['forming', 'active', 'paused'].includes(team.state))
        throw new Error('Team does not accept new workers');

      const childDepth = requester.depth + 1;
      const childCeiling =
        childManagerPolicy === null
          ? leafWorkerCeiling
          : Object.freeze({
              entries: Object.freeze([]),
              maxWorkerDepth: Math.max(
                0,
                Math.min(team.policy.maxAgentDepth, childManagerPolicy.maxDelegationDepth) -
                  childDepth,
              ),
              maxConcurrentWorkers:
                childManagerPolicy.maxDirectChildren ?? team.policy.maxConcurrentExecutions,
            });
      const worker = this.persistence.registerTeamWorker({
        teamId: team.id,
        role: input.role,
        objective: input.objective,
        contextInheritancePolicy: input.contextInheritancePolicy,
        parentCapabilityCeiling: childCeiling,
        writeCapable: input.writeCapable,
        parentAgentId: requester.id,
        canDelegate: childManagerPolicy !== null,
        managerPolicy: childManagerPolicy,
      });
      let reservations: readonly TeamBudgetReservationRecord[] = [];
      try {
        reservations = this.persistence.reserveTeamBudget({
          teamId: team.id,
          entries: [
            { scope: 'global', kind: 'spawnSlots', amount: 1 },
            { scope: 'team', kind: 'spawnSlots', amount: 1 },
          ],
          purpose: `worker-spawn:${worker.id}`,
          now: this.isoNow(),
        });
        let current = this.persistence.transitionWorkerState(worker.id, 'spawning');
        await this.runtime.start(current);
        current = this.persistence.transitionWorkerState(worker.id, 'ready');
        this.persistence.setWorkerCurrentActivity(worker.id, null, this.isoNow());
        // spawnSlots is a concurrency lease, not cumulative usage. Keeping it committed after
        // startup permanently exhausts the global pool across otherwise completed Teams.
        this.persistence.releaseTeamBudget({
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
    return this.executeLegacyTask({
      ...input,
      doneCriteria: ['Workerが依頼に対する検証可能な報告を返す'],
    });
  }

  async assignTask(
    input: TeamSendMessageInput & { doneCriteria: readonly string[] },
  ): Promise<TeamExecutionSubmission> {
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
      if (
        this.persistence
          .listTeamExecutions(team.id)
          .some(
            (execution) =>
              execution.assigneeAgentId === worker.id &&
              !['completed', 'failed', 'canceled'].includes(execution.state),
          )
      )
        throw new Error('Worker already has a pending execution');
      const since = new Date(this.now().getTime() - TEAM_MESSAGE_RATE_LIMIT.windowMs).toISOString();
      assertTeamMessageRate({
        recentCount: this.persistence.countRecentTeamMessages(team.id, since),
        ...TEAM_MESSAGE_RATE_LIMIT,
      });

      const now = this.isoNow();
      const execution = this.persistence.createTeamExecution({
        teamId: team.id,
        assigneeAgentId: worker.id,
        createdByAgentId: leader.id,
        instruction: input.content,
        now,
      });
      const message = this.persistence.createTeamMessage({
        teamId: team.id,
        sourceAgentId: leader.id,
        targetAgentId: worker.id,
        content: input.content,
        executionId: execution.id,
      });
      const teamTask = this.persistence.createTeamTask({
        teamId: team.id,
        messageId: message.id,
        assigneeAgentId: worker.id,
        createdByAgentId: leader.id,
        description: input.content,
        doneCriteria: input.doneCriteria,
        now,
      });
      this.persistence.createTeamDelivery({ messageId: message.id, now });
      const queued = this.persistence.transitionTeamExecution({
        executionId: execution.id,
        to: 'queued',
        now,
        queueReason: 'global_concurrency',
      });
      this.executionScheduler.submit({
        executionId: execution.id,
        teamId: team.id,
        teamLimit: team.policy.maxConcurrentExecutions,
        run: () =>
          this.runScheduledExecution({
            taskId: input.taskId,
            teamId: team.id,
            leaderId: leader.id,
            workerId: worker.id,
            messageId: message.id,
            messageSeq: message.seq,
            teamTaskId: teamTask.id,
            executionId: execution.id,
            doneCriteria: input.doneCriteria,
          }),
      });
      this.emit(input.taskId, team.id);
      return { executionId: queued.id, state: queued.state };
    });
  }

  async steerExecution(
    taskId: string,
    executionId: string,
    instruction: string,
  ): Promise<TeamExecutionSubmission> {
    return this.enqueue(taskId, async () => {
      const team = this.persistence.getTeamByTask(taskId);
      if (team === null) throw new Error('Team not found');
      const execution = this.persistence.getTeamExecution(executionId);
      if (execution.teamId !== team.id) throw new Error('Execution does not belong to Task Team');
      if (execution.state === 'running')
        throw new Error('Running execution steer requires interrupt-and-resume');
      const leader = this.persistence.getTaskLeader(taskId);
      const revised = this.persistence.reviseQueuedTeamExecution({
        executionId,
        createdByAgentId: leader.id,
        instruction,
        now: this.isoNow(),
      });
      this.emit(taskId, team.id);
      return { executionId: revised.id, state: revised.state };
    });
  }

  async cancelExecution(taskId: string, executionId: string): Promise<TeamExecutionSubmission> {
    return this.enqueue(taskId, async () => {
      const team = this.persistence.getTeamByTask(taskId);
      if (team === null) throw new Error('Team not found');
      const execution = this.persistence.getTeamExecution(executionId);
      if (execution.teamId !== team.id) throw new Error('Execution does not belong to Task Team');
      if (!this.executionScheduler.cancelQueued(execution.id))
        throw new Error('Running execution cancel requires runtime interruption');
      const canceled = this.persistence.cancelQueuedTeamExecution(execution.id, this.isoNow());
      this.emit(taskId, team.id);
      return { executionId: canceled.id, state: canceled.state };
    });
  }

  private async executeLegacyTask(
    input: TeamSendMessageInput & { doneCriteria: readonly string[] },
  ): Promise<TeamMessageSummary> {
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
      const teamTask = this.persistence.createTeamTask({
        teamId: team.id,
        messageId: message.id,
        assigneeAgentId: worker.id,
        createdByAgentId: leader.id,
        description: input.content,
        doneCriteria: input.doneCriteria,
        now: this.isoNow(),
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
          teamTask.id,
        );
        this.persistence.transitionTeamMessageState(message.id, 'delivered');
        this.persistence.transitionTeamDelivery({
          messageId: message.id,
          to: 'acked',
          now: this.isoNow(),
        });
        this.settleExecution(reservations, completion.usage);
        this.persistWorkerResult(team.id, worker, leader, completion.value);
        const report = workerReportSchema.parse({
          status: completion.value.status === 'succeeded' ? 'completed' : 'failed',
          summary: completion.value.summary,
          findings: [],
          changedFiles: completion.value.artifacts.map((artifact) => artifact.reference),
          artifacts: completion.value.artifacts,
          verification: completion.value.verification,
          risks: completion.value.risks,
          nextActions: [],
          doneEvidence: input.doneCriteria.map((criterion) => ({
            criterion,
            evidence: completion.value.summary,
          })),
        });
        this.persistence.completeTeamTaskWithReport({
          teamTaskId: teamTask.id,
          agentId: worker.id,
          report,
          doneEvidence: input.doneCriteria.map((criterion) => ({
            criterion,
            evidence: completion.value.summary,
          })),
          now: this.isoNow(),
        });
        this.persistence.transitionWorkerState(
          worker.id,
          completion.value.status === 'succeeded' ? 'done' : 'failed',
        );
        this.persistence.setWorkerCurrentActivity(worker.id, null, this.isoNow());
        this.finalizeTeamIfWorkersTerminal(team.id);
        this.emit(input.taskId, team.id);
        return this.messageSummary(team.id, message.id);
      } catch (error) {
        this.persistence.transitionTeamTask(teamTask.id, 'failed', this.isoNow());
        this.releaseReservations(reservations);
        const current = this.persistence
          .getTeamSnapshot(team.id)
          .agents.find(({ id }) => id === worker.id);
        if (current?.state === 'busy') this.persistence.transitionWorkerState(worker.id, 'failed');
        this.persistence.setWorkerCurrentActivity(worker.id, null, this.isoNow());
        this.finalizeTeamIfWorkersTerminal(team.id);
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

  private async runScheduledExecution(input: {
    taskId: string;
    teamId: string;
    leaderId: string;
    workerId: string;
    messageId: string;
    messageSeq: number;
    teamTaskId: string;
    executionId: string;
    doneCriteria: readonly string[];
  }): Promise<void> {
    const execution = this.persistence.getTeamExecution(input.executionId);
    const content = execution.instruction.content;
    const snapshot = this.persistence.getTeamSnapshot(input.teamId);
    const leader = snapshot.agents.find(({ id }) => id === input.leaderId);
    const worker = snapshot.agents.find(({ id }) => id === input.workerId);
    if (leader === undefined || worker === undefined) throw new Error('Execution Agent not found');
    let attemptId: string | null = null;
    let reservations: readonly TeamBudgetReservationRecord[] = [];
    try {
      this.persistence.transitionTeamExecution({
        executionId: input.executionId,
        to: 'running',
        now: this.isoNow(),
      });
      let attempt = this.persistence.createTeamAttempt(input.executionId, this.isoNow());
      attempt = this.persistence.transitionTeamAttempt({
        attemptId: attempt.id,
        to: 'running',
        now: this.isoNow(),
      });
      attemptId = attempt.id;
      reservations = this.persistence.reserveTeamBudget({
        teamId: input.teamId,
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
        purpose: `team-execution:${input.executionId}`,
        now: this.isoNow(),
      });
      this.persistence.transitionWorkerState(worker.id, 'busy');
      this.persistence.setWorkerCurrentActivity(worker.id, content, this.isoNow());
      this.emit(input.taskId, input.teamId);

      const completion = await this.dispatchWithRetry(
        input.teamId,
        leader,
        worker,
        input.messageId,
        input.messageSeq,
        content,
        input.teamTaskId,
      );
      this.persistence.transitionTeamMessageState(input.messageId, 'delivered');
      this.persistence.transitionTeamDelivery({
        messageId: input.messageId,
        to: 'acked',
        now: this.isoNow(),
      });
      this.settleExecution(reservations, completion.usage);
      reservations = [];
      this.persistWorkerResult(
        input.teamId,
        worker,
        leader,
        completion.value,
        input.executionId,
        attempt.id,
      );
      const report = workerReportSchema.parse({
        status: completion.value.status === 'succeeded' ? 'completed' : 'failed',
        summary: completion.value.summary,
        findings: [],
        changedFiles: completion.value.artifacts.map((artifact) => artifact.reference),
        artifacts: completion.value.artifacts,
        verification: completion.value.verification,
        risks: completion.value.risks,
        nextActions: [],
        doneEvidence: input.doneCriteria.map((criterion) => ({
          criterion,
          evidence: completion.value.summary,
        })),
      });
      this.persistence.completeTeamTaskWithReport({
        teamTaskId: input.teamTaskId,
        agentId: worker.id,
        report,
        doneEvidence: input.doneCriteria.map((criterion) => ({
          criterion,
          evidence: completion.value.summary,
        })),
        now: this.isoNow(),
      });
      this.persistence.transitionTeamAttempt({
        attemptId: attempt.id,
        to: 'completed',
        now: this.isoNow(),
      });
      this.persistence.transitionTeamExecution({
        executionId: input.executionId,
        to: completion.value.status === 'succeeded' ? 'completed' : 'failed',
        now: this.isoNow(),
      });
      this.persistence.transitionWorkerState(
        worker.id,
        completion.value.status === 'succeeded' ? 'done' : 'failed',
      );
      this.persistence.setWorkerCurrentActivity(worker.id, null, this.isoNow());
      this.finalizeTeamIfWorkersTerminal(input.teamId);
      this.emit(input.taskId, input.teamId);
    } catch (error) {
      this.releaseReservations(reservations);
      this.persistence.transitionTeamTask(input.teamTaskId, 'failed', this.isoNow());
      if (attemptId !== null) {
        const attempt = this.persistence.getTeamAttempt(attemptId);
        if (!['completed', 'failed', 'canceled', 'interrupted'].includes(attempt.state))
          this.persistence.transitionTeamAttempt({
            attemptId,
            to: 'failed',
            now: this.isoNow(),
            terminalReason: 'runtime_failure',
          });
      }
      const execution = this.persistence.getTeamExecution(input.executionId);
      if (!['completed', 'failed', 'canceled'].includes(execution.state))
        this.persistence.transitionTeamExecution({
          executionId: execution.id,
          to: 'failed',
          now: this.isoNow(),
        });
      const current = this.persistence
        .getTeamSnapshot(input.teamId)
        .agents.find(({ id }) => id === worker.id);
      if (current?.state === 'busy') this.persistence.transitionWorkerState(worker.id, 'failed');
      this.persistence.setWorkerCurrentActivity(worker.id, null, this.isoNow());
      const delivery = this.persistence.getTeamDelivery(input.messageId);
      if (delivery !== null && !['failed', 'acked'].includes(delivery.state))
        this.persistence.transitionTeamDelivery({
          messageId: input.messageId,
          to: 'failed',
          now: this.isoNow(),
          error: error instanceof Error ? error.message : 'worker failure',
        });
      this.finalizeTeamIfWorkersTerminal(input.teamId);
      this.emit(input.taskId, input.teamId);
      throw error;
    }
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

  /** True while a durable execution is queued/running or a legacy dispatch is busy. */
  hasBusyWorkers(taskId: string): boolean {
    const team = this.persistence.getTeamByTask(taskId);
    if (team === null) return false;
    if (
      this.persistence
        .listTeamExecutions(team.id)
        .some(({ state }) => !['completed', 'failed', 'canceled'].includes(state))
    )
      return true;
    const snapshot = this.persistence.getTeamSnapshot(team.id);
    return snapshot.agents.some(({ kind, state }) => kind === 'worker' && state === 'busy');
  }

  private async dispatchWithRetry(
    teamId: string,
    leader: AgentRecord,
    worker: AgentRecord,
    messageId: string,
    seq: number,
    content: string,
    teamTaskId: string,
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
        // Enter running before invoking the runtime so adapters that do not emit the optional
        // accepted event still follow the durable task lifecycle. An accepted event is then an
        // idempotent acknowledgement, not the only source of truth for execution start.
        this.persistence.transitionTeamTask(teamTaskId, 'running', this.isoNow());
        const result = await withTimeout(
          this.runtime.execute({
            worker,
            envelope,
            content,
            onEvent: (event) =>
              this.handleWorkerActivity(leader.taskId, teamId, worker.id, teamTaskId, event),
          }),
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
    executionId?: string,
    attemptId?: string,
  ): void {
    const result = this.persistence.createTeamMessage({
      teamId,
      sourceAgentId: worker.id,
      targetAgentId: leader.id,
      content: JSON.stringify(completion),
      ...(executionId === undefined ? {} : { executionId }),
      ...(attemptId === undefined ? {} : { attemptId }),
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

  private finalizeTeamIfWorkersTerminal(teamId: string): void {
    const snapshot = this.persistence.getTeamSnapshot(teamId);
    const workers = snapshot.agents.filter(({ kind }) => kind === 'worker');
    if (
      snapshot.team.state !== 'active' ||
      workers.length === 0 ||
      workers.some(({ state }) => !['done', 'failed', 'stopped'].includes(state))
    )
      return;
    if (workers.some(({ state }) => state === 'failed')) {
      this.persistence.transitionTeamState(teamId, 'failed');
      return;
    }
    this.persistence.transitionTeamState(teamId, 'winding_down');
    this.persistence.transitionTeamState(teamId, 'completed');
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
      engine: agent.runtimeKind,
      parentAgentId: agent.parentAgentId,
      depth: agent.depth,
      canDelegate: agent.canDelegate,
      managerPolicy: agent.managerPolicy,
      liveOutput: this.transientWorkerActivity.get(agent.id)?.liveOutput ?? '',
      reasoningActive: this.transientWorkerActivity.get(agent.id)?.reasoningActive ?? false,
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
      executionId: message.executionId,
      attemptId: message.attemptId,
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

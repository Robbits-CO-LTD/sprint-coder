import {
  teamDetailSchema,
  teamActivitySummarySchema,
  teamMessageSummarySchema,
  workerCompletionSchema,
  workerReportSchema,
  workerSummarySchema,
  type TeamDetail,
  type TeamHireWorkerInput,
  type TeamMessageSummary,
  type TeamActivitySummary,
  type TeamPolicyUpdateInput,
  type TeamSendMessageInput,
  type ExecutionResolution,
  type ModelSelection,
  type NormalizedProviderUsage,
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
import {
  TEAM_GLOBAL_EXECUTION_LIMIT,
  TeamExecutionScheduler,
  type TeamExecutionJob,
} from './team-execution-scheduler';
import { ConnectionAdmissionController, type ConnectionWaitReason } from './connection-admission';
import {
  DEFAULT_RATE_LIMIT_RETRY_COUNT,
  ProviderRateLimitedError,
  rateLimitRetryDelayMs,
} from './provider-rate-limit-retry';
import type {
  AgentRecord,
  PersistenceClient,
  TeamBudgetReservationRecord,
  TeamExecutionRecord,
  TeamSnapshot,
  TeamV2ActivityRecord,
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
  resolution?: ExecutionResolution;
  providerUsage?: NormalizedProviderUsage;
}>;

export type TeamExecutionSubmission = Readonly<{
  executionId: string;
  state: TeamExecutionState;
}>;

type ExecutionInterruptionControl = Readonly<{
  kind: 'steer' | 'cancel';
  instruction: string | null;
  resolve(value: TeamExecutionSubmission): void;
  reject(error: Error): void;
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
  private readonly executionInterruptions = new Map<string, ExecutionInterruptionControl>();
  private readonly transientWorkerActivity = new Map<
    string,
    { liveOutput: string; reasoningActive: boolean }
  >();
  private readonly executionScheduler: TeamExecutionScheduler;

  constructor(
    private readonly persistence: PersistenceClient,
    private readonly runtime: TeamWorkerRuntime = new DeterministicTeamWorkerRuntime(),
    private readonly publish: Publish = () => undefined,
    private readonly now: () => Date = () => new Date(),
    private readonly deliveryTimeoutMs = DEFAULT_WORKER_DELIVERY_TIMEOUT_MS,
    executionScheduler?: TeamExecutionScheduler,
    private readonly validateModelSelection?: (
      selection: ModelSelection,
      taskId: string,
    ) => Promise<void> | void,
  ) {
    if (executionScheduler !== undefined) {
      this.executionScheduler = executionScheduler;
      return;
    }
    const admission = new ConnectionAdmissionController(() => this.now().getTime());
    for (const connection of this.persistence.listProviderConnections())
      admission.configure(connection);
    this.executionScheduler = new TeamExecutionScheduler(TEAM_GLOBAL_EXECUTION_LIMIT, admission);
  }

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

  /** Authority-scoped status for Manager/Worker runtimes. A caller may inspect itself, its
   * ancestor chain, and (for Managers) its own subtree; sibling branches and their messages,
   * instructions, activities, and budgets stay hidden. */
  getForAgent(taskId: string, requesterAgentId: string): TeamDetail | null {
    const team = this.persistence.getTeamByTask(taskId);
    if (team === null) return null;
    const snapshot = this.persistence.getTeamSnapshot(team.id);
    const requester = snapshot.agents.find(({ id }) => id === requesterAgentId);
    if (requester === undefined) throw new Error('Requesting Agent not found in Team');
    const visibleAgentIds = new Set([requester.id]);

    let ancestor = requester;
    while (ancestor.parentAgentId !== null) {
      const parent = snapshot.agents.find(({ id }) => id === ancestor.parentAgentId);
      if (parent === undefined) break;
      visibleAgentIds.add(parent.id);
      ancestor = parent;
    }
    if (requester.canDelegate) {
      const subtreeAgentIds = new Set([requester.id]);
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const agent of snapshot.agents) {
          if (
            agent.parentAgentId !== null &&
            subtreeAgentIds.has(agent.parentAgentId) &&
            !subtreeAgentIds.has(agent.id)
          ) {
            subtreeAgentIds.add(agent.id);
            expanded = true;
          }
        }
      }
      for (const agentId of subtreeAgentIds) visibleAgentIds.add(agentId);
    }

    const detail = this.detail(team.id);
    return teamDetailSchema.parse({
      ...detail,
      workers: detail.workers.filter(({ id }) => visibleAgentIds.has(id)),
      messages: detail.messages.filter(
        ({ sourceAgentId, targetAgentId }) =>
          visibleAgentIds.has(sourceAgentId) && visibleAgentIds.has(targetAgentId),
      ),
      executions: detail.executions.filter(
        ({ assigneeAgentId, createdByAgentId }) =>
          visibleAgentIds.has(assigneeAgentId) && visibleAgentIds.has(createdByAgentId),
      ),
      activities: detail.activities.filter(
        ({ actorAgentId, subjectAgentId }) =>
          (actorAgentId === null || visibleAgentIds.has(actorAgentId)) &&
          (subjectAgentId === null || visibleAgentIds.has(subjectAgentId)),
      ),
      budgets: [],
    });
  }

  async updatePolicy(input: TeamPolicyUpdateInput): Promise<TeamDetail> {
    return this.enqueue(input.taskId, async () => {
      const team = this.persistence.getTeamByTask(input.taskId);
      if (team === null) throw new Error('Team not found for Task');
      this.persistence.updateTeamPolicy(team.id, input.policy, input.expectedRevision);
      const detail = this.detail(team.id);
      this.publish(input.taskId, detail);
      return detail;
    });
  }

  /** Read-only replay for the team_wait_reports Leader tool. Normal Agent chat must never satisfy
   * a report wait: v2 reports are tied to a terminal execution/attempt, while the legacy path is
   * accepted only when its payload validates as a WorkerCompletion. */
  listWorkerReports(
    taskId: string,
    afterSeq: number,
    targetAgentId?: string,
  ): readonly TeamMessageSummary[] {
    const team = this.persistence.getTeamByTask(taskId);
    if (team === null) return [];
    const snapshot = this.persistence.getTeamSnapshot(team.id);
    const target =
      targetAgentId === undefined
        ? snapshot.agents.find(({ kind }) => kind === 'leader')
        : snapshot.agents.find(({ id }) => id === targetAgentId);
    if (target === undefined) return [];
    return snapshot.messages
      .filter(
        (message) =>
          message.targetAgentId === target.id &&
          message.seq > afterSeq &&
          this.isTerminalWorkerReport(message),
      )
      .sort((left, right) => left.seq - right.seq)
      .map((message) => this.messageSummaryFromSnapshot(snapshot, message.id));
  }

  listAgentMessages(
    taskId: string,
    requesterAgentId: string,
    afterSeq: number,
  ): readonly TeamMessageSummary[] {
    const team = this.persistence.getTeamByTask(taskId);
    if (team === null) return [];
    const snapshot = this.persistence.getTeamSnapshot(team.id);
    if (!snapshot.agents.some(({ id }) => id === requesterAgentId))
      throw new Error('Requesting Agent not found in Team');
    return snapshot.messages
      .filter((message) => message.targetAgentId === requesterAgentId && message.seq > afterSeq)
      .sort((left, right) => left.seq - right.seq)
      .map((message) => this.messageSummaryFromSnapshot(snapshot, message.id));
  }

  async sendAgentMessageAs(
    taskId: string,
    requesterAgentId: string,
    targetAgentId: string,
    content: string,
  ): Promise<TeamMessageSummary> {
    return this.enqueue(taskId, async () => {
      const team = this.persistence.getTeamByTask(taskId);
      if (team === null || team.state !== 'active') throw new Error('Team must be active');
      const snapshot = this.persistence.getTeamSnapshot(team.id);
      if (!snapshot.agents.some(({ id }) => id === requesterAgentId))
        throw new Error('Requesting Agent not found in Team');
      if (!snapshot.agents.some(({ id }) => id === targetAgentId))
        throw new Error('Target Agent not found in Team');
      const since = new Date(this.now().getTime() - TEAM_MESSAGE_RATE_LIMIT.windowMs).toISOString();
      assertTeamMessageRate({
        recentCount: this.persistence.countRecentTeamMessages(team.id, since),
        ...TEAM_MESSAGE_RATE_LIMIT,
      });
      const message = this.persistence.createTeamMessage({
        teamId: team.id,
        sourceAgentId: requesterAgentId,
        targetAgentId,
        content,
      });
      const now = this.isoNow();
      this.persistence.createTeamDelivery({ messageId: message.id, now });
      this.persistence.transitionTeamMessageState(message.id, 'dispatching');
      this.persistence.transitionTeamDelivery({
        messageId: message.id,
        to: 'dispatched',
        now,
      });
      this.persistence.transitionTeamMessageState(message.id, 'delivered');
      this.persistence.transitionTeamDelivery({
        messageId: message.id,
        to: 'acked',
        now,
      });
      this.emit(taskId, team.id);
      return this.messageSummaryFromSnapshot(this.persistence.getTeamSnapshot(team.id), message.id);
    });
  }

  async hireWorker(
    input: TeamHireWorkerInput,
    childManagerPolicy: ManagerPolicy | null = null,
  ): Promise<WorkerSummary> {
    return this.hireWorkerWithAuthority(input, null, childManagerPolicy);
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
      if (input.modelSelection !== undefined)
        await this.validateModelSelection?.(input.modelSelection, input.taskId);
      if (team.state === 'draft') team = this.persistence.transitionTeamState(team.id, 'forming');
      if (!['forming', 'active', 'paused'].includes(team.state))
        throw new Error('Team does not accept new workers');

      const childDepth = requester.depth + 1;
      if (childManagerPolicy !== null && childManagerPolicy.maxDelegationDepth <= childDepth)
        throw new Error(
          `Manager maxDelegationDepth is an absolute Team depth and must be greater than the new Manager depth ${childDepth}; use at least ${childDepth + 1}`,
        );
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
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        ...(input.modelSelectionReason === undefined
          ? {}
          : { modelSelectionReason: input.modelSelectionReason }),
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
    return this.assignTaskWithAuthority(input, null);
  }

  async assignTaskAs(
    input: TeamSendMessageInput & { doneCriteria: readonly string[] },
    requesterAgentId: string,
  ): Promise<TeamExecutionSubmission> {
    return this.assignTaskWithAuthority(input, requesterAgentId);
  }

  private async assignTaskWithAuthority(
    input: TeamSendMessageInput & { doneCriteria: readonly string[] },
    requesterAgentId: string | null,
  ): Promise<TeamExecutionSubmission> {
    return this.enqueue(input.taskId, async () => {
      const team = this.persistence.getTeamByTask(input.taskId);
      if (team === null || team.state !== 'active') throw new Error('Team must be active');
      const snapshot = this.persistence.getTeamSnapshot(team.id);
      const requester = snapshot.agents.find(
        ({ id }) => id === (requesterAgentId ?? team.leaderAgentId),
      );
      const worker = snapshot.agents.find(
        ({ id, kind }) => id === input.targetAgentId && kind === 'worker',
      );
      if (requester === undefined || worker === undefined) throw new Error('Worker not found');
      if (requesterAgentId !== null) {
        if (!requester.canDelegate || requester.managerPolicy === null)
          throw new Error('Only a Manager may assign child executions');
        if (worker.parentAgentId !== requester.id)
          throw new Error('Manager may only assign executions to direct child Agents');
      }
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
        createdByAgentId: requester.id,
        instruction: input.content,
        now,
      });
      const message = this.persistence.createTeamMessage({
        teamId: team.id,
        sourceAgentId: requester.id,
        targetAgentId: worker.id,
        content: input.content,
        executionId: execution.id,
      });
      const teamTask = this.persistence.createTeamTask({
        teamId: team.id,
        messageId: message.id,
        assigneeAgentId: worker.id,
        createdByAgentId: requester.id,
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
      this.scheduleExecution({
        taskId: input.taskId,
        teamId: team.id,
        teamLimit: team.policy.maxConcurrentExecutions,
        leaderId: requester.id,
        workerId: worker.id,
        messageId: message.id,
        messageSeq: message.seq,
        teamTaskId: teamTask.id,
        executionId: execution.id,
        doneCriteria: input.doneCriteria,
      });
      this.emit(input.taskId, team.id);
      return { executionId: queued.id, state: queued.state };
    });
  }

  async steerExecution(
    taskId: string,
    executionId: string,
    instruction: string,
    requesterAgentId: string | null = null,
  ): Promise<TeamExecutionSubmission> {
    return this.enqueue(taskId, async () => {
      const team = this.persistence.getTeamByTask(taskId);
      if (team === null) throw new Error('Team not found');
      const execution = this.persistence.getTeamExecution(executionId);
      if (execution.teamId !== team.id) throw new Error('Execution does not belong to Task Team');
      if (requesterAgentId !== null && execution.createdByAgentId !== requesterAgentId)
        throw new Error('Manager may only steer executions it assigned');
      if (execution.state === 'running')
        return this.interruptRunningExecution(execution, 'steer', instruction);
      const revised = this.persistence.reviseQueuedTeamExecution({
        executionId,
        createdByAgentId: execution.createdByAgentId,
        instruction,
        now: this.isoNow(),
      });
      this.emit(taskId, team.id);
      return { executionId: revised.id, state: revised.state };
    });
  }

  async cancelExecution(
    taskId: string,
    executionId: string,
    requesterAgentId: string | null = null,
  ): Promise<TeamExecutionSubmission> {
    return this.enqueue(taskId, async () => {
      const team = this.persistence.getTeamByTask(taskId);
      if (team === null) throw new Error('Team not found');
      const execution = this.persistence.getTeamExecution(executionId);
      if (execution.teamId !== team.id) throw new Error('Execution does not belong to Task Team');
      if (requesterAgentId !== null && execution.createdByAgentId !== requesterAgentId)
        throw new Error('Manager may only cancel executions it assigned');
      if (execution.state === 'running')
        return this.interruptRunningExecution(execution, 'cancel', null);
      if (!this.executionScheduler.cancelQueued(execution.id))
        throw new Error('Execution is not queued or running');
      const canceled = this.persistence.cancelQueuedTeamExecution(execution.id, this.isoNow());
      this.emit(taskId, team.id);
      return { executionId: canceled.id, state: canceled.state };
    });
  }

  private async interruptRunningExecution(
    execution: ReturnType<PersistenceClient['getTeamExecution']>,
    kind: ExecutionInterruptionControl['kind'],
    instruction: string | null,
  ): Promise<TeamExecutionSubmission> {
    if (this.executionInterruptions.has(execution.id))
      throw new Error('Execution interruption is already in progress');
    let resolve!: (value: TeamExecutionSubmission) => void;
    let reject!: (error: Error) => void;
    const settled = new Promise<TeamExecutionSubmission>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    this.executionInterruptions.set(execution.id, { kind, instruction, resolve, reject });
    try {
      await this.runtime.stop(execution.assigneeAgentId);
      return await settled;
    } catch (error) {
      this.executionInterruptions.delete(execution.id);
      throw error;
    }
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
    resumeAttemptId?: string;
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
      let attempt =
        input.resumeAttemptId === undefined
          ? this.persistence.createTeamAttempt(input.executionId, this.isoNow())
          : this.persistence.getTeamAttempt(input.resumeAttemptId);
      if (attempt.executionId !== input.executionId)
        throw new Error('A resumed attempt must belong to the same execution');
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
        input.executionId,
      );
      if (this.executionInterruptions.has(input.executionId)) {
        this.releaseReservations(reservations);
        reservations = [];
        if (
          this.handleRequestedInterruption({
            ...input,
            attemptId: attempt.id,
          })
        )
          return;
      }
      this.persistence.transitionTeamMessageState(input.messageId, 'delivered');
      this.persistence.transitionTeamDelivery({
        messageId: input.messageId,
        to: 'acked',
        now: this.isoNow(),
      });
      this.settleExecution(reservations, completion.usage);
      reservations = [];
      if (completion.resolution !== undefined || completion.providerUsage !== undefined)
        this.persistence.recordTeamAttemptProviderResult(
          attempt.id,
          completion.resolution,
          completion.providerUsage,
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
      this.persistWorkerResult(
        input.teamId,
        worker,
        leader,
        completion.value,
        input.executionId,
        attempt.id,
      );
      this.persistence.transitionWorkerState(
        worker.id,
        completion.value.status === 'succeeded' ? 'done' : 'failed',
      );
      this.persistence.setWorkerCurrentActivity(worker.id, null, this.isoNow());
      this.finalizeTeamIfWorkersTerminal(input.teamId);
      this.emit(input.taskId, input.teamId);
    } catch (error) {
      this.releaseReservations(reservations);
      if (
        attemptId !== null &&
        this.handleRequestedInterruption({
          ...input,
          attemptId,
        })
      )
        return;
      if (
        attemptId !== null &&
        error instanceof ProviderRateLimitedError &&
        this.requeueRateLimitedExecution(input, attemptId, worker, error)
      )
        return;
      const failureSummary = (
        error instanceof Error ? error.message : 'Worker runtime failed'
      ).slice(0, 4_000);
      const failureCompletion = workerCompletionSchema.parse({
        status: 'failed',
        summary: failureSummary,
        artifacts: [],
        verification: [
          { name: 'worker-runtime', outcome: 'fail', detail: failureSummary.slice(0, 2_000) },
        ],
        risks: [failureSummary.slice(0, 500)],
      });
      const failureReport = workerReportSchema.parse({
        status: 'failed',
        summary: failureSummary,
        findings: [],
        changedFiles: [],
        artifacts: [],
        verification: failureCompletion.verification,
        risks: failureCompletion.risks,
        nextActions: [],
        doneEvidence: [],
      });
      if (this.persistence.getTeamTask(input.teamTaskId).status === 'running')
        this.persistence.completeTeamTaskWithReport({
          teamTaskId: input.teamTaskId,
          agentId: worker.id,
          report: failureReport,
          doneEvidence: [],
          now: this.isoNow(),
        });
      if (attemptId !== null) {
        const attempt = this.persistence.getTeamAttempt(attemptId);
        if (!['completed', 'failed', 'canceled', 'interrupted'].includes(attempt.state))
          this.persistence.transitionTeamAttempt({
            attemptId,
            to: 'failed',
            now: this.isoNow(),
            terminalReason:
              error instanceof ProviderRateLimitedError ? 'rate_limited' : 'runtime_failure',
          });
      }
      const execution = this.persistence.getTeamExecution(input.executionId);
      if (!['completed', 'failed', 'canceled'].includes(execution.state))
        this.persistence.transitionTeamExecution({
          executionId: execution.id,
          to: 'failed',
          now: this.isoNow(),
        });
      if (attemptId !== null)
        this.persistWorkerResult(
          input.teamId,
          worker,
          leader,
          failureCompletion,
          input.executionId,
          attemptId,
        );
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

  private requeueRateLimitedExecution(
    input: {
      taskId: string;
      teamId: string;
      leaderId: string;
      workerId: string;
      messageId: string;
      messageSeq: number;
      teamTaskId: string;
      executionId: string;
      doneCriteria: readonly string[];
    },
    attemptId: string,
    worker: AgentRecord,
    error: ProviderRateLimitedError,
  ): boolean {
    const attempt = this.persistence.getTeamAttempt(attemptId);
    if (attempt.providerCallOrdinal >= DEFAULT_RATE_LIMIT_RETRY_COUNT) return false;
    const waitingAttempt = this.persistence.recordTeamAttemptRateLimited(attempt.id, this.isoNow());
    const waitingExecution = this.persistence.getTeamExecution(input.executionId);
    const delayMs = rateLimitRetryDelayMs(attempt.providerCallOrdinal, error.retryAfterMs);
    const requeued = this.executionScheduler.requeueActive(input.executionId, {
      executionId: input.executionId,
      teamId: input.teamId,
      teamLimit: this.persistence.getTeam(input.teamId).policy.maxConcurrentExecutions,
      ...this.connectionSchedulingFields(waitingExecution, input.taskId, input.teamId),
      notBeforeMs: this.now().getTime() + delayMs,
      run: () =>
        this.runScheduledExecution({
          ...input,
          resumeAttemptId: waitingAttempt.id,
        }),
    });
    if (!requeued) throw new Error('Rate-limited execution left the Scheduler before retry');
    const currentWorker = this.persistence
      .getTeamSnapshot(input.teamId)
      .agents.find(({ id }) => id === worker.id);
    if (currentWorker?.state === 'busy')
      this.persistence.transitionWorkerState(worker.id, 'waiting');
    this.persistence.setWorkerCurrentActivity(
      worker.id,
      `Provider rate limit retry ${waitingAttempt.providerCallOrdinal}/${DEFAULT_RATE_LIMIT_RETRY_COUNT}`,
      this.isoNow(),
    );
    this.emit(input.taskId, input.teamId);
    return true;
  }

  private handleRequestedInterruption(input: {
    taskId: string;
    teamId: string;
    leaderId: string;
    workerId: string;
    messageId: string;
    messageSeq: number;
    teamTaskId: string;
    executionId: string;
    doneCriteria: readonly string[];
    attemptId: string;
  }): boolean {
    const control = this.executionInterruptions.get(input.executionId);
    if (control === undefined) return false;
    try {
      this.persistence.transitionTeamAttempt({
        attemptId: input.attemptId,
        to: control.kind === 'steer' ? 'interrupted' : 'canceled',
        now: this.isoNow(),
        terminalReason: control.kind === 'steer' ? 'steered' : 'user_canceled',
      });
      const delivery = this.persistence.getTeamDelivery(input.messageId);
      if (control.kind === 'steer' && delivery?.state === 'dispatched')
        // The original instruction reached the Worker and started an attempt. Steering supersedes
        // that attempt; it is not a delivery failure. Marking it failed made the Canvas announce
        // 「配信に失敗しました」 even while the revised attempt was running successfully.
        this.persistence.transitionTeamDelivery({
          messageId: input.messageId,
          to: 'acked',
          now: this.isoNow(),
        });
      else if (
        delivery !== null &&
        ['persisted', 'dispatched', 'timedOut'].includes(delivery.state)
      )
        this.persistence.transitionTeamDelivery({
          messageId: input.messageId,
          to: 'failed',
          now: this.isoNow(),
          error: control.kind === 'steer' ? 'execution_steered' : 'execution_canceled',
        });
      this.persistence.transitionTeamTask(input.teamTaskId, 'canceled', this.isoNow());
      const worker = this.persistence
        .getTeamSnapshot(input.teamId)
        .agents.find(({ id }) => id === input.workerId);
      if (worker?.state === 'busy') this.persistence.transitionWorkerState(worker.id, 'waiting');
      this.persistence.setWorkerCurrentActivity(input.workerId, null, this.isoNow());

      if (control.kind === 'cancel') {
        const canceled = this.persistence.transitionTeamExecution({
          executionId: input.executionId,
          to: 'canceled',
          now: this.isoNow(),
        });
        this.executionInterruptions.delete(input.executionId);
        control.resolve({ executionId: canceled.id, state: canceled.state });
        this.emit(input.taskId, input.teamId);
        return true;
      }

      const queued = this.persistence.transitionTeamExecution({
        executionId: input.executionId,
        to: 'queued',
        now: this.isoNow(),
        queueReason: 'global_concurrency',
      });
      const revised = this.persistence.reviseQueuedTeamExecution({
        executionId: queued.id,
        createdByAgentId: input.leaderId,
        instruction: control.instruction ?? '',
        now: this.isoNow(),
      });
      const message = this.persistence.createTeamMessage({
        teamId: input.teamId,
        sourceAgentId: input.leaderId,
        targetAgentId: input.workerId,
        content: revised.instruction.content,
        executionId: revised.id,
      });
      const teamTask = this.persistence.createTeamTask({
        teamId: input.teamId,
        messageId: message.id,
        assigneeAgentId: input.workerId,
        createdByAgentId: input.leaderId,
        description: revised.instruction.content,
        doneCriteria: input.doneCriteria,
        now: this.isoNow(),
      });
      this.persistence.createTeamDelivery({ messageId: message.id, now: this.isoNow() });
      const requeued = this.executionScheduler.requeueActive(input.executionId, {
        executionId: input.executionId,
        teamId: input.teamId,
        teamLimit: this.persistence.getTeam(input.teamId).policy.maxConcurrentExecutions,
        ...this.connectionSchedulingFields(revised, input.taskId, input.teamId),
        run: () =>
          this.runScheduledExecution({
            taskId: input.taskId,
            teamId: input.teamId,
            leaderId: input.leaderId,
            workerId: input.workerId,
            messageId: message.id,
            messageSeq: message.seq,
            teamTaskId: teamTask.id,
            executionId: input.executionId,
            doneCriteria: input.doneCriteria,
          }),
      });
      if (!requeued) throw new Error('Running execution left the Scheduler before resume');
      this.executionInterruptions.delete(input.executionId);
      control.resolve({ executionId: revised.id, state: revised.state });
      this.emit(input.taskId, input.teamId);
      return true;
    } catch (error) {
      this.executionInterruptions.delete(input.executionId);
      control.reject(error instanceof Error ? error : new Error(String(error)));
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
      await this.cancelWorkerExecutions(team.id, worker.id);
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
      for (const worker of workers) await this.cancelWorkerExecutions(team.id, worker.id);
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

  private async cancelWorkerExecutions(teamId: string, workerId: string): Promise<void> {
    const pending = this.persistence
      .listTeamExecutions(teamId)
      .filter(
        (execution) =>
          execution.assigneeAgentId === workerId &&
          !['completed', 'failed', 'canceled'].includes(execution.state),
      );
    let stoppedRunningRuntime = false;
    for (const execution of pending) {
      if (execution.state === 'running') {
        await this.interruptRunningExecution(execution, 'cancel', null);
        stoppedRunningRuntime = true;
        continue;
      }
      if (!this.executionScheduler.cancelQueued(execution.id))
        throw new Error('Worker execution is not present in the Scheduler');
      this.persistence.cancelQueuedTeamExecution(execution.id, this.isoNow());
    }
    if (!stoppedRunningRuntime) await this.runtime.stop(workerId);
  }

  recoverOnStartup(): ReturnType<PersistenceClient['recoverTeamsOnStartup']> {
    const recovered = this.persistence.recoverTeamsOnStartup(this.isoNow());
    for (const task of this.persistence.listTasks()) {
      const team = this.persistence.getTeamByTask(task.id);
      if (team === null) continue;
      for (const queued of this.persistence.listQueuedTeamExecutions(team.id)) {
        const execution =
          queued.state === 'queued'
            ? queued
            : this.persistence.transitionTeamExecution({
                executionId: queued.id,
                to: 'queued',
                now: this.isoNow(),
                queueReason: 'recovery',
              });
        const dispatch = this.persistence.getTeamExecutionDispatch(execution.id);
        this.scheduleExecution({
          taskId: task.id,
          teamId: team.id,
          teamLimit: team.policy.maxConcurrentExecutions,
          leaderId: execution.createdByAgentId,
          workerId: execution.assigneeAgentId,
          messageId: dispatch.messageId,
          messageSeq: dispatch.messageSeq,
          teamTaskId: dispatch.teamTaskId,
          executionId: execution.id,
          doneCriteria: dispatch.doneCriteria,
        });
      }
    }
    return recovered;
  }

  private scheduleExecution(input: {
    taskId: string;
    teamId: string;
    teamLimit: number;
    leaderId: string;
    workerId: string;
    messageId: string;
    messageSeq: number;
    teamTaskId: string;
    executionId: string;
    doneCriteria: readonly string[];
  }): void {
    const execution = this.persistence.getTeamExecution(input.executionId);
    this.executionScheduler.submit({
      executionId: input.executionId,
      teamId: input.teamId,
      teamLimit: input.teamLimit,
      ...this.connectionSchedulingFields(execution, input.taskId, input.teamId),
      run: () =>
        this.runScheduledExecution({
          taskId: input.taskId,
          teamId: input.teamId,
          leaderId: input.leaderId,
          workerId: input.workerId,
          messageId: input.messageId,
          messageSeq: input.messageSeq,
          teamTaskId: input.teamTaskId,
          executionId: input.executionId,
          doneCriteria: input.doneCriteria,
        }),
    });
  }

  private connectionSchedulingFields(
    execution: TeamExecutionRecord,
    taskId: string,
    teamId: string,
  ): Pick<TeamExecutionJob, 'connection' | 'onConnectionWait'> | Record<never, never> {
    if (
      execution.modelSelection.connectionId === null ||
      execution.queueOrdinal === null ||
      execution.queuedAt === null
    )
      return {};
    const connection = this.persistence.getProviderConnection(
      execution.modelSelection.connectionId,
    );
    this.executionScheduler.configureConnection(connection);
    return {
      connection: {
        connectionId: connection.id,
        queueOrdinal: execution.queueOrdinal,
        queuedAt: execution.queuedAt,
        estimatedTokens: executionEstimate.tokens,
      },
      onConnectionWait: (reason: ConnectionWaitReason) =>
        this.markExecutionWaitingForConnection(taskId, teamId, execution.id, reason),
    };
  }

  private markExecutionWaitingForConnection(
    taskId: string,
    teamId: string,
    executionId: string,
    reason: ConnectionWaitReason,
  ): void {
    const execution = this.persistence.getTeamExecution(executionId);
    if (execution.state !== 'queued') return;
    this.persistence.transitionTeamExecution({
      executionId,
      to: 'waiting_rate_limit',
      now: this.isoNow(),
      queueReason: reason === 'connection_concurrency' ? 'connection_concurrency' : 'rate_limit',
    });
    this.emit(taskId, teamId);
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

  /** Completion gate for a Team Leader. A hired Worker that was never assigned is unfinished too:
   * the Leader must formally assign it, stop it, or wait for its execution to become terminal. */
  hasUnfinishedTeamWork(taskId: string): boolean {
    const team = this.persistence.getTeamByTask(taskId);
    if (team === null) return false;
    if (
      this.persistence
        .listTeamExecutions(team.id)
        .some(({ state }) => !['completed', 'failed', 'canceled'].includes(state))
    )
      return true;
    return this.persistence
      .getTeamSnapshot(team.id)
      .agents.some(
        ({ kind, state }) => kind === 'worker' && !['done', 'failed', 'stopped'].includes(state),
      );
  }

  private async dispatchWithRetry(
    teamId: string,
    leader: AgentRecord,
    worker: AgentRecord,
    messageId: string,
    seq: number,
    content: string,
    teamTaskId: string,
    executionId?: string,
  ): Promise<{
    value: WorkerCompletion;
    usage: WorkerRuntimeResult['usage'];
    resolution: WorkerRuntimeResult['resolution'];
    providerUsage: WorkerRuntimeResult['providerUsage'];
  }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= TEAM_DELIVERY_MAX_ATTEMPTS; attempt += 1) {
      if (attempt === 1) {
        const message = this.persistence
          .getTeamSnapshot(teamId)
          .messages.find(({ id }) => id === messageId);
        if (message === undefined) throw new Error('Team message not found');
        if (message.state === 'persisted')
          this.persistence.transitionTeamMessageState(messageId, 'dispatching');
        else if (message.state !== 'dispatching')
          throw new Error(`Team message cannot be dispatched from ${message.state}`);
      }
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
        sourceKind: leader.kind,
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
        return {
          value: workerCompletionSchema.parse(result.completion),
          usage: result.usage,
          resolution: result.resolution,
          providerUsage: result.providerUsage,
        };
      } catch (error) {
        lastError = error;
        // A deliberate steer/cancel stops the current Runtime call. That is an execution-control
        // outcome, not a transport timeout; let handleRequestedInterruption settle delivery with
        // the correct steer (acked) or cancel (failed) semantics.
        if (executionId !== undefined && this.executionInterruptions.has(executionId)) break;
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

  private isTerminalWorkerReport(message: TeamSnapshot['messages'][number]): boolean {
    if (message.executionId === null || message.attemptId === null) {
      try {
        return workerCompletionSchema.safeParse(JSON.parse(message.content)).success;
      } catch {
        return false;
      }
    }
    const execution = this.persistence.getTeamExecution(message.executionId);
    const attempt = this.persistence.getTeamAttempt(message.attemptId);
    return (
      execution.assigneeAgentId === message.sourceAgentId &&
      execution.createdByAgentId === message.targetAgentId &&
      attempt.executionId === execution.id &&
      ['completed', 'failed', 'canceled'].includes(execution.state) &&
      ['completed', 'failed', 'canceled', 'interrupted'].includes(attempt.state)
    );
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
      executions: this.persistence.listTeamExecutions(teamId).map((execution) => ({
        id: execution.id,
        teamId: execution.teamId,
        assigneeAgentId: execution.assigneeAgentId,
        createdByAgentId: execution.createdByAgentId,
        state: execution.state,
        instructionPreview:
          execution.instruction.content.length <= 500
            ? execution.instruction.content
            : `${execution.instruction.content.slice(0, 499)}…`,
        instructionRevision: execution.instruction.revision,
        queueOrdinal: execution.queueOrdinal,
        queueReason: execution.queueReason,
        connectionId: execution.modelSelection.connectionId,
        requestedModel: execution.modelSelection.requestedModel,
        assignedAt: execution.assignedAt,
        queuedAt: execution.queuedAt,
        startedAt: execution.startedAt,
        completedAt: execution.completedAt,
        updatedAt: execution.updatedAt,
      })),
      activities: this.persistence
        .listLatestTeamV2Activity(teamId, 200)
        .map((activity) => this.activitySummary(snapshot, activity)),
      budgets: this.persistence.getTeamBudgetStatus(teamId),
    });
  }

  private activitySummary(
    snapshot: TeamSnapshot,
    activity: TeamV2ActivityRecord,
  ): TeamActivitySummary {
    const payload =
      typeof activity.payload === 'object' && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : {};
    const statusCandidate =
      typeof payload['to'] === 'string'
        ? payload['to']
        : typeof payload['state'] === 'string'
          ? payload['state']
          : null;
    const queueReasonCandidate =
      typeof payload['queueReason'] === 'string' ? payload['queueReason'] : null;
    const queueReasons = new Set([
      'global_concurrency',
      'connection_concurrency',
      'verification',
      'rate_limit',
      'budget',
      'recovery',
    ]);
    const actor = snapshot.agents.find(({ id }) => id === activity.actorAgentId);
    const subject = snapshot.agents.find(({ id }) => id === activity.subjectAgentId);
    const selection =
      typeof payload['modelSelection'] === 'object' && payload['modelSelection'] !== null
        ? (payload['modelSelection'] as Record<string, unknown>)
        : {};
    return teamActivitySummarySchema.parse({
      id: activity.id,
      teamId: activity.teamId,
      seq: activity.seq,
      type: activity.type,
      actorAgentId: activity.actorAgentId,
      actorRole: actor?.role ?? null,
      subjectAgentId: activity.subjectAgentId,
      subjectRole: subject?.role ?? null,
      executionId: activity.executionId,
      attemptId: activity.attemptId,
      status: statusCandidate !== null && statusCandidate.length <= 64 ? statusCandidate : null,
      queueReason: queueReasons.has(queueReasonCandidate ?? '') ? queueReasonCandidate : null,
      attemptOrdinal:
        typeof payload['ordinal'] === 'number' &&
        Number.isSafeInteger(payload['ordinal']) &&
        payload['ordinal'] >= 1
          ? payload['ordinal']
          : null,
      terminalReason:
        typeof payload['terminalReason'] === 'string' &&
        payload['terminalReason'].length >= 1 &&
        payload['terminalReason'].length <= 128
          ? payload['terminalReason']
          : null,
      connectionId:
        typeof selection['connectionId'] === 'string' ? selection['connectionId'] : null,
      requestedProvider:
        typeof selection['requestedProvider'] === 'string' ? selection['requestedProvider'] : null,
      requestedModel:
        typeof selection['requestedModel'] === 'string' ? selection['requestedModel'] : null,
      modelSelectionReason:
        typeof payload['modelSelectionReason'] === 'string'
          ? payload['modelSelectionReason']
          : null,
      recordedAt: activity.recordedAt,
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
      connectionId: agent.modelSelection.connectionId,
      requestedProvider: agent.modelSelection.requestedProvider,
      requestedModel: agent.modelSelection.requestedModel,
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

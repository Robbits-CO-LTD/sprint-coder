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
  type TeamAssignMissionInput,
  type TeamMissionCheckpoint,
  type TeamMissionSummary,
  type TeamExecutionIsolation,
  type TeamSendMessageInput,
  type ExecutionResolution,
  type ModelSelection,
  type NormalizedProviderUsage,
  type WorkerCompletion,
  type WorkerSummary,
} from '@sprint-coder/contracts';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { realpath as fsRealpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  assertEnvelopeMatchesClaims,
  assertTeamMessageRate,
  buildTeamEnvelope,
  TEAM_MESSAGE_RATE_LIMIT,
  TeamDelegationError,
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
import { TeamIntegrationScheduler } from './team-integration-scheduler';
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
  TeamBlueprintBindingRecord,
  TeamExecutionRecord,
  TeamAttemptStartReason,
  TeamMissionRecord,
  TeamMissionWorktreeRecord,
  TeamExecutionIsolationRecord,
  TeamSnapshot,
  TeamV2ActivityRecord,
} from './persistence';
import type { WorkerWorktreeManager } from './worker-worktree';
import type { RuntimeWorkspaceSet } from '../runtime-host/protocol';

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
export type TeamExecutionAccess = 'read-only' | 'workspace-write';
export type TeamContextOwner = Readonly<{
  type: 'turn' | 'team_execution';
  id: string;
}>;

export type ManagerHirePolicy = Readonly<{
  maxDirectChildren: number | null;
  maxDelegationLevels: number;
  allowManagerChildren: boolean;
}>;

type ExecutionInterruptionControl = Readonly<{
  kind: 'steer' | 'cancel';
  instruction: string | null;
  resolve(value: TeamExecutionSubmission): void;
  reject(error: Error): void;
}>;
export type WorkerActivityEvent =
  | { type: 'accepted'; at: string }
  | { type: 'heartbeat'; at: string }
  | { type: 'activity'; phase: string; label: string; at: string }
  | { type: 'outputDelta'; text: string }
  | { type: 'reasoningPresence'; active: boolean }
  | { type: 'fileChange'; changes: { path: string; kind: 'add' | 'update' | 'delete' }[] }
  | { type: 'completed' }
  | { type: 'failed'; error: string }
  | { type: 'canceled'; reason: string };

export type TeamRuntimeConversationItem = Readonly<{
  direction: 'received' | 'sent';
  role: string;
  content: string;
}>;

export type WorkerRuntimeControlErrorCode =
  | 'heartbeat_timeout'
  | 'idle_timeout'
  | 'hard_timeout'
  | 'runtime_failure'
  | 'user_canceled'
  | 'stop_unconfirmed';

export class WorkerRuntimeControlError extends Error {
  constructor(
    readonly code: WorkerRuntimeControlErrorCode,
    message: string,
    options?: Readonly<{ cause?: unknown }>,
  ) {
    super(message, options);
    this.name = 'WorkerRuntimeControlError';
  }
}

class TeamIntegrationResumeRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamIntegrationResumeRequiredError';
  }
}

export interface TeamWorkerRuntime {
  start(worker: AgentRecord): Promise<{ pid?: number | null }>;
  execute(input: {
    worker: AgentRecord;
    envelope: TeamEnvelope;
    content: string;
    accessMode?: TeamExecutionAccess;
    executionId?: string;
    workspacePath?: string | null;
    workspaceSet?: RuntimeWorkspaceSet;
    priorConversation?: readonly TeamRuntimeConversationItem[];
    onEvent?: (event: WorkerActivityEvent) => void;
    signal?: AbortSignal;
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
    accessMode?: TeamExecutionAccess;
    executionId?: string;
    workspacePath?: string | null;
    workspaceSet?: RuntimeWorkspaceSet;
    priorConversation?: readonly TeamRuntimeConversationItem[];
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
const DEFAULT_WORKER_DELIVERY_TIMEOUT_MS = 30 * 60_000;
const WORKER_HEARTBEAT_TIMEOUT_MS = 60_000;
const WORKER_IDLE_TIMEOUT_MS = 15 * 60_000;
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
  private readonly integrationScheduler: TeamIntegrationScheduler;

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
    private readonly resolveTeamBlueprint?: (
      taskId: string,
    ) => Omit<TeamBlueprintBindingRecord, 'teamId' | 'boundAt'> | null,
    private readonly worktreeManager?: WorkerWorktreeManager,
    private readonly verifyWorkspace?: (taskId: string) => Promise<void>,
    integrationScheduler?: TeamIntegrationScheduler,
  ) {
    this.integrationScheduler = integrationScheduler ?? new TeamIntegrationScheduler();
    if (executionScheduler !== undefined) {
      this.executionScheduler = executionScheduler;
      return;
    }
    const admission = new ConnectionAdmissionController(() => this.now().getTime());
    for (const connection of this.persistence.listProviderConnections())
      admission.configure(connection);
    this.executionScheduler = new TeamExecutionScheduler(TEAM_GLOBAL_EXECUTION_LIMIT, admission);
  }

  private pinnedBlueprint(taskId: string, teamId: string): TeamBlueprintBindingRecord | null {
    const existing = this.persistence.getTeamBlueprint(teamId);
    const candidate = this.resolveTeamBlueprint?.(taskId) ?? null;
    if (
      existing !== null &&
      candidate !== null &&
      existing.selection.ref.digest !== candidate.selection.ref.digest
    )
      throw new Error(
        'このTaskのTeamには別のBlueprint revisionが固定されています。新規Taskを作成してください',
      );
    if (existing !== null) return existing;
    if (candidate === null) return null;
    return this.persistence.bindTeamBlueprint({ teamId, ...candidate });
  }

  private assertBlueprintHire(
    binding: TeamBlueprintBindingRecord,
    snapshot: TeamSnapshot,
    requester: AgentRecord,
    input: TeamHireWorkerInput,
    childManagerPolicy: ManagerHirePolicy | null,
  ): void {
    const roleKey = input.blueprintRoleKey;
    if (roleKey === undefined) throw new Error('Team Blueprint適用中はblueprintRoleKeyが必要です');
    const role = binding.blueprint.roles.find(({ key }) => key === roleKey);
    if (role === undefined) throw new Error(`Blueprintに定義されていないRoleです: ${roleKey}`);
    if (snapshot.agents.some((agent) => agent.blueprintRoleKey === roleKey))
      throw new Error(`Blueprint Roleはすでに採用済みです: ${roleKey}`);
    const requesterRoleKey = requester.kind === 'leader' ? 'leader' : requester.blueprintRoleKey;
    if (role.parentKey !== requesterRoleKey)
      throw new Error(`Blueprint Role ${roleKey}の親は${role.parentKey}である必要があります`);
    if (input.role.trim() !== role.title.trim())
      throw new Error(`Role名はBlueprint定義の「${role.title}」と一致する必要があります`);
    if (role.modelRequirements !== undefined) {
      if (input.modelSelection === undefined)
        throw new Error(`Blueprint Role ${roleKey}はモデル能力要件を持つためモデル選択が必要です`);
      const preferred = role.modelRequirements.preferredProviders;
      if (
        preferred !== undefined &&
        preferred.length > 0 &&
        (input.modelSelection.requestedProvider === null ||
          !preferred.includes(input.modelSelection.requestedProvider))
      )
        throw new Error(
          `Blueprint Role ${roleKey}はProvider ${preferred.join(', ')}のいずれかを必要とします`,
        );
    }
    if (role.canDelegate !== (childManagerPolicy !== null))
      throw new Error(
        role.canDelegate
          ? 'このBlueprint RoleはManager Policyが必要です'
          : 'このBlueprint Roleは再委譲できません',
      );
  }

  private blueprintReady(binding: TeamBlueprintBindingRecord, snapshot: TeamSnapshot): boolean {
    const hired = new Set(
      snapshot.agents
        .map(({ blueprintRoleKey }) => blueprintRoleKey)
        .filter((value): value is string => value !== null),
    );
    return binding.blueprint.roles.every(({ key, required }) => !required || hired.has(key));
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
    if (event.type === 'heartbeat') return;
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
      if (this.persistence.getTeamBlueprint(team.id) !== null)
        throw new Error('Team Skillの固定Policyが適用中のため個別Policyを変更できません');
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
    childManagerPolicy: ManagerHirePolicy | null = null,
  ): Promise<WorkerSummary> {
    return this.hireWorkerWithAuthority(input, null, childManagerPolicy);
  }

  async hireWorkerAs(
    input: TeamHireWorkerInput,
    requesterAgentId: string,
    childManagerPolicy: ManagerHirePolicy | null = null,
  ): Promise<WorkerSummary> {
    return this.hireWorkerWithAuthority(input, requesterAgentId, childManagerPolicy);
  }

  private async hireWorkerWithAuthority(
    input: TeamHireWorkerInput,
    requesterAgentId: string | null,
    childManagerPolicy: ManagerHirePolicy | null,
  ): Promise<WorkerSummary> {
    return this.enqueue(input.taskId, async () => {
      let team = this.persistence.getTeamByTask(input.taskId);
      if (team === null) team = this.persistence.promoteTaskToTeam(input.taskId);
      const before = this.persistence.getTeamSnapshot(team.id);
      const effectiveRequesterId = requesterAgentId ?? team.leaderAgentId;
      const requester = before.agents.find(({ id }) => id === effectiveRequesterId);
      if (requester === undefined) throw new Error('Hiring Agent not found in Team');
      if (
        requester.canDelegate &&
        requester.managerPolicy !== null &&
        requester.managerPolicy.maxDelegationDepth <= requester.depth
      )
        throw new TeamDelegationError(
          'manager_delegation_limit',
          'This legacy Manager record has no remaining delegation depth; re-hire the Manager with maxDelegationLevels',
          {
            requesterDepth: requester.depth,
            maxDelegationDepth: requester.managerPolicy.maxDelegationDepth,
            requiresRehire: true,
          },
        );
      const blueprint = this.pinnedBlueprint(input.taskId, team.id);
      if (blueprint !== null) {
        this.assertBlueprintHire(blueprint, before, requester, input, childManagerPolicy);
        team = this.persistence.getTeam(team.id);
      }
      if (input.modelSelection !== undefined)
        await this.validateModelSelection?.(input.modelSelection, input.taskId);
      if (team.state === 'draft') team = this.persistence.transitionTeamState(team.id, 'forming');
      if (!['forming', 'active', 'paused'].includes(team.state))
        throw new Error('Team does not accept new workers');

      const childDepth = requester.depth + 1;
      let persistedManagerPolicy: ManagerPolicy | null = null;
      if (childManagerPolicy !== null) {
        if (
          !Number.isSafeInteger(childManagerPolicy.maxDelegationLevels) ||
          childManagerPolicy.maxDelegationLevels < 1
        )
          throw new Error('Manager maxDelegationLevels must be a positive integer');
        if (
          childManagerPolicy.maxDirectChildren !== null &&
          (!Number.isSafeInteger(childManagerPolicy.maxDirectChildren) ||
            childManagerPolicy.maxDirectChildren < 1)
        )
          throw new Error('Manager maxDirectChildren must be null or a positive integer');
        const requestedMaxDepth = childDepth + childManagerPolicy.maxDelegationLevels;
        const requesterMaxDepth =
          requester.managerPolicy?.maxDelegationDepth ?? team.policy.maxAgentDepth;
        if (requestedMaxDepth > team.policy.maxAgentDepth)
          throw new TeamDelegationError(
            'team_depth_limit',
            `Requested Manager delegation reaches depth ${requestedMaxDepth}, beyond Team limit ${team.policy.maxAgentDepth}`,
            {
              requesterDepth: requester.depth,
              requestedManagerDepth: childDepth,
              requestedMaxDepth,
              maxAgentDepth: team.policy.maxAgentDepth,
            },
          );
        if (requestedMaxDepth > requesterMaxDepth)
          throw new TeamDelegationError(
            'manager_delegation_limit',
            `Requested Manager delegation reaches depth ${requestedMaxDepth}, beyond parent Manager limit ${requesterMaxDepth}`,
            {
              requesterDepth: requester.depth,
              requestedManagerDepth: childDepth,
              requestedMaxDepth,
              maxDelegationDepth: requesterMaxDepth,
            },
          );
        persistedManagerPolicy = {
          maxDirectChildren: childManagerPolicy.maxDirectChildren,
          maxDelegationDepth: requestedMaxDepth,
          allowManagerChildren: childManagerPolicy.allowManagerChildren,
        };
      }
      const childCeiling =
        persistedManagerPolicy === null
          ? leafWorkerCeiling
          : Object.freeze({
              entries: Object.freeze([]),
              maxWorkerDepth: persistedManagerPolicy.maxDelegationDepth - childDepth,
              maxConcurrentWorkers:
                persistedManagerPolicy.maxDirectChildren ?? team.policy.maxConcurrentExecutions,
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
        canDelegate: persistedManagerPolicy !== null,
        managerPolicy: persistedManagerPolicy,
        ...(input.blueprintRoleKey === undefined
          ? {}
          : { blueprintRoleKey: input.blueprintRoleKey }),
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
        if (
          latestTeam.state === 'forming' &&
          (blueprint === null ||
            this.blueprintReady(blueprint, this.persistence.getTeamSnapshot(team.id)))
        )
          this.persistence.transitionTeamState(team.id, 'active');
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
    input: TeamSendMessageInput & {
      doneCriteria: readonly string[];
      accessMode?: TeamExecutionAccess;
    },
    contextOwner?: TeamContextOwner,
  ): Promise<TeamExecutionSubmission> {
    return this.assignTaskWithAuthority(input, null, contextOwner);
  }

  async assignTaskAs(
    input: TeamSendMessageInput & {
      doneCriteria: readonly string[];
      accessMode?: TeamExecutionAccess;
    },
    requesterAgentId: string,
    contextOwner?: TeamContextOwner,
  ): Promise<TeamExecutionSubmission> {
    return this.assignTaskWithAuthority(input, requesterAgentId, contextOwner);
  }

  async assignMission(
    input: TeamAssignMissionInput,
    requesterAgentId: string | null = null,
    contextOwner?: TeamContextOwner,
  ): Promise<TeamMissionSummary> {
    return this.enqueue(input.taskId, async () => {
      const team = this.persistence.getTeamByTask(input.taskId);
      if (team === null || team.state !== 'active') throw new Error('Team must be active');
      const snapshot = this.persistence.getTeamSnapshot(team.id);
      const creator = snapshot.agents.find(
        ({ id }) => id === (requesterAgentId ?? team.leaderAgentId),
      );
      if (creator === undefined) throw new Error('Mission creator not found');
      if (requesterAgentId !== null && (!creator.canDelegate || creator.managerPolicy === null))
        throw new Error('Only a Manager may assign a Mission');
      const workerIds = new Set(input.steps.map(({ workerId }) => workerId));
      for (const workerId of workerIds) {
        const worker = snapshot.agents.find(({ id, kind }) => id === workerId && kind === 'worker');
        if (worker === undefined) throw new Error('Mission Worker not found');
        if (requesterAgentId !== null && worker.parentAgentId !== creator.id)
          throw new Error('Manager may only assign Mission steps to direct child Agents');
        if (!['ready', 'waiting'].includes(worker.state))
          throw new Error('Mission Worker is not ready');
        if (
          this.persistence
            .listTeamExecutions(team.id)
            .some(
              (execution) =>
                execution.assigneeAgentId === worker.id &&
                !['completed', 'failed', 'canceled'].includes(execution.state),
            )
        )
          throw new Error('Mission Worker already has a pending execution');
      }
      for (const step of input.steps) {
        const worker = snapshot.agents.find(({ id }) => id === step.workerId);
        if (step.access === 'workspace-write' && worker?.writeCapable !== true)
          throw new Error('workspace-write Mission step requires a write-capable Worker');
      }
      if (input.steps.some(({ access }) => access === 'workspace-write'))
        await this.requireWorkspaceWriteEligibility(input.taskId);
      const mission = this.persistence.createTeamMission({
        teamId: team.id,
        createdByAgentId: creator.id,
        objective: input.objective,
        doneCriteria: input.doneCriteria,
        steps: input.steps,
        now: this.isoNow(),
        ...(contextOwner === undefined ? {} : { contextOwner }),
      });
      this.persistence.transitionTeamMission(mission.id, 'running', this.isoNow());
      const first = mission.steps[0];
      if (first === undefined) throw new Error('Mission has no first step');
      this.persistence.transitionTeamExecution({
        executionId: first.executionId,
        to: 'queued',
        now: this.isoNow(),
        queueReason: 'global_concurrency',
      });
      this.schedulePersistedExecution(input.taskId, first.executionId, 'initial');
      this.emit(input.taskId, team.id);
      return this.missionSummary(this.persistence.getTeamMission(mission.id));
    });
  }

  async resumeMission(
    taskId: string,
    missionId: string,
    requesterAgentId: string | null = null,
    accessCeiling: TeamExecutionAccess = 'read-only',
  ): Promise<TeamMissionSummary> {
    return this.enqueue(taskId, async () => {
      const team = this.persistence.getTeamByTask(taskId);
      if (team === null) throw new Error('Team not found');
      const mission = this.persistence.getTeamMission(missionId);
      if (mission.teamId !== team.id) throw new Error('Mission does not belong to Task Team');
      if (mission.state !== 'waiting_resume') throw new Error('Mission is not waiting to resume');
      if (requesterAgentId !== null && mission.createdByAgentId !== requesterAgentId)
        throw new Error('Manager may only resume a Mission it created');
      if (
        requesterAgentId !== null &&
        accessCeiling === 'read-only' &&
        mission.steps.some(({ access }) => access === 'workspace-write')
      )
        throw new Error('read-only execution cannot resume a workspace-write Mission');
      const step = mission.steps.find(({ ordinal }) => ordinal === mission.currentStepOrdinal);
      if (step === undefined) throw new Error('Current Mission step not found');
      const execution = this.persistence.getTeamExecution(step.executionId);
      if (execution.state !== 'waiting_resume')
        throw new Error('Current Mission execution is not waiting to resume');
      const isolation = this.persistence.getTeamExecutionIsolation(execution.id);
      const completion = this.persistence.getTeamExecutionIsolationCompletion(execution.id);
      if (
        isolation !== null &&
        completion !== null &&
        (isolation.phase === 'completed' ||
          isolation.phase === 'waiting_integration' ||
          (isolation.phase === 'waiting_resume' && isolation.resumeKind === 'integration'))
      ) {
        await this.verifyWorkspace?.(taskId);
        this.persistence.transitionTeamMission(mission.id, 'running', this.isoNow());
        if (this.persistence.getTeamTask(completion.teamTaskId).status === 'blocked')
          this.persistence.transitionTeamTask(completion.teamTaskId, 'running', this.isoNow());
        try {
          const finalized = ['completed', 'waiting_integration'].includes(isolation.phase)
            ? isolation
            : (
                await this.finalizeIsolation({
                  isolation,
                  agentId: completion.agentId,
                  missionId: mission.id,
                  stepOrdinal: step.ordinal,
                })
              ).isolation;
          const resumedReport = workerReportSchema.parse({
            ...completion.report,
            changedFiles: this.isolationChangedFiles(finalized),
          });
          this.persistence.saveTeamExecutionIsolationCompletion({
            ...completion,
            report: resumedReport,
            now: this.isoNow(),
          });
          const integrated =
            finalized.phase === 'completed'
              ? await this.revalidateIntegratedIsolation(finalized)
              : await this.queueIsolationIntegration(finalized);
          const checkpointResult = this.persistence.completeTeamMissionStep({
            executionId: execution.id,
            attemptId: completion.attemptId,
            teamTaskId: completion.teamTaskId,
            agentId: completion.agentId,
            report: resumedReport,
            doneEvidence: completion.doneEvidence,
            checkpoint: this.captureMissionCheckpoint(
              taskId,
              resumedReport.summary,
              this.isolationChangedFiles(integrated),
            ),
            now: this.isoNow(),
          });
          await this.cleanupIntegratedExecutionIsolation(integrated, completion.agentId);
          this.persistence.deleteTeamExecutionIsolationCompletion(execution.id);
          const worker = this.persistence
            .getTeamSnapshot(team.id)
            .agents.find(({ id }) => id === completion.agentId);
          if (worker?.state === 'waiting' && checkpointResult.mission.state === 'completed')
            this.persistence.transitionWorkerState(worker.id, 'done');
          if (checkpointResult.nextExecutionId !== null)
            this.schedulePersistedExecution(taskId, checkpointResult.nextExecutionId, 'initial');
          this.emit(taskId, team.id);
          return this.missionSummary(checkpointResult.mission);
        } catch (error) {
          if (this.persistence.getTeamTask(completion.teamTaskId).status === 'running')
            this.persistence.transitionTeamTask(completion.teamTaskId, 'blocked', this.isoNow());
          if (this.persistence.getTeamMission(mission.id).state === 'running')
            this.persistence.transitionTeamMission(mission.id, 'waiting_resume', this.isoNow());
          this.emit(taskId, team.id);
          throw error;
        }
      }
      this.persistence.prepareTeamMissionResume({
        missionId: mission.id,
        executionId: execution.id,
        now: this.isoNow(),
      });
      this.schedulePersistedExecution(taskId, execution.id, 'manual_resume');
      this.emit(taskId, team.id);
      return this.missionSummary(this.persistence.getTeamMission(mission.id));
    });
  }

  async resumeExecutionIntegration(taskId: string, executionId: string): Promise<TeamDetail> {
    return this.enqueue(taskId, async () => {
      const team = this.persistence.getTeamByTask(taskId);
      if (team === null) throw new Error('Team not found');
      const execution = this.persistence.getTeamExecution(executionId);
      if (execution.teamId !== team.id || execution.state !== 'waiting_resume')
        throw new Error('Team execution is not waiting to resume');
      if (this.persistence.getTeamMissionForExecution(execution.id) !== null)
        throw new Error('Mission integration must be resumed through its Mission');
      const isolation = this.persistence.getTeamExecutionIsolation(execution.id);
      const completion = this.persistence.getTeamExecutionIsolationCompletion(execution.id);
      if (
        isolation === null ||
        completion === null ||
        (isolation.phase !== 'completed' &&
          isolation.phase !== 'waiting_integration' &&
          (isolation.phase !== 'waiting_resume' || isolation.resumeKind !== 'integration'))
      )
        throw new Error('Team execution has no resumable integration');
      await this.verifyWorkspace?.(taskId);
      if (this.persistence.getTeamTask(completion.teamTaskId).status === 'blocked')
        this.persistence.transitionTeamTask(completion.teamTaskId, 'running', this.isoNow());
      try {
        const finalized = ['completed', 'waiting_integration'].includes(isolation.phase)
          ? isolation
          : (
              await this.finalizeIsolation({
                isolation,
                agentId: completion.agentId,
                missionId: '',
                stepOrdinal: 1,
              })
            ).isolation;
        const report = workerReportSchema.parse({
          ...completion.report,
          changedFiles: this.isolationChangedFiles(finalized),
        });
        this.persistence.saveTeamExecutionIsolationCompletion({
          ...completion,
          report,
          now: this.isoNow(),
        });
        const integrated =
          finalized.phase === 'completed'
            ? await this.revalidateIntegratedIsolation(finalized)
            : await this.queueIsolationIntegration(finalized);
        this.persistence.completeTeamTaskWithReport({
          teamTaskId: completion.teamTaskId,
          agentId: completion.agentId,
          report,
          doneEvidence: completion.doneEvidence,
          now: this.isoNow(),
        });
        if (this.persistence.getTeamAttempt(completion.attemptId).state === 'running')
          this.persistence.transitionTeamAttempt({
            attemptId: completion.attemptId,
            to: 'completed',
            now: this.isoNow(),
          });
        this.persistence.transitionTeamExecution({
          executionId: execution.id,
          to: 'completed',
          now: this.isoNow(),
        });
        await this.cleanupIntegratedExecutionIsolation(integrated, completion.agentId);
        this.persistence.deleteTeamExecutionIsolationCompletion(execution.id);
        const worker = this.persistence
          .getTeamSnapshot(team.id)
          .agents.find(({ id }) => id === completion.agentId);
        if (worker?.state === 'waiting') this.persistence.transitionWorkerState(worker.id, 'done');
        this.persistence.setWorkerCurrentActivity(completion.agentId, null, this.isoNow());
        this.finalizeTeamIfWorkersTerminal(team.id);
        this.emit(taskId, team.id);
        return this.detail(team.id);
      } catch (error) {
        if (this.persistence.getTeamTask(completion.teamTaskId).status === 'running')
          this.persistence.transitionTeamTask(completion.teamTaskId, 'blocked', this.isoNow());
        this.emit(taskId, team.id);
        throw error;
      }
    });
  }

  private async assignTaskWithAuthority(
    input: TeamSendMessageInput & {
      doneCriteria: readonly string[];
      accessMode?: TeamExecutionAccess;
    },
    requesterAgentId: string | null,
    contextOwner?: TeamContextOwner,
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
      if ((input.accessMode ?? 'read-only') === 'workspace-write') {
        if (worker.writeCapable !== true)
          throw new Error('workspace-write execution requires a write-capable Worker');
        await this.requireWorkspaceWriteEligibility(input.taskId);
      }
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
        accessMode: input.accessMode ?? 'read-only',
        now,
        ...(contextOwner === undefined ? {} : { contextOwner }),
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
    accessCeiling: TeamExecutionAccess = 'read-only',
  ): Promise<TeamExecutionSubmission> {
    return this.enqueue(taskId, async () => {
      const team = this.persistence.getTeamByTask(taskId);
      if (team === null) throw new Error('Team not found');
      const execution = this.persistence.getTeamExecution(executionId);
      if (execution.teamId !== team.id) throw new Error('Execution does not belong to Task Team');
      if (requesterAgentId !== null && execution.createdByAgentId !== requesterAgentId)
        throw new Error('Manager may only steer executions it assigned');
      if (
        requesterAgentId !== null &&
        accessCeiling === 'read-only' &&
        execution.accessMode === 'workspace-write'
      )
        throw new Error('read-only execution cannot steer a workspace-write execution');
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
      if (execution.state === 'waiting_resume') {
        const canceled = this.persistence.cancelQueuedTeamExecution(execution.id, this.isoNow());
        this.cancelMissionRemainder(execution.id);
        this.emit(taskId, team.id);
        return { executionId: canceled.id, state: canceled.state };
      }
      if (!this.executionScheduler.cancelQueued(execution.id))
        throw new Error('Execution is not queued or running');
      const canceled = this.persistence.cancelQueuedTeamExecution(execution.id, this.isoNow());
      this.cancelMissionRemainder(execution.id);
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
    attemptStartReason?: TeamAttemptStartReason;
  }): Promise<void> {
    // Root/parent-triggered executions already own an inherited immutable seal. Renderer/manual
    // executions have no parent and are sealed here, at the actual dispatch boundary. Retries and
    // resumes hit the same owner id and therefore reuse the existing seal.
    const execution = this.persistence.getTeamExecution(input.executionId);
    const mission = this.persistence.getTeamMissionForExecution(input.executionId);
    const missionStep =
      mission?.steps.find(({ executionId }) => executionId === input.executionId) ?? null;
    const completedMissionContext =
      mission === null
        ? ''
        : mission.steps
            .filter(({ checkpoint }) => checkpoint !== null)
            .map(
              ({ ordinal, checkpoint }) =>
                `工程${ordinal}チェックポイント: ${checkpoint?.summary ?? ''}`,
            )
            .join('\n');
    const content = [
      completedMissionContext,
      input.attemptStartReason === 'manual_resume'
        ? '前回の部分変更を最初に検査し、完了済み操作を重複させずに再開してください。'
        : '',
      execution.instruction.content,
    ]
      .filter((part) => part !== '')
      .join('\n\n');
    const snapshot = this.persistence.getTeamSnapshot(input.teamId);
    const leader = snapshot.agents.find(({ id }) => id === input.leaderId);
    const storedWorker = snapshot.agents.find(({ id }) => id === input.workerId);
    if (leader === undefined || storedWorker === undefined)
      throw new Error('Execution Agent not found');
    if (execution.accessMode === 'workspace-write' && storedWorker.writeCapable !== true)
      throw new Error('workspace-write execution requires a write-capable Worker');
    const worker = { ...storedWorker, writeCapable: execution.accessMode === 'workspace-write' };
    let attemptId: string | null = null;
    let reservations: readonly TeamBudgetReservationRecord[] = [];
    let missionWorktree: TeamMissionWorktreeRecord | null = null;
    let executionIsolation: TeamExecutionIsolationRecord | null = null;
    try {
      this.persistence.sealTeamExecutionContext({
        taskId: input.taskId,
        executionId: input.executionId,
      });
      await this.verifyWorkspace?.(input.taskId);
      if (execution.accessMode === 'workspace-write') {
        const legacyWorktree = this.persistence.getTeamMissionWorktree(input.executionId);
        const workspace = this.persistence.getEffectiveWorkspaceSet(input.taskId);
        if (legacyWorktree !== null || (workspace.source === 'task' && missionStep !== null))
          missionWorktree = await this.prepareMissionWorktree(
            input.taskId,
            input.executionId,
            worker.id,
          );
        else
          executionIsolation = await this.prepareExecutionIsolation(
            input.taskId,
            input.executionId,
            worker.id,
          );
      }
      this.persistence.transitionTeamExecution({
        executionId: input.executionId,
        to: 'running',
        now: this.isoNow(),
      });
      let attempt =
        input.resumeAttemptId === undefined
          ? this.persistence.createTeamAttempt(
              input.executionId,
              this.isoNow(),
              input.attemptStartReason ?? 'initial',
            )
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
        attempt.id,
        missionWorktree?.path ??
          executionIsolation?.roots.find(({ role }) => role === 'primary')?.isolatedPath,
        execution.accessMode,
        executionIsolation !== null
          ? this.runtimeWorkspaceForIsolation(executionIsolation)
          : missionWorktree === null
            ? this.runtimeWorkspaceForTask(input.taskId)
            : undefined,
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
      let changedFiles = [...completion.changedFiles];
      const failedWorkspaceWrite =
        (missionWorktree !== null || executionIsolation !== null) &&
        completion.value.status !== 'succeeded';
      // Legacy single-worktree failures can be rerun in a fresh Attempt. A Project isolation seals
      // every repository as quarantined, so presenting that state as resumable would strand the
      // execution: preparation cannot safely reactivate those worktrees and there is no successful
      // completion to resume integration from.
      const resumableFailedWorkspaceWrite = failedWorkspaceWrite && missionWorktree !== null;
      if (missionWorktree !== null) {
        if (this.worktreeManager === undefined)
          throw new Error('Mission worktree manager is unavailable');
        const finalized = await this.worktreeManager.finalizeChanges({
          agentId: worker.id,
          worktreeId: input.executionId,
          repoPath: missionWorktree.repoPath,
          baseHead: missionWorktree.baseHead,
          commitMessage: `Sprint Coder Mission ${mission?.id ?? ''} step ${missionStep?.ordinal ?? ''}`,
        });
        changedFiles = [...finalized.changedFiles];
        missionWorktree = this.persistence.updateTeamMissionWorktree({
          executionId: input.executionId,
          to: 'ready',
          workerHead: finalized.workerHead,
          changedFiles,
          reason: null,
          now: this.isoNow(),
        });
        if (failedWorkspaceWrite)
          missionWorktree = this.persistence.updateTeamMissionWorktree({
            executionId: input.executionId,
            to: 'quarantined',
            reason: `Worker reported failure before integration: ${completion.value.summary}`.slice(
              0,
              2_000,
            ),
            now: this.isoNow(),
          });
        else {
          const integrated = await this.worktreeManager.integrate({
            repoPath: missionWorktree.repoPath,
            baseHead: missionWorktree.baseHead,
            workerHead: finalized.workerHead,
          });
          missionWorktree = this.persistence.updateTeamMissionWorktree({
            executionId: input.executionId,
            to: 'integrated',
            integratedHead: integrated.integratedHead,
            reason: null,
            now: this.isoNow(),
          });
        }
      }
      if (executionIsolation !== null) {
        if (failedWorkspaceWrite)
          this.quarantineExecutionIsolation(
            executionIsolation.executionId,
            `Worker reported failure before integration: ${completion.value.summary}`,
          );
        else {
          this.persistence.saveTeamExecutionIsolationCompletion({
            executionId: input.executionId,
            attemptId: attempt.id,
            teamTaskId: input.teamTaskId,
            agentId: worker.id,
            report: workerReportSchema.parse({
              status: 'completed',
              summary: completion.value.summary,
              findings: [],
              changedFiles,
              artifacts: completion.value.artifacts,
              verification: completion.value.verification,
              risks: completion.value.risks,
              nextActions: [],
              doneEvidence: input.doneCriteria.map((criterion) => ({
                criterion,
                evidence: completion.value.summary,
              })),
            }),
            doneEvidence: input.doneCriteria.map((criterion) => ({
              criterion,
              evidence: completion.value.summary,
            })),
            now: this.isoNow(),
          });
          const finalized = await this.finalizeIsolation({
            isolation: executionIsolation,
            agentId: worker.id,
            missionId: mission?.id ?? '',
            stepOrdinal: missionStep?.ordinal ?? 1,
          });
          executionIsolation = finalized.isolation;
          changedFiles = [...finalized.changedFiles];
        }
      }
      const report = workerReportSchema.parse({
        status: completion.value.status === 'succeeded' ? 'completed' : 'failed',
        summary: completion.value.summary,
        findings: [],
        changedFiles,
        artifacts: completion.value.artifacts,
        verification: completion.value.verification,
        risks: completion.value.risks,
        nextActions: [],
        doneEvidence: input.doneCriteria.map((criterion) => ({
          criterion,
          evidence: completion.value.summary,
        })),
      });
      const doneEvidence = input.doneCriteria.map((criterion) => ({
        criterion,
        evidence: completion.value.summary,
      }));
      if (
        executionIsolation !== null &&
        completion.value.status === 'succeeded' &&
        executionIsolation.phase === 'waiting_integration'
      ) {
        this.persistence.saveTeamExecutionIsolationCompletion({
          executionId: input.executionId,
          attemptId: attempt.id,
          teamTaskId: input.teamTaskId,
          agentId: worker.id,
          report,
          doneEvidence,
          now: this.isoNow(),
        });
        executionIsolation = await this.queueIsolationIntegration(executionIsolation);
      }
      let nextMissionExecutionId: string | null = null;
      let completedMission = false;
      if (mission !== null && completion.value.status === 'succeeded') {
        const checkpointResult = this.persistence.completeTeamMissionStep({
          executionId: input.executionId,
          attemptId: attempt.id,
          teamTaskId: input.teamTaskId,
          agentId: worker.id,
          report,
          doneEvidence,
          checkpoint: this.captureMissionCheckpoint(
            input.taskId,
            completion.value.summary,
            changedFiles,
          ),
          now: this.isoNow(),
        });
        nextMissionExecutionId = checkpointResult.nextExecutionId;
        completedMission = checkpointResult.mission.state === 'completed';
        if (missionWorktree !== null)
          await this.cleanupIntegratedMissionWorktree(missionWorktree, worker.id);
        if (executionIsolation !== null)
          await this.cleanupIntegratedExecutionIsolation(executionIsolation, worker.id);
      } else {
        this.persistence.completeTeamTaskWithReport({
          teamTaskId: input.teamTaskId,
          agentId: worker.id,
          report,
          doneEvidence,
          now: this.isoNow(),
        });
        this.persistence.transitionTeamAttempt({
          attemptId: attempt.id,
          to: failedWorkspaceWrite ? 'failed' : 'completed',
          now: this.isoNow(),
          terminalReason: failedWorkspaceWrite ? 'worker_reported_failure' : null,
        });
        this.persistence.transitionTeamExecution({
          executionId: input.executionId,
          to: resumableFailedWorkspaceWrite
            ? 'waiting_resume'
            : completion.value.status === 'succeeded'
              ? 'completed'
              : 'failed',
          now: this.isoNow(),
        });
        if (mission !== null && mission.state === 'running') {
          if (resumableFailedWorkspaceWrite)
            this.persistence.transitionTeamMission(mission.id, 'waiting_resume', this.isoNow());
          else this.cancelMissionRemainder(input.executionId, 'failed');
        }
        if (
          mission === null &&
          executionIsolation !== null &&
          completion.value.status === 'succeeded'
        )
          await this.cleanupIntegratedExecutionIsolation(executionIsolation, worker.id);
      }
      if (executionIsolation?.phase === 'completed')
        this.persistence.deleteTeamExecutionIsolationCompletion(input.executionId);
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
        completion.value.status === 'succeeded'
          ? mission !== null && !completedMission
            ? 'waiting'
            : 'done'
          : resumableFailedWorkspaceWrite
            ? 'waiting'
            : 'failed',
      );
      if (completedMission && mission !== null) {
        const missionWorkerIds = new Set(
          mission.steps.map(
            ({ executionId }) => this.persistence.getTeamExecution(executionId).assigneeAgentId,
          ),
        );
        for (const candidate of this.persistence.getTeamSnapshot(input.teamId).agents) {
          if (missionWorkerIds.has(candidate.id) && ['ready', 'waiting'].includes(candidate.state))
            this.persistence.transitionWorkerState(candidate.id, 'done');
        }
      }
      if (nextMissionExecutionId !== null)
        this.schedulePersistedExecution(input.taskId, nextMissionExecutionId, 'initial');
      this.persistence.setWorkerCurrentActivity(worker.id, null, this.isoNow());
      this.finalizeTeamIfWorkersTerminal(input.teamId);
      this.emit(input.taskId, input.teamId);
    } catch (error) {
      const integrationResume = error instanceof TeamIntegrationResumeRequiredError;
      this.releaseReservations(reservations);
      if (missionWorktree !== null)
        this.quarantineMissionWorktree(missionWorktree.executionId, error);
      const persistedIsolation =
        executionIsolation ?? this.persistence.getTeamExecutionIsolation(input.executionId);
      if (persistedIsolation !== null && !integrationResume)
        this.quarantineExecutionIsolation(persistedIsolation.executionId, error);
      if (
        attemptId !== null &&
        this.handleRequestedInterruption({
          ...input,
          attemptId,
        })
      )
        return;
      if (
        !integrationResume &&
        attemptId !== null &&
        error instanceof ProviderRateLimitedError &&
        this.requeueRateLimitedExecution(input, attemptId, worker, error)
      )
        return;
      if (
        !integrationResume &&
        attemptId !== null &&
        this.requeueSafeRuntimeFailure(input, attemptId, worker, error)
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
      const preflightFailure = attemptId === null;
      if (['assigned', 'running'].includes(this.persistence.getTeamTask(input.teamTaskId).status)) {
        if (preflightFailure || (mission === null && !integrationResume))
          this.persistence.completeTeamTaskWithReport({
            teamTaskId: input.teamTaskId,
            agentId: worker.id,
            report: failureReport,
            doneEvidence: [],
            now: this.isoNow(),
          });
        else if (integrationResume)
          this.persistence.transitionTeamTask(input.teamTaskId, 'blocked', this.isoNow());
        else this.persistence.transitionTeamTask(input.teamTaskId, 'blocked', this.isoNow());
      }
      const terminalReason =
        error instanceof WorkerRuntimeControlError
          ? error.code
          : error instanceof ProviderRateLimitedError
            ? 'rate_limited'
            : 'runtime_failure';
      if (attemptId !== null) {
        const attempt = this.persistence.getTeamAttempt(attemptId);
        if (!['completed', 'failed', 'canceled', 'interrupted'].includes(attempt.state))
          this.persistence.transitionTeamAttempt({
            attemptId,
            to: integrationResume ? 'completed' : 'failed',
            now: this.isoNow(),
            terminalReason: integrationResume ? null : terminalReason,
          });
      }
      const execution = this.persistence.getTeamExecution(input.executionId);
      if (
        !preflightFailure &&
        (mission !== null || integrationResume) &&
        !['completed', 'failed', 'canceled'].includes(execution.state)
      ) {
        this.persistence.transitionTeamExecution({
          executionId: execution.id,
          to: 'waiting_resume',
          now: this.isoNow(),
        });
        if (mission?.state === 'running')
          this.persistence.transitionTeamMission(mission.id, 'waiting_resume', this.isoNow());
      } else if (!['completed', 'failed', 'canceled'].includes(execution.state))
        this.persistence.transitionTeamExecution({
          executionId: execution.id,
          to: 'failed',
          now: this.isoNow(),
        });
      if (preflightFailure && mission !== null) this.cancelMissionRemainder(execution.id, 'failed');
      if (attemptId !== null && !integrationResume)
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
      if (current?.state === 'busy')
        this.persistence.transitionWorkerState(
          worker.id,
          mission === null && !integrationResume ? 'failed' : 'waiting',
        );
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

  private requeueSafeRuntimeFailure(
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
    error: unknown,
  ): boolean {
    if (
      worker.writeCapable ||
      error instanceof ProviderRateLimitedError ||
      (error instanceof WorkerRuntimeControlError && error.code === 'stop_unconfirmed') ||
      this.persistence.listTeamAttempts(input.executionId).length >= 2
    )
      return false;
    const reason = error instanceof WorkerRuntimeControlError ? error.code : 'runtime_failure';
    this.persistence.transitionTeamAttempt({
      attemptId,
      to: 'failed',
      now: this.isoNow(),
      terminalReason: reason,
    });
    const queued = this.persistence.transitionTeamExecution({
      executionId: input.executionId,
      to: 'queued',
      now: this.isoNow(),
      queueReason: 'automatic_retry',
    });
    const task = this.persistence.getTeamTask(input.teamTaskId);
    if (task.status === 'running')
      this.persistence.transitionTeamTask(input.teamTaskId, 'waiting', this.isoNow());
    const currentWorker = this.persistence
      .getTeamSnapshot(input.teamId)
      .agents.find(({ id }) => id === worker.id);
    if (currentWorker?.state === 'busy')
      this.persistence.transitionWorkerState(worker.id, 'waiting');
    this.persistence.setWorkerCurrentActivity(
      worker.id,
      '安全な読み取り工程を自動再試行',
      this.isoNow(),
    );
    const requeued = this.executionScheduler.requeueActive(input.executionId, {
      executionId: input.executionId,
      teamId: input.teamId,
      teamLimit: this.persistence.getTeam(input.teamId).policy.maxConcurrentExecutions,
      ...this.connectionSchedulingFields(queued, input.taskId, input.teamId),
      run: () =>
        this.runScheduledExecution({
          ...input,
          attemptStartReason: 'automatic_retry',
        }),
    });
    if (!requeued) throw new Error('Runtime retry left the Scheduler before requeue');
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
        this.cancelMissionRemainder(input.executionId);
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
            attemptStartReason: 'steer',
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

  private cancelMissionRemainder(
    currentExecutionId: string,
    terminalState: 'canceled' | 'failed' = 'canceled',
  ): void {
    const mission = this.persistence.getTeamMissionForExecution(currentExecutionId);
    if (mission === null || ['completed', 'failed', 'canceled'].includes(mission.state)) return;
    for (const step of mission.steps) {
      if (step.executionId === currentExecutionId) continue;
      const execution = this.persistence.getTeamExecution(step.executionId);
      if (['completed', 'failed', 'canceled'].includes(execution.state)) continue;
      this.executionScheduler.cancelQueued(execution.id);
      this.persistence.cancelQueuedTeamExecution(execution.id, this.isoNow());
    }
    this.persistence.transitionTeamMission(mission.id, terminalState, this.isoNow());
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
    for (const pendingExecution of pending) {
      const execution = this.persistence.getTeamExecution(pendingExecution.id);
      if (['completed', 'failed', 'canceled'].includes(execution.state)) continue;
      if (execution.state === 'running') {
        await this.interruptRunningExecution(execution, 'cancel', null);
        stoppedRunningRuntime = true;
        continue;
      }
      if (
        !['assigned', 'waiting_resume'].includes(execution.state) &&
        !this.executionScheduler.cancelQueued(execution.id)
      )
        throw new Error('Worker execution is not present in the Scheduler');
      this.persistence.cancelQueuedTeamExecution(execution.id, this.isoNow());
      this.cancelMissionRemainder(execution.id);
    }
    if (!stoppedRunningRuntime) await this.runtime.stop(workerId);
  }

  recoverOnStartup(): ReturnType<PersistenceClient['recoverTeamsOnStartup']> {
    const recovered = this.persistence.recoverTeamsOnStartup(this.isoNow());
    for (const task of this.persistence.listTasks()) {
      const team = this.persistence.getTeamByTask(task.id);
      if (team === null) continue;
      for (const queued of this.persistence.listQueuedTeamExecutions(team.id)) {
        const mission = this.persistence.getTeamMissionForExecution(queued.id);
        const missionStep = mission?.steps.find(({ executionId }) => executionId === queued.id);
        const previousCheckpoint =
          missionStep === undefined
            ? null
            : (mission?.steps.find(({ ordinal }) => ordinal === missionStep.ordinal - 1)
                ?.checkpoint ?? null);
        if (
          mission !== null &&
          previousCheckpoint !== null &&
          previousCheckpoint.gitHead !== null &&
          !this.workspaceFingerprintMatches(task.id, previousCheckpoint)
        ) {
          this.persistence.transitionTeamExecution({
            executionId: queued.id,
            to: 'waiting_resume',
            now: this.isoNow(),
          });
          if (mission.state === 'running')
            this.persistence.transitionTeamMission(mission.id, 'waiting_resume', this.isoNow());
          this.persistence.setWorkerCurrentActivity(
            queued.assigneeAgentId,
            'チェックポイント後にWorkspaceが変更されたため再開待ち',
            this.isoNow(),
          );
          this.emit(task.id, team.id);
          continue;
        }
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
          attemptStartReason: 'app_restart',
        });
      }
      for (const execution of this.persistence
        .listTeamExecutions(team.id)
        .filter(({ state }) => state === 'waiting_resume')) {
        const isolation = this.persistence.getTeamExecutionIsolation(execution.id);
        const completion = this.persistence.getTeamExecutionIsolationCompletion(execution.id);
        if (
          isolation === null ||
          completion === null ||
          (isolation.phase !== 'waiting_integration' &&
            (isolation.phase !== 'waiting_resume' || isolation.resumeKind !== 'integration'))
        )
          continue;
        const mission = this.persistence.getTeamMissionForExecution(execution.id);
        const resume =
          mission === null
            ? this.resumeExecutionIntegration(task.id, execution.id)
            : this.resumeMission(task.id, mission.id);
        void resume.catch(() => undefined);
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
    attemptStartReason?: TeamAttemptStartReason;
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
          ...(input.attemptStartReason === undefined
            ? {}
            : { attemptStartReason: input.attemptStartReason }),
        }),
    });
  }

  private schedulePersistedExecution(
    taskId: string,
    executionId: string,
    attemptStartReason: TeamAttemptStartReason,
  ): void {
    const execution = this.persistence.getTeamExecution(executionId);
    const team = this.persistence.getTeam(execution.teamId);
    const dispatch = this.persistence.getTeamExecutionDispatch(execution.id);
    this.scheduleExecution({
      taskId,
      teamId: team.id,
      teamLimit: team.policy.maxConcurrentExecutions,
      leaderId: execution.createdByAgentId,
      workerId: execution.assigneeAgentId,
      messageId: dispatch.messageId,
      messageSeq: dispatch.messageSeq,
      teamTaskId: dispatch.teamTaskId,
      executionId: execution.id,
      doneCriteria: dispatch.doneCriteria,
      attemptStartReason,
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
    attemptId?: string,
    workspacePath?: string,
    accessMode: TeamExecutionAccess = 'read-only',
    workspaceSet?: RuntimeWorkspaceSet,
  ): Promise<{
    value: WorkerCompletion;
    usage: WorkerRuntimeResult['usage'];
    resolution: WorkerRuntimeResult['resolution'];
    providerUsage: WorkerRuntimeResult['providerUsage'];
    changedFiles: readonly string[];
  }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 1; attempt += 1) {
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
      const priorConversation = priorConversationForAgent(
        this.persistence.getTeamSnapshot(teamId),
        worker.id,
        seq,
      );
      try {
        const changedFiles = new Set<string>();
        // Enter running before invoking the runtime so adapters that do not emit the optional
        // accepted event still follow the durable task lifecycle. An accepted event is then an
        // idempotent acknowledgement, not the only source of truth for execution start.
        this.persistence.transitionTeamTask(teamTaskId, 'running', this.isoNow());
        let lastProgressWriteMs = 0;
        const result = await executeWithWatchdog({
          execute: (observe, signal) =>
            this.runtime.execute({
              worker,
              envelope,
              content,
              accessMode,
              ...(executionId === undefined ? {} : { executionId }),
              ...(workspacePath === undefined ? {} : { workspacePath }),
              ...(workspaceSet === undefined ? {} : { workspaceSet }),
              priorConversation,
              signal,
              onEvent: (event) => {
                observe(event);
                if (event.type === 'fileChange')
                  for (const change of event.changes) changedFiles.add(change.path);
                if (event.type !== 'heartbeat' && attemptId !== undefined) {
                  const nowMs = this.now().getTime();
                  if (
                    lastProgressWriteMs === 0 ||
                    nowMs - lastProgressWriteMs >= 5_000 ||
                    event.type === 'completed'
                  ) {
                    this.persistence.touchTeamAttemptProgress(attemptId, this.isoNow());
                    lastProgressWriteMs = nowMs;
                  }
                }
                this.handleWorkerActivity(leader.taskId, teamId, worker.id, teamTaskId, event);
              },
            }),
          hardTimeoutMs: this.deliveryTimeoutMs,
          stop: () => this.runtime.stop(worker.id),
        });
        assertEnvelopeMatchesClaims(envelope, result.claims ?? {});
        return {
          value: workerCompletionSchema.parse(result.completion),
          usage: result.usage,
          resolution: result.resolution,
          providerUsage: result.providerUsage,
          changedFiles: [...changedFiles],
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
        if (
          worker.writeCapable ||
          (error instanceof WorkerRuntimeControlError && error.code === 'stop_unconfirmed')
        )
          break;
        break;
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
        ...(() => {
          const latestAttempt = this.persistence.listTeamAttempts(execution.id).at(-1) ?? null;
          const mission = this.persistence.getTeamMissionForExecution(execution.id);
          const missionStep =
            mission?.steps.find(({ executionId }) => executionId === execution.id) ?? null;
          return {
            attemptStartReason: latestAttempt?.startReason ?? null,
            lastProgressAt: latestAttempt?.lastProgressAt ?? null,
            terminalReason: latestAttempt?.terminalReason ?? null,
            missionId: mission?.id ?? null,
            missionStepOrdinal: missionStep?.ordinal ?? null,
            missionStepCount: mission?.steps.length ?? null,
            worktree: this.missionWorktreeSummary(execution.id),
            isolation: this.executionIsolationSummary(execution.id),
          };
        })(),
        id: execution.id,
        teamId: execution.teamId,
        assigneeAgentId: execution.assigneeAgentId,
        createdByAgentId: execution.createdByAgentId,
        accessMode: execution.accessMode,
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
      missions: this.persistence
        .listTeamMissions(teamId)
        .map((mission) => this.missionSummary(mission)),
      activities: this.persistence
        .listLatestTeamV2Activity(teamId, 200)
        .map((activity) => this.activitySummary(snapshot, activity)),
      budgets: this.persistence.getTeamBudgetStatus(teamId),
    });
  }

  private missionSummary(mission: TeamMissionRecord): TeamMissionSummary {
    return {
      id: mission.id,
      teamId: mission.teamId,
      createdByAgentId: mission.createdByAgentId,
      state: mission.state,
      objective: mission.objective,
      doneCriteria: [...mission.doneCriteria],
      currentStepOrdinal: mission.currentStepOrdinal,
      steps: mission.steps.map((step) => {
        const execution = this.persistence.getTeamExecution(step.executionId);
        const dispatch = this.persistence.getTeamExecutionDispatch(step.executionId);
        return {
          ordinal: step.ordinal,
          executionId: step.executionId,
          workerId: execution.assigneeAgentId,
          objective: execution.instruction.content,
          doneCriteria: [...dispatch.doneCriteria],
          access: step.access,
          state: execution.state,
          checkpoint: step.checkpoint,
          worktree: this.missionWorktreeSummary(step.executionId),
        };
      }),
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt,
      completedAt: mission.completedAt,
    };
  }

  private async prepareMissionWorktree(
    taskId: string,
    executionId: string,
    agentId: string,
  ): Promise<TeamMissionWorktreeRecord> {
    if (this.worktreeManager === undefined)
      throw new Error('workspace-write Mission requires Worker worktree support');
    const repoPath = this.persistence.getWorkspace(taskId);
    if (repoPath === null) throw new Error('workspace-write Mission requires a Git workspace');
    const existing = this.persistence.getTeamMissionWorktree(executionId);
    if (existing !== null) {
      if (existing.agentId !== agentId || existing.repoPath !== repoPath)
        throw new Error('Persisted Mission worktree identity does not match execution');
      if (existing.state === 'cleaned')
        throw new Error('A cleaned Mission worktree cannot be executed again');
      return existing.state === 'active'
        ? existing
        : this.persistence.updateTeamMissionWorktree({
            executionId,
            to: 'active',
            reason: null,
            now: this.isoNow(),
          });
    }
    const { head } = await this.worktreeManager.requireCleanBase(repoPath);
    const created = await this.worktreeManager.create({
      agentId,
      worktreeId: executionId,
      repoPath,
      baseRef: head,
    });
    let recorded: TeamMissionWorktreeRecord;
    try {
      recorded = this.persistence.recordTeamMissionWorktree({
        executionId,
        agentId,
        repoPath,
        path: created.path,
        baseHead: created.baseHead,
        now: this.isoNow(),
      });
    } catch (error) {
      await this.worktreeManager.cleanup({ agentId, worktreeId: executionId, repoPath });
      throw error;
    }
    return this.persistence.updateTeamMissionWorktree({
      executionId: recorded.executionId,
      to: 'active',
      now: this.isoNow(),
    });
  }

  private async prepareExecutionIsolation(
    taskId: string,
    executionId: string,
    agentId: string,
  ): Promise<TeamExecutionIsolationRecord> {
    if (this.worktreeManager === undefined)
      throw new Error('workspace-write Mission requires Worker worktree support');
    const existing = this.persistence.getTeamExecutionIsolation(executionId);
    if (existing !== null) {
      if (existing.phase !== 'preparing' && existing.phase !== 'running')
        throw new Error(`Team execution isolation cannot run from ${existing.phase}`);
      if (existing.phase === 'running') return existing;
      for (const repository of existing.repositories)
        await this.worktreeManager.ensureCreated({
          agentId,
          worktreeId: isolationWorktreeId(executionId, repository.ordinal),
          repoPath: repository.repoPath,
          baseRef: repository.baseHead,
        });
      return this.persistence.updateTeamExecutionIsolation({
        executionId,
        phase: 'running',
        resumeKind: null,
        reason: null,
        now: this.isoNow(),
      });
    }
    const workspace = this.persistence.getEffectiveWorkspaceSet(taskId);
    const repositories = await this.requireWorkspaceWriteEligibility(taskId);
    const bindings = this.persistence.getEffectiveWorkspaceMutationBindings(taskId);
    const repositoryRecords: TeamExecutionIsolation['repositories'] = repositories.map(
      (repository, index) => {
        const ordinal = index + 1;
        return {
          ordinal,
          repoPath: repository.repoPath,
          worktreePath: this.worktreeManager!.worktreePathFor(
            isolationWorktreeId(executionId, ordinal),
          ),
          baseHead: repository.head,
          workerHead: null,
          integratedHead: null,
          state: 'active',
          changedFiles: [],
        };
      },
    );
    const canonicalRootPaths = new Map(
      await Promise.all(
        workspace.roots.map(async (root) => [root.rootId, await fsRealpath(root.path)] as const),
      ),
    );
    const rootRecords: TeamExecutionIsolation['roots'] = workspace.roots.map((root) => {
      const canonicalRootPath = canonicalRootPaths.get(root.rootId);
      if (canonicalRootPath === undefined)
        throw new Error(`Workspace root canonical path is unavailable: ${root.label}`);
      const repositoryIndex = repositories.findIndex((candidate) =>
        isPathInsideOrSame(candidate.repoPath, canonicalRootPath),
      );
      const repository = repositories[repositoryIndex];
      const repositoryRecord = repositoryRecords[repositoryIndex];
      if (repository === undefined || repositoryRecord === undefined)
        throw new Error(`Workspace root is not mapped to a repository: ${root.label}`);
      const binding = bindings.get(root.rootId);
      if (binding === undefined)
        throw new Error(`Workspace root mutation binding is unavailable: ${root.label}`);
      const repositoryRelative = relative(repository.repoPath, canonicalRootPath);
      if (isEscapingRelativePath(repositoryRelative))
        throw new Error(`Workspace root escapes its repository: ${root.label}`);
      return {
        rootId: root.rootId,
        rootLabel: root.label,
        role: root.role,
        repositoryOrdinal: repositoryRecord.ordinal,
        sourcePath: canonicalRootPath,
        isolatedPath: resolve(repositoryRecord.worktreePath, repositoryRelative),
        identity: binding.rootIdentityDigest,
        mutationKey: binding.workspaceKey,
      };
    });
    const recorded = this.persistence.createTeamExecutionIsolation({
      executionId,
      repositories: repositoryRecords,
      roots: rootRecords,
      now: this.isoNow(),
    });
    for (const repository of recorded.repositories)
      await this.worktreeManager.ensureCreated({
        agentId,
        worktreeId: isolationWorktreeId(executionId, repository.ordinal),
        repoPath: repository.repoPath,
        baseRef: repository.baseHead,
      });
    return this.persistence.updateTeamExecutionIsolation({
      executionId: recorded.executionId,
      phase: 'running',
      resumeKind: null,
      reason: null,
      now: this.isoNow(),
    });
  }

  private runtimeWorkspaceForIsolation(
    isolation: TeamExecutionIsolationRecord,
  ): RuntimeWorkspaceSet {
    const primary = isolation.roots.find(({ role }) => role === 'primary');
    if (primary === undefined) throw new Error('Team execution isolation has no Primary root');
    return {
      primaryRootId: primary.rootId,
      roots: isolation.roots.map((root) => ({
        rootId: root.rootId,
        path: root.isolatedPath,
        label: root.rootLabel,
        role: root.role,
      })),
      digest: createHash('sha256')
        .update(
          JSON.stringify(
            isolation.roots.map(({ rootId, isolatedPath, identity, role }) => ({
              rootId,
              isolatedPath,
              identity,
              role,
            })),
          ),
        )
        .digest('hex'),
    };
  }

  private runtimeWorkspaceForTask(taskId: string): RuntimeWorkspaceSet {
    const workspace = this.persistence.getEffectiveWorkspaceSet(taskId);
    const unhealthy = workspace.roots.find(({ status }) => status !== 'available');
    if (unhealthy !== undefined)
      throw new Error(`Team workspace root is not available: ${unhealthy.label}`);
    return {
      primaryRootId: workspace.primaryRootId,
      roots: workspace.roots.map((root) => ({
        rootId: root.rootId,
        path: root.path,
        label: root.label,
        role: root.role,
      })),
      digest: workspace.digest,
    };
  }

  private async requireWorkspaceWriteEligibility(taskId: string) {
    if (this.worktreeManager === undefined)
      throw new Error('workspace-write execution requires Worker worktree support');
    await this.verifyWorkspace?.(taskId);
    const workspace = this.persistence.getEffectiveWorkspaceSet(taskId);
    if (workspace.roots.length === 0)
      throw new Error('workspace-write execution requires a Git workspace');
    const unhealthy = workspace.roots.find(({ status }) => status !== 'available');
    if (unhealthy !== undefined)
      throw new Error(`workspace-write root is not available: ${unhealthy.label}`);
    return this.worktreeManager.requireCleanRepositorySet(workspace.roots.map(({ path }) => path));
  }

  private async finalizeIsolation(input: {
    isolation: TeamExecutionIsolationRecord;
    agentId: string;
    missionId: string;
    stepOrdinal: number;
  }): Promise<{ isolation: TeamExecutionIsolationRecord; changedFiles: readonly string[] }> {
    if (this.worktreeManager === undefined)
      throw new Error('Mission worktree manager is unavailable');
    let isolation = input.isolation;
    try {
      isolation = this.persistence.updateTeamExecutionIsolation({
        executionId: isolation.executionId,
        phase: 'finalizing',
        resumeKind: null,
        reason: null,
        now: this.isoNow(),
      });
      for (const repository of isolation.repositories.filter(({ state }) => state === 'active')) {
        const finalized = await this.worktreeManager.finalizeChanges({
          agentId: input.agentId,
          worktreeId: isolationWorktreeId(isolation.executionId, repository.ordinal),
          repoPath: repository.repoPath,
          baseHead: repository.baseHead,
          commitMessage: `Sprint Coder Mission ${input.missionId} step ${input.stepOrdinal} repository ${repository.ordinal}`,
        });
        isolation = this.persistence.updateTeamExecutionIsolation({
          executionId: isolation.executionId,
          phase: 'finalizing',
          repositories: replaceIsolationRepository(isolation.repositories, repository.ordinal, {
            ...repository,
            workerHead: finalized.workerHead,
            state: 'ready',
            changedFiles: [...finalized.changedFiles],
          }),
          now: this.isoNow(),
        });
      }
      isolation = this.persistence.updateTeamExecutionIsolation({
        executionId: isolation.executionId,
        phase: 'waiting_integration',
        resumeKind: null,
        reason: null,
        now: this.isoNow(),
      });
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
      isolation = this.persistence.updateTeamExecutionIsolation({
        executionId: isolation.executionId,
        phase: 'waiting_resume',
        resumeKind: 'integration',
        reason: reason === '' ? 'Repository finalization requires resume' : reason,
        now: this.isoNow(),
      });
      throw new TeamIntegrationResumeRequiredError(isolation.reason ?? 'Finalization failed');
    }
    return {
      isolation,
      changedFiles: this.isolationChangedFiles(isolation),
    };
  }

  private async integrateIsolation(
    initial: TeamExecutionIsolationRecord,
  ): Promise<TeamExecutionIsolationRecord> {
    if (this.worktreeManager === undefined)
      throw new Error('Mission worktree manager is unavailable');
    let isolation = initial;
    try {
      this.persistence.acquireTeamIntegrationRootLeases({
        executionId: isolation.executionId,
        roots: isolationLeaseBindings(isolation),
        now: this.isoNow(),
      });
      isolation = this.persistence.updateTeamExecutionIsolation({
        executionId: isolation.executionId,
        phase: 'integrating',
        resumeKind: null,
        reason: null,
        now: this.isoNow(),
      });
      const primaryRepositoryOrdinal = isolation.roots.find(
        ({ role }) => role === 'primary',
      )?.repositoryOrdinal;
      const integrationOrder = [...isolation.repositories].sort((left, right) => {
        if (left.ordinal === primaryRepositoryOrdinal) return 1;
        if (right.ordinal === primaryRepositoryOrdinal) return -1;
        return left.ordinal - right.ordinal;
      });
      for (const repository of integrationOrder.filter(({ state }) =>
        ['ready', 'integrated'].includes(state),
      )) {
        if (repository.workerHead === null)
          throw new Error('All repositories must be finalized before integration');
        if (repository.state === 'integrated' && repository.integratedHead === null)
          throw new Error('Integrated repository is missing its sealed HEAD');
        const sealedIntegratedHead = repository.integratedHead;
        const integrated =
          repository.state === 'integrated'
            ? await this.worktreeManager.revalidateIntegration({
                repoPath: repository.repoPath,
                baseHead: repository.baseHead,
                workerHead: repository.workerHead,
                integratedHead: sealedIntegratedHead as string,
              })
            : await this.worktreeManager.integrate({
                repoPath: repository.repoPath,
                baseHead: repository.baseHead,
                workerHead: repository.workerHead,
              });
        isolation = this.persistence.updateTeamExecutionIsolation({
          executionId: isolation.executionId,
          phase: 'integrating',
          repositories: replaceIsolationRepository(isolation.repositories, repository.ordinal, {
            ...repository,
            integratedHead:
              repository.state === 'integrated'
                ? repository.integratedHead
                : integrated.integratedHead,
            state: 'integrated',
          }),
          now: this.isoNow(),
        });
      }
      isolation = this.persistence.updateTeamExecutionIsolation({
        executionId: isolation.executionId,
        phase: 'completed',
        resumeKind: null,
        reason: null,
        now: this.isoNow(),
      });
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
      isolation = this.persistence.updateTeamExecutionIsolation({
        executionId: isolation.executionId,
        phase: 'waiting_resume',
        resumeKind: 'integration',
        reason: reason === '' ? 'Repository integration requires resume' : reason,
        now: this.isoNow(),
      });
      throw new TeamIntegrationResumeRequiredError(isolation.reason ?? 'Integration failed');
    } finally {
      this.persistence.releaseTeamIntegrationRootLeases(isolation.executionId);
    }
    return isolation;
  }

  private async queueIsolationIntegration(
    isolation: TeamExecutionIsolationRecord,
  ): Promise<TeamExecutionIsolationRecord> {
    let integrated: TeamExecutionIsolationRecord | null = null;
    await this.integrationScheduler.submit({
      executionId: isolation.executionId,
      mutationKeys: isolationLeaseBindings(isolation).map(({ mutationKey }) => mutationKey),
      run: async () => {
        const current = this.persistence.getTeamExecutionIsolation(isolation.executionId);
        if (current === null) throw new Error('Queued Team isolation no longer exists');
        integrated = await this.integrateIsolation(current);
      },
    });
    if (integrated === null) throw new Error('Integration scheduler completed without a result');
    return integrated;
  }

  private async revalidateIntegratedIsolation(
    initial: TeamExecutionIsolationRecord,
  ): Promise<TeamExecutionIsolationRecord> {
    if (this.worktreeManager === undefined)
      throw new Error('Mission worktree manager is unavailable');
    try {
      for (const repository of initial.repositories) {
        if (repository.workerHead === null || repository.integratedHead === null)
          throw new Error('Completed isolation repository is missing its sealed Git heads');
        const verified = await this.worktreeManager.revalidateIntegration({
          repoPath: repository.repoPath,
          baseHead: repository.baseHead,
          workerHead: repository.workerHead,
          integratedHead: repository.integratedHead,
        });
        if (verified.integratedHead !== repository.integratedHead)
          throw new Error(`Integrated repository HEAD changed: ${repository.repoPath}`);
      }
      return initial;
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
      const waiting = this.persistence.updateTeamExecutionIsolation({
        executionId: initial.executionId,
        phase: 'waiting_resume',
        resumeKind: 'integration',
        reason: reason === '' ? 'Integrated repository requires revalidation' : reason,
        now: this.isoNow(),
      });
      throw new TeamIntegrationResumeRequiredError(
        waiting.reason ?? 'Integrated repository changed before resume',
      );
    }
  }

  private isolationChangedFiles(isolation: TeamExecutionIsolationRecord): readonly string[] {
    return isolation.repositories.flatMap(({ ordinal, repoPath, changedFiles }) => {
      const roots = isolation.roots.filter(
        ({ repositoryOrdinal }) => repositoryOrdinal === ordinal,
      );
      return changedFiles.map((path) => {
        const root = roots.find((candidate) => {
          const prefix = relative(repoPath, candidate.sourcePath).split(sep).join('/');
          return prefix === '' || path === prefix || path.startsWith(`${prefix}/`);
        });
        if (root === undefined) return `repository-${ordinal} › ${path}`;
        const prefix = relative(repoPath, root.sourcePath).split(sep).join('/');
        const rootedPath = prefix === '' ? path : path.slice(prefix.length + 1);
        return `${root.rootLabel} › ${rootedPath}`;
      });
    });
  }

  private async cleanupIntegratedExecutionIsolation(
    isolation: TeamExecutionIsolationRecord,
    agentId: string,
  ): Promise<void> {
    if (this.worktreeManager === undefined) return;
    let current = isolation;
    for (const repository of current.repositories) {
      try {
        const result = await this.worktreeManager.cleanup({
          agentId,
          worktreeId: isolationWorktreeId(current.executionId, repository.ordinal),
          repoPath: repository.repoPath,
        });
        current = this.persistence.updateTeamExecutionIsolation({
          executionId: current.executionId,
          phase: current.phase,
          repositories: replaceIsolationRepository(current.repositories, repository.ordinal, {
            ...repository,
            state: result.outcome === 'removed' ? 'cleaned' : 'quarantined',
          }),
          reason:
            result.outcome === 'removed'
              ? current.reason
              : 'Integrated repository worktree remained dirty during cleanup',
          now: this.isoNow(),
        });
      } catch (error) {
        this.quarantineExecutionIsolation(current.executionId, error);
        return;
      }
    }
  }

  private quarantineExecutionIsolation(executionId: string, error: unknown): void {
    const current = this.persistence.getTeamExecutionIsolation(executionId);
    if (current === null || current.phase === 'quarantined') return;
    this.persistence.releaseTeamIntegrationRootLeases(executionId);
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    this.persistence.updateTeamExecutionIsolation({
      executionId,
      phase: 'quarantined',
      repositories: current.repositories.map((repository) => ({
        ...repository,
        state: repository.state === 'cleaned' ? 'cleaned' : 'quarantined',
      })),
      resumeKind: null,
      reason: reason === '' ? 'Team execution isolation requires inspection' : reason,
      now: this.isoNow(),
    });
  }

  private async cleanupIntegratedMissionWorktree(
    worktree: TeamMissionWorktreeRecord,
    agentId: string,
  ): Promise<void> {
    if (this.worktreeManager === undefined) return;
    try {
      const result = await this.worktreeManager.cleanup({
        agentId,
        worktreeId: worktree.executionId,
        repoPath: worktree.repoPath,
      });
      this.persistence.updateTeamMissionWorktree({
        executionId: worktree.executionId,
        to: result.outcome === 'removed' ? 'cleaned' : 'quarantined',
        reason:
          result.outcome === 'removed' ? null : 'Integrated worktree remained dirty during cleanup',
        now: this.isoNow(),
      });
    } catch (error) {
      this.quarantineMissionWorktree(worktree.executionId, error);
    }
  }

  private quarantineMissionWorktree(executionId: string, error: unknown): void {
    const current = this.persistence.getTeamMissionWorktree(executionId);
    if (current === null || current.state === 'cleaned') return;
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    this.persistence.updateTeamMissionWorktree({
      executionId,
      to: 'quarantined',
      reason: reason === '' ? 'Mission worktree requires inspection' : reason,
      now: this.isoNow(),
    });
  }

  private missionWorktreeSummary(executionId: string) {
    const worktree = this.persistence.getTeamMissionWorktree(executionId);
    if (worktree === null) return null;
    return {
      path: worktree.path,
      baseHead: worktree.baseHead,
      state: worktree.state,
      workerHead: worktree.workerHead,
      integratedHead: worktree.integratedHead,
      changedFiles: [...worktree.changedFiles],
      reason: worktree.reason,
    };
  }

  private executionIsolationSummary(executionId: string): TeamExecutionIsolation | null {
    const isolation = this.persistence.getTeamExecutionIsolation(executionId);
    if (isolation === null) return null;
    return {
      phase: isolation.phase,
      resumeKind: isolation.resumeKind,
      repositories: isolation.repositories.map((repository) => ({
        ...repository,
        changedFiles: [...repository.changedFiles],
      })),
      roots: isolation.roots.map((root) => ({ ...root })),
      reason: isolation.reason,
    };
  }

  private captureMissionCheckpoint(
    taskId: string,
    summary: string,
    changedFiles: readonly string[],
  ): TeamMissionCheckpoint {
    const fingerprint = this.captureWorkspaceFingerprint(taskId);
    let workspaceDigest = fingerprint.workspaceDigest;
    if (workspaceDigest === null)
      workspaceDigest = createHash('sha256')
        .update(JSON.stringify({ changedFiles: [...changedFiles].sort(), summary }))
        .digest('hex');
    return {
      summary: summary.slice(0, 4_000),
      changedFiles: [...new Set(changedFiles)].slice(0, 500),
      gitHead: fingerprint.gitHead,
      workspaceDigest,
      recordedAt: this.isoNow(),
    };
  }

  private workspaceFingerprintMatches(taskId: string, checkpoint: TeamMissionCheckpoint): boolean {
    const current = this.captureWorkspaceFingerprint(taskId);
    return (
      current.gitHead === checkpoint.gitHead &&
      current.workspaceDigest === checkpoint.workspaceDigest
    );
  }

  private captureWorkspaceFingerprint(taskId: string): {
    gitHead: string | null;
    workspaceDigest: string | null;
  } {
    return captureGitWorkspaceFingerprint(this.persistence.getWorkspace(taskId));
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
      'automatic_retry',
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

const MAX_PRIOR_TEAM_CONVERSATION_ITEMS = 24;
const MAX_PRIOR_TEAM_CONVERSATION_CHARS = 16_000;

export function priorConversationForAgent(
  snapshot: TeamSnapshot,
  agentId: string,
  beforeSeq: number,
): readonly TeamRuntimeConversationItem[] {
  const roles = new Map(snapshot.agents.map((agent) => [agent.id, agent.role]));
  const conversation = snapshot.messages
    .filter(
      (message) =>
        message.seq < beforeSeq &&
        (message.sourceAgentId === agentId || message.targetAgentId === agentId),
    )
    .sort((left, right) => right.seq - left.seq);
  const selected: TeamRuntimeConversationItem[] = [];
  let remainingChars = MAX_PRIOR_TEAM_CONVERSATION_CHARS;

  for (const message of conversation) {
    if (selected.length >= MAX_PRIOR_TEAM_CONVERSATION_ITEMS || remainingChars <= 0) break;
    const direction = message.sourceAgentId === agentId ? 'sent' : 'received';
    const otherAgentId = direction === 'sent' ? message.targetAgentId : message.sourceAgentId;
    const content = message.content.slice(-remainingChars);
    if (content.length === 0) continue;
    selected.push({
      direction,
      role: roles.get(otherAgentId) ?? 'Team Agent',
      content,
    });
    remainingChars -= content.length;
  }

  return selected.reverse();
}

export function executeWithWatchdog<T>(input: {
  execute(observe: (event: WorkerActivityEvent) => void, signal: AbortSignal): Promise<T>;
  hardTimeoutMs: number;
  stop(): Promise<void>;
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let expired = false;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    const heartbeatTimeoutMs = Math.min(WORKER_HEARTBEAT_TIMEOUT_MS, input.hardTimeoutMs);
    const idleTimeoutMs = Math.min(WORKER_IDLE_TIMEOUT_MS, input.hardTimeoutMs);
    const clearTimers = (): void => {
      clearTimeout(hardTimer);
      if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
    };
    const expire = (
      code: 'heartbeat_timeout' | 'idle_timeout' | 'hard_timeout',
      message: string,
    ): void => {
      if (expired) return;
      expired = true;
      clearTimers();
      controller.abort(new WorkerRuntimeControlError(code, message));
      void input.stop().then(
        () => reject(new WorkerRuntimeControlError(code, `${message} after the runtime stopped`)),
        (error: unknown) =>
          reject(
            new WorkerRuntimeControlError(
              'stop_unconfirmed',
              `${message} and runtime stop was not confirmed`,
              { cause: error },
            ),
          ),
      );
    };
    const resetHeartbeat = (): void => {
      if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(
        () => expire('heartbeat_timeout', 'Worker heartbeat timed out'),
        heartbeatTimeoutMs,
      );
    };
    const resetProgress = (): void => {
      resetHeartbeat();
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => expire('idle_timeout', 'Worker made no meaningful progress'),
        idleTimeoutMs,
      );
    };
    resetProgress();
    const hardTimer = setTimeout(
      () => expire('hard_timeout', 'Worker step reached its hard deadline'),
      input.hardTimeoutMs,
    );
    const promise = input.execute((event) => {
      if (event.type === 'heartbeat') resetHeartbeat();
      else resetProgress();
    }, controller.signal);
    void promise.then(
      (value) => {
        if (expired) return;
        clearTimers();
        resolve(value);
      },
      (error: unknown) => {
        if (expired) return;
        clearTimers();
        reject(error);
      },
    );
  });
}

export function captureGitWorkspaceFingerprint(workspacePath: string | null): {
  gitHead: string | null;
  workspaceDigest: string | null;
} {
  if (workspacePath === null) return { gitHead: null, workspaceDigest: null };
  const options = {
    encoding: 'utf8' as const,
    timeout: 5_000,
    maxBuffer: 16 * 1024 * 1024,
  };
  const git = (...args: string[]) =>
    spawnSync('git', ['-c', 'core.hooksPath=', '-C', workspacePath, ...args], options);
  const head = git('rev-parse', 'HEAD');
  const status = git('status', '--porcelain=v1', '-z');
  const unstaged = git('diff', '--binary', '--no-ext-diff');
  const staged = git('diff', '--cached', '--binary', '--no-ext-diff');
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z');
  if (
    head.status !== 0 ||
    head.stdout.trim() === '' ||
    status.status !== 0 ||
    unstaged.status !== 0 ||
    staged.status !== 0 ||
    untracked.status !== 0
  )
    return { gitHead: null, workspaceDigest: null };
  const untrackedPaths = untracked.stdout
    .split('\0')
    .filter((path) => path !== '')
    .slice(0, 500);
  const untrackedHashes =
    untrackedPaths.length === 0 ? null : git('hash-object', '--', ...untrackedPaths);
  if (untrackedHashes !== null && untrackedHashes.status !== 0)
    return { gitHead: null, workspaceDigest: null };
  return {
    gitHead: head.stdout.trim(),
    workspaceDigest: createHash('sha256')
      .update(status.stdout)
      .update('\0')
      .update(unstaged.stdout)
      .update('\0')
      .update(staged.stdout)
      .update('\0')
      .update(untracked.stdout)
      .update('\0')
      .update(untrackedHashes?.stdout ?? '')
      .digest('hex'),
  };
}

function isolationWorktreeId(executionId: string, repositoryOrdinal: number): string {
  return `${executionId}-${repositoryOrdinal}`;
}

function isolationLeaseBindings(
  isolation: Pick<TeamExecutionIsolationRecord, 'repositories' | 'roots'>,
): readonly {
  rootId: string;
  mutationKey: string;
  identity: string;
}[] {
  const repositories = isolation.repositories.map(({ ordinal, repoPath }) => {
    const canonicalKey = process.platform === 'win32' ? repoPath.toLowerCase() : repoPath;
    const mutationKey = createHash('sha256')
      .update(`team-repository\0${canonicalKey}`)
      .digest('hex');
    return {
      rootId: `repository-${ordinal}`,
      mutationKey,
      identity: createHash('sha256')
        .update(`team-repository-identity\0${canonicalKey}`)
        .digest('hex'),
    };
  });
  return [...isolation.roots, ...repositories];
}

function replaceIsolationRepository(
  repositories: TeamExecutionIsolation['repositories'],
  ordinal: number,
  replacement: TeamExecutionIsolation['repositories'][number],
): TeamExecutionIsolation['repositories'] {
  if (!repositories.some((repository) => repository.ordinal === ordinal))
    throw new Error(`Team isolation repository not found: ${ordinal}`);
  return repositories.map((repository) =>
    repository.ordinal === ordinal ? replacement : repository,
  );
}

function isPathInsideOrSame(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === '' || !isEscapingRelativePath(value);
}

function isEscapingRelativePath(value: string): boolean {
  return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value);
}

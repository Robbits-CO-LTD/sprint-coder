import {
  app,
  dialog,
  ipcMain,
  MessageChannelMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type MessagePortMain,
} from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { workspaceMutationBinding } from './path-guard';
import { z } from 'zod';
import {
  IPC_CHANNELS,
  appInfoSchema,
  approvalResolveInputSchema,
  approvalSummarySchema,
  autoPermissionDecisionSchema,
  canvasViewSchema,
  canvasViewSaveInputSchema,
  canvasViewSaveResultSchema,
  chatMessageSchema,
  commandSummarySchema,
  commandOutputPageInputSchema,
  commandOutputPageSchema,
  commandOutputTailInputSchema,
  commandEnvelopeSchema,
  emptyPayloadSchema,
  permissionSetInputSchema,
  permissionSettingsSchema,
  runtimeSetInputSchema,
  runtimeModelSetInputSchema,
  runtimeSettingsSchema,
  taskArchivedInputSchema,
  taskCreateInputSchema,
  taskDraftInputSchema,
  taskGoalInputSchema,
  taskIdPayloadSchema,
  taskPinnedInputSchema,
  taskRenameInputSchema,
  taskSummarySchema,
  teamDetailSchema,
  teamEventSchema,
  teamHireWorkerInputSchema,
  teamMessageSummarySchema,
  teamSendMessageInputSchema,
  teamSummarySchema,
  teamWorkerRefSchema,
  workerSummarySchema,
  turnCancelInputSchema,
  turnEventSchema,
  turnQueueInputSchema,
  turnQueueResultSchema,
  turnSnapshotSchema,
  turnStartInputSchema,
  turnStartResultSchema,
  turnSteerInputSchema,
  turnStopAndSendInputSchema,
  turnSubscriptionInputSchema,
  workspaceSelectionSchema,
  type CommandEnvelope,
  type CommandResult,
  type AccessPreset,
  type PublicError,
  type RuntimeKind,
  type TurnEvent,
} from '@sprint-coder/contracts';
import type { PreparedContext } from './context-ledger';
import { digestCanonical } from './context-compiler';
import { createEmptyToolCatalogSnapshot } from './default-tools';
import type { PersistenceClient, QueueTransition, StartedTurn } from './persistence';
import { toApprovalAuditSummary, toApprovalSummary } from './persistence';
import {
  CanvasViewConflictError,
  InvalidCanvasViewError,
  NotFoundError,
  OperationConflictError,
  OperationInProgressError,
  SteerStaleError,
  TurnActiveError,
} from './persistence';
import { MockRuntimeAdapter } from './runtime';
import { RuntimeHostClient } from './runtime-host';
import { PermissionBroker } from './permission-broker';
import { ApprovalCoordinator, approvalFactsForTool } from './approval-coordinator';
import type { ToolAuthorizationRequest } from './tool-broker';
import type { RuntimeCanonicalEvent } from '../runtime-host/protocol';
import { permissionRequestFingerprint, type Capability } from '@sprint-coder/domain';
import type { ExecutionSpec } from '@sprint-coder/domain';
import { executionSpecPathGuard } from './command-runner';
import { AutoReviewer, autoReviewerInputDigest } from './auto-reviewer';
import { MutationLeaseBusyError, MutationQuarantinedError } from './mutation-lease';
import {
  authorizeClaudeProviderEgress,
  authorizeCodexProviderEgress,
  dispatchAfterCodexProviderEgress,
  dispatchAfterClaudeProviderEgress,
} from './provider-egress';
import { TeamCoordinator } from './team-coordinator';
import { RuntimeHostTeamWorkerRuntime, chooseWorkerRuntime } from './team-worker-runtime';
import { isTeamScenarioInput, LEADER_MCP_SYSTEM_PROMPT } from './team-tools';
import { TeamMcpBridge, defaultSocketPathFactory } from './team-mcp-bridge';
import type { RuntimeTeamMcpOption } from '../runtime-host/protocol';

type InvokeEvent = IpcMainInvokeEvent;
type PortBinding = { taskId: string; port: MessagePortMain };

export class IpcRouter {
  private readonly ports = new Set<PortBinding>();
  private readonly mailbox = new TaskMailbox();
  private readonly mockRuntime: MockRuntimeAdapter;
  private readonly codexRuntime: RuntimeHostClient;
  private readonly teamWorkerRuntime: RuntimeHostTeamWorkerRuntime;
  private readonly claudeRuntime: RuntimeHostClient;
  private readonly turnRuntimes = new Map<string, RuntimeKind>();
  private readonly permissionBroker: PermissionBroker;
  private readonly approvalCoordinator: ApprovalCoordinator;
  private readonly autoReviewer = AutoReviewer.createProduction();
  private readonly teamCoordinator: TeamCoordinator;
  private readonly teamSubscriptions = new Set<string>();
  private readonly teamMcpBridge: TeamMcpBridge;

  constructor(
    private readonly window: BrowserWindow,
    private readonly persistence: PersistenceClient,
    private readonly trustedRendererOrigin: string,
  ) {
    this.teamWorkerRuntime = new RuntimeHostTeamWorkerRuntime({
      // Real worker execution is opt-in (costs provider usage and breaks determinism): the mock
      // runtime borrows Claude only under SPRINT_CODER_REAL_WORKERS=1. Probe failures inside the
      // worker runtime still fall back to the deterministic simulator.
      selectRuntime: () =>
        chooseWorkerRuntime(
          this.persistence.getRuntime(),
          this.persistence.getModel(),
          process.env['SPRINT_CODER_REAL_WORKERS'] === '1',
        ),
      workspaceFor: (taskId) => this.persistence.getWorkspace(taskId),
      catalogFor: (kind, workspacePath) =>
        createEmptyToolCatalogSnapshot(
          kind,
          workspacePath === null ? null : digestCanonical({ workspacePath }),
        ),
      authorizeEgress: (kind, taskId, turnId, prompt) => {
        const authorize =
          kind === 'claude' ? authorizeClaudeProviderEgress : authorizeCodexProviderEgress;
        return authorize({
          broker: this.permissionBroker,
          task: this.persistence.getTask(taskId),
          turnId,
          prompt,
          context: { fragments: [], usageEvents: [], compacted: false },
          now: new Date().toISOString(),
        }).allowed;
      },
    });
    this.teamCoordinator = new TeamCoordinator(
      persistence,
      this.teamWorkerRuntime,
      (taskId, detail) => {
        if (this.teamSubscriptions.has(taskId) && !this.window.isDestroyed())
          this.window.webContents.send(IPC_CHANNELS.teamsEvent, {
            taskId,
            event: teamEventSchema.parse({ type: 'updated', detail }),
          });
      },
      undefined,
      // Real worker turns run a full provider CLI invocation; the deterministic 10s default is
      // far too tight for that.
      180_000,
    );
    // Leader MCP (SPRINT_CODER_LEADER_MCP=1): the socket the real Claude Leader's MCP server
    // connects back through to reach this same TeamCoordinator. Starting it here (rather than
    // lazily on first team turn) means `initialize()` can await it once at app startup; a failed
    // start degrades to `socketPath === null`, which startSelectedRuntime treats as "fall back to
    // the mock leader path" rather than a hard failure.
    this.teamMcpBridge = new TeamMcpBridge(
      this.teamCoordinator,
      defaultSocketPathFactory(app.getPath('userData')),
    );
    this.approvalCoordinator = new ApprovalCoordinator({
      persistence,
      now: () => new Date().toISOString(),
      expiresAt: () => new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      getCurrentPolicyEpoch: (taskId) => this.persistence.getPermissionPolicy(taskId).policyEpoch,
      isTurnActive: (taskId, turnId) => this.persistence.getActiveTurnId(taskId) === turnId,
      evaluatePermission: ({ capability, request }) =>
        this.evaluateToolPermission(request, capability),
      publish: (_approval, event) => {
        const parsed = turnEventSchema.safeParse(event);
        if (parsed.success) this.publish(parsed.data);
      },
    });
    this.permissionBroker = new PermissionBroker(persistence, {
      policyEpochChanged: (taskId, policyEpoch) => {
        this.approvalCoordinator.policyEpochChanged(taskId, policyEpoch);
        this.persistence.quarantineBackgroundForPolicyEpoch(
          taskId,
          policyEpoch,
          new Date().toISOString(),
        );
      },
    });
    this.mockRuntime = new MockRuntimeAdapter(
      persistence,
      (event) => this.publish(event),
      240,
      (taskId, action) => this.mailbox.run(taskId, action),
      (taskId, turnId, state) => {
        if (this.turnRuntimes.get(turnId) === 'mock') this.finishAndAdvance(taskId, turnId, state);
      },
      (taskId, turnId) => this.prepareContext(taskId, turnId),
      this.approvalCoordinator.authorizeTool.bind(this.approvalCoordinator),
      (taskId, turnId, fragmentIds) => this.acknowledgeRuntimeContext(taskId, turnId, fragmentIds),
      // Wires the Leader team tools (team_hire_worker/team_send_to_worker/team_wait_reports/
      // team_stop_worker) into the mock intelligence loop — see team-tools.ts.
      this.teamCoordinator,
    );
    this.codexRuntime = new RuntimeHostClient(
      (taskId, turnId, runtimeEvent) =>
        this.handleRuntimeEvent('codex', taskId, turnId, runtimeEvent),
      (taskId, turnId, error) => this.handleRuntimeFailure('codex', taskId, turnId, error),
      (taskId, turnId) => this.prepareContext(taskId, turnId),
      (taskId, turnId, fragmentIds) => this.acknowledgeRuntimeContext(taskId, turnId, fragmentIds),
      'codex',
    );
    this.claudeRuntime = new RuntimeHostClient(
      (taskId, turnId, runtimeEvent) =>
        this.handleRuntimeEvent('claude', taskId, turnId, runtimeEvent),
      (taskId, turnId, error) => this.handleRuntimeFailure('claude', taskId, turnId, error),
      (taskId, turnId) => this.prepareContext(taskId, turnId),
      (taskId, turnId, fragmentIds) => this.acknowledgeRuntimeContext(taskId, turnId, fragmentIds),
      'claude',
    );
  }

  register(): void {
    this.handle(IPC_CHANNELS.appGetInfo, emptyPayloadSchema, appInfoSchema, () => ({
      version: app.getVersion(),
      platform: process.platform,
    }));
    this.handle(
      IPC_CHANNELS.settingsGetRuntime,
      emptyPayloadSchema,
      runtimeSettingsSchema,
      async () => {
        const [codexCapability, claudeCapability] = await Promise.all([
          this.codexRuntime.probe(),
          this.claudeRuntime.probe(),
        ]);
        const kind = this.persistence.getRuntime();
        const activeCapability = kind === 'claude' ? claudeCapability : codexCapability;
        const storedModel = this.persistence.getModel();
        const model = activeCapability.models.some(({ id }) => id === storedModel)
          ? storedModel
          : 'auto';
        return {
          kind,
          codexAvailable: codexCapability.available,
          claudeAvailable: claudeCapability.available,
          model,
          models: activeCapability.models,
        };
      },
    );
    this.handleMutation(
      IPC_CHANNELS.settingsSetRuntime,
      runtimeSetInputSchema,
      z.undefined(),
      async (input, event, envelope) => {
        if (input.kind === 'codex' || input.kind === 'claude') {
          const capability = await this.runtimeFor(input.kind).probe();
          if (!capability.available) throw new RuntimeUnavailableError(input.kind);
        }
        return this.runMutation(event, envelope, '', IPC_CHANNELS.settingsSetRuntime, () =>
          this.persistence.setRuntime(input.kind),
        ).value;
      },
    );
    this.handleMutation(
      IPC_CHANNELS.settingsSetModel,
      runtimeModelSetInputSchema,
      z.undefined(),
      async (input, event, envelope) => {
        // Model membership is validated against the currently *active* Runtime kind's own
        // capability list — Codex and Claude have disjoint model spaces (Main-side scoping per
        // the ADR), so a Codex model id can never leak into a Claude turn or vice versa.
        const kind = this.persistence.getRuntime();
        const runtimeKind = kind === 'claude' ? 'claude' : 'codex';
        const capability = await this.runtimeFor(runtimeKind).probe();
        if (!capability.available) throw new RuntimeUnavailableError(runtimeKind);
        if (!capability.models.some(({ id }) => id === input.model))
          throw new InvalidModelError(runtimeKind);
        return this.runMutation(event, envelope, '', IPC_CHANNELS.settingsSetModel, () =>
          this.persistence.setModel(input.model),
        ).value;
      },
    );
    this.handle(
      IPC_CHANNELS.permissionsGet,
      taskIdPayloadSchema,
      permissionSettingsSchema,
      (input) => {
        const policy = this.permissionBroker.getPolicy(input.taskId);
        return { preset: policy.preset, policyEpoch: policy.policyEpoch };
      },
    );
    this.handle(
      IPC_CHANNELS.permissionsListAutoDecisions,
      taskIdPayloadSchema,
      z.array(autoPermissionDecisionSchema),
      (input) => this.persistence.listAutoPermissionDecisions(input.taskId),
    );
    this.handleMutation(
      IPC_CHANNELS.permissionsSet,
      permissionSetInputSchema,
      permissionSettingsSchema,
      async (input, event, envelope) => {
        const principal = principalFor(event);
        const hash = requestHash(envelope.payload);
        const cached = this.persistence.getOperationResult<{
          preset: AccessPreset;
          policyEpoch: number;
        }>(principal, input.taskId, IPC_CHANNELS.permissionsSet, envelope.operationId, hash);
        if (cached.found) return cached.value!;
        const current = this.permissionBroker.getPolicy(input.taskId);
        if (current.policyEpoch !== input.expectedPolicyEpoch)
          throw new StalePermissionPolicyError();
        if (input.preset === 'full') {
          const confirmation = await dialog.showMessageBox(this.window, {
            type: 'warning',
            title: 'フルアクセスを有効にしますか？',
            message: 'フルアクセスはTaskのWorkspace操作を拡張します。',
            detail: '管理deny、秘密情報保護、provider egress、Renderer非特権は解除されません。',
            buttons: ['キャンセル', 'フルアクセスを有効化'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          if (confirmation.response !== 1) throw new FullAccessConfirmationDeclinedError();
        }
        if (this.permissionBroker.getPolicy(input.taskId).policyEpoch !== input.expectedPolicyEpoch)
          throw new StalePermissionPolicyError();
        const value = this.persistence.executeOperation(
          principal,
          input.taskId,
          IPC_CHANNELS.permissionsSet,
          envelope.operationId,
          hash,
          () => {
            const policy = this.persistence.setAccessPreset(
              input.taskId,
              input.preset,
              input.expectedPolicyEpoch,
            );
            return { preset: policy.preset, policyEpoch: policy.policyEpoch };
          },
        );
        await this.permissionBroker.drainPolicyEpochOutbox().catch(() => undefined);
        return value;
      },
    );
    this.handle(
      IPC_CHANNELS.approvalsListPending,
      taskIdPayloadSchema,
      z.array(approvalSummarySchema),
      (input) => this.persistence.listPendingApprovals(input.taskId).map(toApprovalSummary),
    );
    this.handle(
      IPC_CHANNELS.approvalsListRecent,
      taskIdPayloadSchema,
      z.array(approvalSummarySchema),
      (input) => this.persistence.listRecentApprovals(input.taskId).map(toApprovalAuditSummary),
    );
    this.handleMutation(
      IPC_CHANNELS.approvalsResolve,
      approvalResolveInputSchema,
      approvalSummarySchema,
      (input, _event, envelope) => {
        const approval = this.persistence.getApproval(input.taskId, input.approvalId);
        if (approval.policyEpoch !== input.expectedPolicyEpoch)
          throw new StalePermissionPolicyError();
        this.approvalCoordinator.resolve({
          taskId: input.taskId,
          turnId: approval.turnId,
          approvalId: input.approvalId,
          decision: input.decision,
          expectedRevision: input.expectedRevision,
          challenge: input.challenge,
          operationId: envelope.operationId,
        });
        const event = [...this.persistence.listEventsAfter(input.taskId, 0)]
          .reverse()
          .find(
            (candidate) =>
              candidate.type === 'approval.resolved' && candidate.approvalId === input.approvalId,
          );
        if (event !== undefined) this.publish(event);
        return toApprovalAuditSummary(this.persistence.getApproval(input.taskId, input.approvalId));
      },
    );
    this.handle(
      IPC_CHANNELS.commandsList,
      taskIdPayloadSchema,
      z.array(commandSummarySchema),
      (input) => this.persistence.listCommands(input.taskId),
    );
    this.handle(
      IPC_CHANNELS.commandsOutputPage,
      commandOutputPageInputSchema,
      commandOutputPageSchema,
      (input) => this.persistence.commandOutputPage(input),
    );
    this.handle(
      IPC_CHANNELS.commandsOutputTail,
      commandOutputTailInputSchema,
      commandOutputPageSchema,
      (input) => this.persistence.commandOutputTail(input),
    );
    this.handle(IPC_CHANNELS.tasksList, emptyPayloadSchema, z.array(taskSummarySchema), () =>
      this.persistence.listTasks(),
    );
    this.handleMutation(
      IPC_CHANNELS.tasksCreate,
      taskCreateInputSchema,
      taskSummarySchema,
      (_input, _event, envelope) =>
        this.runMutation(_event, envelope, '', IPC_CHANNELS.tasksCreate, () =>
          this.persistence.createTask(_input.title, _input.localOnly),
        ).value,
    );
    this.handle(
      IPC_CHANNELS.tasksMessages,
      taskIdPayloadSchema,
      z.array(chatMessageSchema),
      (input) => this.persistence.listMessages(input.taskId),
    );
    this.handleMutation(
      IPC_CHANNELS.tasksRename,
      taskRenameInputSchema,
      taskSummarySchema,
      (input, event, envelope) =>
        this.runMutation(event, envelope, input.taskId, IPC_CHANNELS.tasksRename, () =>
          this.persistence.renameTask(input.taskId, input.title),
        ).value,
    );
    this.handleMutation(
      IPC_CHANNELS.tasksSetPinned,
      taskPinnedInputSchema,
      taskSummarySchema,
      (input, event, envelope) =>
        this.runMutation(event, envelope, input.taskId, IPC_CHANNELS.tasksSetPinned, () =>
          this.persistence.setPinned(input.taskId, input.pinned),
        ).value,
    );
    this.handleMutation(
      IPC_CHANNELS.tasksSetArchived,
      taskArchivedInputSchema,
      taskSummarySchema,
      (input, event, envelope) =>
        this.runMutation(event, envelope, input.taskId, IPC_CHANNELS.tasksSetArchived, () =>
          this.persistence.setArchived(input.taskId, input.archived),
        ).value,
    );
    this.handleMutation(
      IPC_CHANNELS.tasksSetGoal,
      taskGoalInputSchema,
      taskSummarySchema,
      (input, event, envelope) =>
        this.runMutation(event, envelope, input.taskId, IPC_CHANNELS.tasksSetGoal, () =>
          this.persistence.setGoal(input.taskId, input.goal),
        ).value,
    );
    this.handle(IPC_CHANNELS.tasksGetDraft, taskIdPayloadSchema, z.string(), (input) =>
      this.persistence.getDraft(input.taskId),
    );
    this.handleMutation(
      IPC_CHANNELS.tasksSetDraft,
      taskDraftInputSchema,
      z.undefined(),
      (input, event, envelope) =>
        this.runMutation(event, envelope, input.taskId, IPC_CHANNELS.tasksSetDraft, () =>
          this.persistence.setDraft(input.taskId, input.draft),
        ).value,
    );

    this.handleMutation(
      IPC_CHANNELS.teamsPromote,
      taskIdPayloadSchema,
      teamSummarySchema,
      (input, event, envelope) =>
        this.runMutation(event, envelope, input.taskId, IPC_CHANNELS.teamsPromote, () =>
          this.persistence.promoteTaskToTeam(input.taskId),
        ).value,
    );
    this.handle(IPC_CHANNELS.teamsGet, taskIdPayloadSchema, teamDetailSchema.nullable(), (input) =>
      this.teamCoordinator.get(input.taskId),
    );
    // hireWorker/sendToWorker IPC handlers remain wired for the current UI, but the primary path
    // is now the Leader's own tool use during its Turn (team_hire_worker/team_send_to_worker in
    // team-tools.ts, going through this same TeamCoordinator) per FR-TEAM-06/13 — the user
    // converses with the Leader, the Leader drives the Team. These handlers stay until the
    // renderer is reworked to stop calling them directly.
    this.handleMutation(
      IPC_CHANNELS.teamsHireWorker,
      teamHireWorkerInputSchema,
      workerSummarySchema,
      (input) => this.teamCoordinator.hireWorker(input),
    );
    this.handleMutation(
      IPC_CHANNELS.teamsSend,
      teamSendMessageInputSchema,
      teamMessageSummarySchema,
      (input) => this.teamCoordinator.sendToWorker(input),
    );
    this.handleMutation(
      IPC_CHANNELS.teamsStopWorker,
      teamWorkerRefSchema,
      workerSummarySchema,
      (input) => this.teamCoordinator.stopWorker(input.taskId, input.agentId),
    );
    this.handleMutation(IPC_CHANNELS.teamsStopAll, taskIdPayloadSchema, teamDetailSchema, (input) =>
      this.teamCoordinator.stopAll(input.taskId),
    );
    this.handle(IPC_CHANNELS.teamsSubscribe, taskIdPayloadSchema, z.undefined(), (input) => {
      this.teamSubscriptions.add(input.taskId);
      return undefined;
    });
    this.handle(IPC_CHANNELS.teamsUnsubscribe, taskIdPayloadSchema, z.undefined(), (input) => {
      this.teamSubscriptions.delete(input.taskId);
      return undefined;
    });
    this.handle(
      IPC_CHANNELS.teamsGetCanvasView,
      taskIdPayloadSchema,
      canvasViewSchema.nullable(),
      (input) => this.persistence.getCanvasView(input.taskId),
    );
    this.handleMutation(
      IPC_CHANNELS.teamsSaveCanvasView,
      canvasViewSaveInputSchema,
      canvasViewSaveResultSchema,
      (input, event, envelope) =>
        this.runMutation(event, envelope, input.taskId, IPC_CHANNELS.teamsSaveCanvasView, () => {
          const saved = this.persistence.saveCanvasView(input);
          return { revision: saved.revision };
        }).value,
    );

    this.handle(IPC_CHANNELS.workspaceGet, taskIdPayloadSchema, workspaceSelectionSchema, (input) =>
      workspaceValue(this.persistence.getWorkspace(input.taskId)),
    );
    this.handleMutation(
      IPC_CHANNELS.workspaceSelect,
      taskIdPayloadSchema,
      workspaceSelectionSchema,
      async (input, event, envelope) => {
        this.persistence.getWorkspace(input.taskId);
        const principal = principalFor(event);
        const hash = requestHash(envelope.payload);
        const cached = this.persistence.getOperationResult<ReturnType<typeof workspaceValue>>(
          principal,
          input.taskId,
          IPC_CHANNELS.workspaceSelect,
          envelope.operationId,
          hash,
        );
        if (cached.found) return cached.value ?? null;
        const selected = await dialog.showOpenDialog(this.window, {
          properties: ['openDirectory'],
        });
        if (selected.canceled || selected.filePaths.length === 0) {
          return this.persistence.executeOperation(
            principal,
            input.taskId,
            IPC_CHANNELS.workspaceSelect,
            envelope.operationId,
            hash,
            () => null,
          );
        }
        const selectedPath = selected.filePaths[0];
        if (selectedPath === undefined)
          throw new Error('Directory selection did not include a path');
        const binding = await workspaceMutationBinding(selectedPath);
        return this.persistence.executeOperation(
          principal,
          input.taskId,
          IPC_CHANNELS.workspaceSelect,
          envelope.operationId,
          hash,
          () => {
            this.persistence.setWorkspaceBinding(input.taskId, {
              path: binding.canonicalPath,
              workspaceKey: binding.workspaceKey,
              rootIdentityDigest: binding.rootIdentityDigest,
            });
            return workspaceValue(binding.canonicalPath);
          },
        );
      },
    );

    this.handleMutation(
      IPC_CHANNELS.turnsStart,
      turnStartInputSchema,
      turnStartResultSchema,
      (input, event, envelope) => {
        let started: StartedTurn | undefined;
        const result = this.runMutation(
          event,
          envelope,
          input.taskId,
          IPC_CHANNELS.turnsStart,
          () => {
            started = this.persistence.startTurn(input.taskId, input.text);
            return { turnId: started.turnId };
          },
        );
        if (result.executed && started !== undefined) this.dispatchStarted(started);
        return result.value;
      },
    );
    this.handleMutation(
      IPC_CHANNELS.turnsQueue,
      turnQueueInputSchema,
      turnQueueResultSchema,
      (input, event, envelope) => {
        let queueEvent: TurnEvent | undefined;
        const result = this.runMutation(
          event,
          envelope,
          input.taskId,
          IPC_CHANNELS.turnsQueue,
          () => {
            const queued = this.persistence.queueInput(
              input.taskId,
              input.text,
              envelope.operationId,
            );
            queueEvent = queued.event;
            return { ordinal: queued.ordinal };
          },
        );
        if (result.executed && queueEvent !== undefined) this.publish(queueEvent);
        return result.value;
      },
    );
    this.handleMutation(
      IPC_CHANNELS.turnsSteer,
      turnSteerInputSchema,
      z.undefined(),
      (input, event, envelope) => {
        const activeRuntimeKind = this.turnRuntimes.get(input.expectedTurnId);
        if (activeRuntimeKind === 'codex' || activeRuntimeKind === 'claude')
          throw new SteerUnsupportedError();
        const result = this.runMutation(
          event,
          envelope,
          input.taskId,
          IPC_CHANNELS.turnsSteer,
          () => this.persistence.steerTurn(input.taskId, input.text, input.expectedTurnId),
        );
        if (result.executed) this.mockRuntime.steer(input.expectedTurnId, input.text);
        return result.value;
      },
    );
    this.handleMutation(
      IPC_CHANNELS.turnsStopAndSend,
      turnStopAndSendInputSchema,
      z.undefined(),
      async (input, event, envelope) => {
        const principal = principalFor(event);
        const hash = requestHash(envelope.payload);
        const cached = this.persistence.getOperationResult<void>(
          principal,
          input.taskId,
          IPC_CHANNELS.turnsStopAndSend,
          envelope.operationId,
          hash,
        );
        if (cached.found) return cached.value;
        const activeTurnId = this.persistence.getActiveTurnId(input.taskId);
        if (activeTurnId !== null) {
          this.approvalCoordinator.turnEnded(input.taskId, activeTurnId, 'canceled');
          await this.cancelRuntime(input.taskId, activeTurnId);
        }
        const canceledTurnId: string | null = activeTurnId;
        let canceledEvent: TurnEvent | null = null;
        let started: StartedTurn | undefined;
        const result = this.runMutation(
          event,
          envelope,
          input.taskId,
          IPC_CHANNELS.turnsStopAndSend,
          () => {
            if (canceledTurnId !== null)
              canceledEvent = this.persistence.cancelTurn(input.taskId, canceledTurnId);
            started = this.persistence.startTurn(input.taskId, input.text);
          },
        );
        if (result.executed) {
          if (canceledEvent !== null) this.publish(canceledEvent);
          if (started !== undefined) this.dispatchStarted(started);
        }
        return result.value;
      },
    );
    this.handleMutation(
      IPC_CHANNELS.turnsCancel,
      turnCancelInputSchema,
      z.undefined(),
      async (input, event, envelope) => {
        this.approvalCoordinator.turnEnded(input.taskId, input.turnId, 'canceled');
        await this.cancelRuntime(input.taskId, input.turnId);
        let canceledEvent: TurnEvent | null = null;
        let next: QueueTransition = null;
        const result = this.runMutation(
          event,
          envelope,
          input.taskId,
          IPC_CHANNELS.turnsCancel,
          () => {
            canceledEvent = this.persistence.cancelTurn(input.taskId, input.turnId);
            next = canceledEvent === null ? null : this.persistence.startNextQueued(input.taskId);
          },
        );
        if (result.executed) {
          if (canceledEvent !== null) this.publish(canceledEvent);
          this.dispatchQueueTransition(next);
        }
        return result.value;
      },
    );
    this.handle(
      IPC_CHANNELS.turnsSnapshot,
      taskIdPayloadSchema,
      turnSnapshotSchema,
      async (input) =>
        this.mailbox.run(input.taskId, () => {
          const next = this.persistence.startNextQueued(input.taskId);
          this.dispatchQueueTransition(next);
          return this.persistence.snapshot(input.taskId);
        }),
    );
    this.handle(
      IPC_CHANNELS.turnsSubscribe,
      turnSubscriptionInputSchema,
      z.undefined(),
      (input, event, envelope) => {
        const replay = this.persistence.listEventsAfter(input.taskId, input.afterSeq ?? 0);
        const frame = event.senderFrame;
        if (frame === null) throw new SecurityError();
        const { port1, port2 } = new MessageChannelMain();
        const binding: PortBinding = { taskId: input.taskId, port: port1 };
        this.ports.add(binding);
        port1.on('message', ({ data }: { data: unknown }) => {
          if (isUnsubscribeMessage(data)) this.closePort(binding);
        });
        port1.on('close', () => this.ports.delete(binding));
        port1.start();
        frame.postMessage(
          IPC_CHANNELS.turnsPort,
          { requestId: envelope.requestId, taskId: input.taskId },
          [port2],
        );
        for (const replayed of replay) port1.postMessage(replayed);
        return undefined;
      },
    );
    this.window.webContents.once('destroyed', () => this.closeAllPorts());
  }

  async initialize(): Promise<void> {
    this.teamCoordinator.recoverOnStartup();
    await this.permissionBroker.drainPolicyEpochOutbox();
    if (process.env['SPRINT_CODER_LEADER_MCP'] === '1') await this.teamMcpBridge.ensureStarted();
  }

  async dispose(): Promise<void> {
    for (const channel of new Set(Object.values(IPC_CHANNELS))) ipcMain.removeHandler(channel);
    this.closeAllPorts();
    this.teamSubscriptions.clear();
    this.approvalCoordinator.dispose();
    await this.mockRuntime.dispose();
    this.codexRuntime.dispose();
    this.teamWorkerRuntime.dispose();
    this.claudeRuntime.dispose();
    await this.teamMcpBridge.dispose();
  }

  private handle<TInput, TOutput>(
    channel: string,
    inputSchema: z.ZodType<TInput>,
    outputSchema: z.ZodType<TOutput>,
    handler: (
      input: TInput,
      event: InvokeEvent,
      envelope: CommandEnvelope<TInput>,
    ) => TOutput | Promise<TOutput>,
  ): void {
    const envelopeSchema = commandEnvelopeSchema(inputSchema);
    ipcMain.handle(
      channel,
      async (event: InvokeEvent, raw: unknown): Promise<CommandResult<TOutput>> => {
        const fallbackRequestId = getRequestId(raw);
        try {
          this.validateSender(event);
          const envelope = envelopeSchema.parse(raw) as CommandEnvelope<TInput>;
          if (hasTaskId(envelope.payload) && envelope.taskId !== envelope.payload.taskId)
            throw new SecurityError();
          const value = outputSchema.parse(await handler(envelope.payload, event, envelope));
          return { ok: true, requestId: envelope.requestId, value };
        } catch (error) {
          return { ok: false, requestId: fallbackRequestId, error: toPublicError(error) };
        }
      },
    );
  }

  private handleMutation<TInput, TOutput>(
    channel: string,
    inputSchema: z.ZodType<TInput>,
    outputSchema: z.ZodType<TOutput>,
    handler: (
      input: TInput,
      event: InvokeEvent,
      envelope: CommandEnvelope<TInput>,
    ) => TOutput | Promise<TOutput>,
  ): void {
    this.handle(channel, inputSchema, outputSchema, (input, event, envelope) =>
      this.mailbox.run(envelope.taskId ?? '__global__', () => handler(input, event, envelope)),
    );
  }

  private runMutation<TInput, TOutput>(
    event: InvokeEvent,
    envelope: CommandEnvelope<TInput>,
    taskId: string,
    kind: string,
    action: () => TOutput,
  ): { value: TOutput; executed: boolean } {
    const principal = principalFor(event);
    const hash = requestHash(envelope.payload);
    const cached = this.persistence.getOperationResult<TOutput>(
      principal,
      taskId,
      kind,
      envelope.operationId,
      hash,
    );
    if (cached.found) return { value: cached.value as TOutput, executed: false };
    return {
      value: this.persistence.executeOperation(
        principal,
        taskId,
        kind,
        envelope.operationId,
        hash,
        action,
      ),
      executed: true,
    };
  }

  private finishAndAdvance(taskId: string, turnId: string, state: 'completed' | 'failed'): void {
    this.turnRuntimes.delete(turnId);
    this.teamMcpBridge.unregister(turnId);
    this.publish(this.persistence.completeTurn(taskId, turnId, state));
    this.approvalCoordinator.turnEnded(taskId, turnId, 'finished');
    this.dispatchQueueTransition(this.persistence.startNextQueued(taskId));
  }

  private async evaluateToolPermission(request: ToolAuthorizationRequest, capability: Capability) {
    const facts = approvalFactsForTool(request, capability);
    const commandRunner = request.entry.implementationKind === 'command-runner';
    const sandboxProfile = commandRunner ? ('full' as const) : ('read-only' as const);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    const ceilingEntry = {
      capability,
      resourceSet: facts.resourceSet,
      operations: [facts.operation],
      expiresAt,
      providerEgress: ['none' as const],
      sandboxProfiles: [sandboxProfile],
    };
    const toolFacts = {
      kind: request.entry.kind,
      sideEffect: request.entry.sideEffect,
      risk: request.entry.risk,
    } as const;
    const permissionRequestBase = {
      taskId: request.context.taskId,
      subjectId: facts.subjectId,
      capability,
      resource: facts.resource,
      operation: facts.operation,
      providerEgress: 'none' as const,
      sandboxProfile,
      executionSpecDigest: facts.specDigest,
      risk: request.entry.risk,
    };
    const evaluationInput: Parameters<PermissionBroker['evaluate']>[0] = {
      taskId: request.context.taskId,
      request: {
        ...permissionRequestBase,
        reviewerInputDigest: autoReviewerInputDigest({
          request: permissionRequestBase,
          tool: toolFacts,
          policyEpoch: request.context.policyEpoch,
        }),
      },
      basePolicy: {
        managedDeny: [],
        projectDeny: [],
        parentCeiling: { entries: [ceilingEntry], maxWorkerDepth: 0, maxConcurrentWorkers: 0 },
        modeCeiling: { entries: [ceilingEntry], maxWorkerDepth: 0, maxConcurrentWorkers: 0 },
        sandbox: { feasible: true, profile: sandboxProfile },
      },
      now: new Date().toISOString(),
    };
    const pathGuard =
      request.entry.implementationKind === 'command-runner'
        ? executionSpecPathGuard(request.input as ExecutionSpec)
        : undefined;
    const evaluate = (reviewerDecision?: Awaited<ReturnType<AutoReviewer['review']>>) => {
      const input = {
        ...evaluationInput,
        basePolicy: {
          ...evaluationInput.basePolicy,
          ...(reviewerDecision === undefined ? {} : { reviewerDecision }),
        },
        ...(pathGuard === undefined ? {} : { pathGuard }),
      };
      return request.entry.implementationKind === 'command-runner'
        ? this.permissionBroker.previewExecutionSpec(input)
        : this.permissionBroker.preview(input);
    };
    let evaluation = evaluate();
    let reviewerDecision: Awaited<ReturnType<AutoReviewer['review']>> | undefined;
    const autoPreset = this.permissionBroker.getPolicy(request.context.taskId).preset === 'auto';
    const reviewRequestId = randomUUID();
    if (evaluation.decision === 'approval_required' && autoPreset) {
      reviewerDecision = await this.autoReviewer.review({
        reviewRequestId,
        turnId: request.context.turnId,
        callId: request.callId,
        request: evaluationInput.request,
        tool: toolFacts,
        policyEpoch: evaluation.policyEpoch,
      });
      evaluation = evaluate(reviewerDecision);
    }
    const committedEvent = this.permissionBroker.commitEvaluation(
      {
        ...evaluationInput,
        basePolicy: {
          ...evaluationInput.basePolicy,
          ...(reviewerDecision === undefined ? {} : { reviewerDecision }),
        },
        ...(pathGuard === undefined ? {} : { pathGuard }),
      },
      evaluation,
      autoPreset
        ? autoPermissionDecisionSchema.parse({
            id: randomUUID(),
            taskId: request.context.taskId,
            turnId: request.context.turnId,
            callId: request.callId,
            reviewRequestId,
            capability,
            source:
              reviewerDecision !== undefined
                ? 'reviewer'
                : evaluation.reason === 'preset_auto_safe'
                  ? 'narrow_allow'
                  : 'policy',
            decision:
              evaluation.decision === 'allow' || evaluation.decision === 'allow_once'
                ? evaluation.decision
                : 'deny',
            outcome: reviewerDecision?.decision ?? evaluation.reason,
            reason: evaluation.reason,
            risk: request.entry.risk,
            model: reviewerDecision?.model ?? 'policy-engine',
            templateVersion: reviewerDecision?.templateVersion ?? 'preset-auto-v1',
            requestFingerprint:
              reviewerDecision?.requestFingerprint ??
              permissionRequestFingerprint(evaluationInput.request),
            executionSpecDigest: evaluationInput.request.executionSpecDigest,
            inputDigest: evaluationInput.request.reviewerInputDigest,
            policyEpoch: evaluation.policyEpoch,
            createdAt: new Date().toISOString(),
          })
        : undefined,
    );
    if (committedEvent !== undefined) this.publish(committedEvent);
    if (
      (evaluation.decision === 'allow' || evaluation.decision === 'allow_once') &&
      evaluation.permit !== undefined
    ) {
      const permit = evaluation.permit;
      return {
        decision: 'allow' as const,
        reason: evaluation.reason,
        beforeExecute: () =>
          this.permissionBroker.revalidate({
            ...evaluationInput,
            basePolicy: {
              ...evaluationInput.basePolicy,
              ...(reviewerDecision === undefined ? {} : { reviewerDecision }),
            },
            permit,
            now: new Date().toISOString(),
            ...(pathGuard === undefined ? {} : { pathGuard }),
          }).valid,
      };
    }
    return {
      decision: evaluation.decision === 'allow_once' ? ('deny' as const) : evaluation.decision,
      reason:
        evaluation.decision === 'allow_once'
          ? 'permission_allow_once_missing_permit'
          : evaluation.reason,
    };
  }

  private dispatchStarted(started: StartedTurn): void {
    this.publish(started.event);
    this.startSelectedRuntime(started);
  }

  private dispatchQueueTransition(transition: QueueTransition): void {
    if (transition === null) return;
    this.publish(transition.started.event);
    this.publish(transition.queueEvent);
    this.startSelectedRuntime(transition.started);
  }

  private startSelectedRuntime(started: StartedTurn): void {
    const taskId = started.event.taskId;
    let kind = started.runtimeKind;
    // Leader MCP (SPRINT_CODER_LEADER_MCP=1): a real Claude Leader drives team_* tools itself over
    // the MCP bridge instead of the deterministic mock scenario. Gated to Claude only (Codex has
    // no MCP profile yet). Team tools are offered on EVERY Claude turn so the model itself senses
    // when a request warrants a team (the guidance says to hire only when genuinely beneficial);
    // hiring auto-promotes the task and the renderer auto-opens the canvas, so "the AI decided a
    // team is needed" becomes visible without any keyword or button.
    const wantsLeaderMcp = process.env['SPRINT_CODER_LEADER_MCP'] === '1' && kind === 'claude';
    let teamMcp: RuntimeTeamMcpOption | undefined;
    if (wantsLeaderMcp) {
      teamMcp = this.registerLeaderMcp(started.turnId, taskId);
      // Bridge failed to start on this platform (e.g. socket bind failure): degrade to the same
      // deterministic mock leader every other Claude/Codex team turn already uses, rather than
      // silently running a real Claude turn with no team tools available at all.
      if (teamMcp === undefined) kind = 'mock';
    } else if (kind !== 'mock' && isTeamScenarioInput(started.text)) {
      // Team intent without Leader MCP always runs the leader orchestration
      // (hire→dispatch→reports→synthesis): the production adapters are no-tools by default, so a
      // real-runtime leader cannot drive a team — the deterministic leader orchestrates while
      // Workers execute on the real runtime.
      kind = 'mock';
    }
    this.turnRuntimes.set(started.turnId, kind);
    if (kind === 'mock') {
      this.mockRuntime.start(taskId, started.turnId, started.text);
      return;
    }
    const workspacePath = this.persistence.getWorkspace(taskId);
    const workspaceId =
      workspacePath === null ? null : digestCanonical({ workspacePath: workspacePath });
    const context = this.prepareContext(taskId, started.turnId);
    const dispatchEgress =
      kind === 'claude' ? dispatchAfterClaudeProviderEgress : dispatchAfterCodexProviderEgress;
    const egress = dispatchEgress(
      {
        broker: this.permissionBroker,
        task: this.persistence.getTask(taskId),
        turnId: started.turnId,
        prompt: started.text,
        context,
        now: new Date().toISOString(),
      },
      () =>
        this.runtimeFor(kind).start(
          taskId,
          started.turnId,
          started.text,
          workspacePath,
          started.model,
          createEmptyToolCatalogSnapshot(kind, workspaceId),
          context,
          teamMcp,
        ),
    );
    if (!egress.allowed) {
      this.teamMcpBridge.unregister(started.turnId);
      this.handleRuntimeFailure(kind, taskId, started.turnId, {
        code: 'RUNTIME_FAILED',
        userMessage: 'Providerへの送信がpolicyで拒否されました。',
        retryable: false,
      });
      return;
    }
  }

  /** Starts the bridge's socket if needed and mints a fresh bearer token bound to this one turn.
   * Returns undefined when the bridge is unavailable (never blocks the turn on it — see the
   * fallback in startSelectedRuntime). */
  private registerLeaderMcp(turnId: string, taskId: string): RuntimeTeamMcpOption | undefined {
    const socketPath = this.teamMcpBridge.socketPath;
    if (socketPath === null) return undefined;
    const token = TeamMcpBridge.generateToken();
    this.teamMcpBridge.register(turnId, { taskId, token });
    return { socketPath, token, guidance: LEADER_MCP_SYSTEM_PROMPT };
  }

  private prepareContext(taskId: string, turnId: string): PreparedContext {
    const prepared = this.persistence.prepareContext(taskId, turnId);
    for (const event of prepared.usageEvents) this.publish(event);
    return prepared;
  }

  private acknowledgeRuntimeContext(
    taskId: string,
    turnId: string,
    acceptedFragmentIds: readonly string[],
  ): void {
    const accepted = new Set(acceptedFragmentIds);
    const backgroundIds = this.persistence
      .listBackgroundCompletions(taskId)
      .filter(
        (completion) =>
          completion.state === 'attached' &&
          completion.targetTurnId === turnId &&
          accepted.has(completion.fragmentId),
      )
      .map((completion) => completion.fragmentId);
    for (const event of this.persistence.acknowledgeBackgroundFragments(
      taskId,
      turnId,
      backgroundIds,
    ))
      this.publish(event);
  }

  private runtimeFor(kind: 'codex' | 'claude'): RuntimeHostClient {
    return kind === 'claude' ? this.claudeRuntime : this.codexRuntime;
  }

  private async cancelRuntime(taskId: string, turnId: string): Promise<void> {
    const kind = this.turnRuntimes.get(turnId);
    this.turnRuntimes.delete(turnId);
    this.teamMcpBridge.unregister(turnId);
    if (kind === 'codex' || kind === 'claude') this.runtimeFor(kind).cancel(taskId, turnId);
    else await this.mockRuntime.cancel(turnId);
  }

  private handleRuntimeEvent(
    kind: 'codex' | 'claude',
    taskId: string,
    turnId: string,
    runtimeEvent: RuntimeCanonicalEvent,
  ): void {
    void this.mailbox
      .run(taskId, () => {
        if (this.turnRuntimes.get(turnId) !== kind) return;
        if (runtimeEvent.type === 'stage')
          this.publish(this.persistence.changeStage(taskId, turnId, runtimeEvent.stage));
        else if (runtimeEvent.type === 'delta')
          this.publish(
            this.persistence.appendDelta(
              taskId,
              turnId,
              runtimeEvent.messageId,
              runtimeEvent.delta,
            ),
          );
        else this.finishAndAdvance(taskId, turnId, 'completed');
      })
      .catch(() => this.handleRuntimeFailure(kind, taskId, turnId, runtimeProtocolError()));
  }

  private handleRuntimeFailure(
    kind: 'codex' | 'claude',
    taskId: string,
    turnId: string,
    _error: PublicError,
  ): void {
    void this.mailbox.run(taskId, () => {
      if (this.turnRuntimes.get(turnId) !== kind) return;
      this.finishAndAdvance(taskId, turnId, 'failed');
    });
  }

  private validateSender(event: InvokeEvent): void {
    const frame = event.senderFrame;
    if (
      !isTrustedIpcSender(
        {
          senderId: event.sender.id,
          isMainFrame: frame !== null && frame === frame.top,
          frameUrl: frame === null ? null : frame.url,
        },
        {
          expectedSenderId: this.window.webContents.id,
          trustedRendererOrigin: this.trustedRendererOrigin,
        },
      )
    )
      throw new SecurityError();
  }

  private publish(rawEvent: TurnEvent): void {
    const event = turnEventSchema.parse(rawEvent);
    for (const binding of this.ports) {
      if (binding.taskId === event.taskId) binding.port.postMessage(event);
    }
  }

  private closePort(binding: PortBinding): void {
    this.ports.delete(binding);
    binding.port.close();
  }

  private closeAllPorts(): void {
    for (const binding of [...this.ports]) this.closePort(binding);
  }
}

export class TaskMailbox {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(taskId: string, action: () => T | Promise<T>): Promise<T> {
    const previous = this.tails.get(taskId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.tails.set(taskId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.tails.get(taskId) === tail) this.tails.delete(taskId);
    }
  }
}

// Pure, dependency-free sender/frame authenticity check (NFR-SEC-03): the invoking WebContents
// must be this window's own top-level frame, and that frame's own URL/origin must exactly match
// the one trusted origin the window was created with — never a substring match, never a child
// iframe (a compromised/embedded third-party frame cannot forge the top window's identity), and
// the `app://` custom protocol is further pinned to host `bundle` (the only page this app ever
// serves at that scheme). Extracted as a pure function so it is unit-testable without spinning up
// a real BrowserWindow/WebContents.
export type IpcSenderCandidate = Readonly<{
  senderId: number;
  isMainFrame: boolean;
  frameUrl: string | null;
}>;
export type TrustedIpcSender = Readonly<{
  expectedSenderId: number;
  trustedRendererOrigin: string;
}>;

export function isTrustedIpcSender(
  candidate: IpcSenderCandidate,
  expected: TrustedIpcSender,
): boolean {
  if (
    candidate.senderId !== expected.expectedSenderId ||
    !candidate.isMainFrame ||
    candidate.frameUrl === null
  )
    return false;
  let url: URL;
  try {
    url = new URL(candidate.frameUrl);
  } catch {
    return false;
  }
  const origin = url.protocol === 'app:' ? `${url.protocol}//${url.host}` : url.origin;
  if (origin !== expected.trustedRendererOrigin) return false;
  return url.protocol !== 'app:' || url.host === 'bundle';
}

class SecurityError extends Error {}
class RuntimeUnavailableError extends Error {
  constructor(readonly kind: 'codex' | 'claude' = 'codex') {
    super();
  }
}
class InvalidModelError extends Error {
  constructor(readonly kind: 'codex' | 'claude' = 'codex') {
    super();
  }
}
class StalePermissionPolicyError extends Error {}
class FullAccessConfirmationDeclinedError extends Error {}
class SteerUnsupportedError extends Error {}

function principalFor(_event: InvokeEvent): string {
  return 'local-desktop';
}

function requestHash(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sortValue(payload)))
    .digest('hex');
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

function getRequestId(raw: unknown): string {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'requestId' in raw &&
    typeof raw.requestId === 'string' &&
    raw.requestId.length > 0
  ) {
    return raw.requestId.slice(0, 128);
  }
  return randomUUID();
}

function hasTaskId(value: unknown): value is { taskId: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'taskId' in value &&
    typeof value.taskId === 'string'
  );
}

function isUnsubscribeMessage(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && 'type' in value && value.type === 'unsubscribe'
  );
}

function workspaceValue(path: string | null): { path: string; name: string } | null {
  return path === null ? null : { path, name: basename(path) || path };
}

function toPublicError(error: unknown): PublicError {
  if (error instanceof NotFoundError)
    return { code: 'NOT_FOUND', userMessage: '対象が見つかりません。', retryable: false };
  if (error instanceof TurnActiveError)
    return {
      code: 'TURN_ACTIVE',
      userMessage: 'このタスクでは別のTurnが実行中です。',
      retryable: false,
    };
  if (error instanceof MutationQuarantinedError)
    return {
      code: 'TASK_RECOVERY_REQUIRED',
      userMessage: '安全な編集復旧が完了するまで、このWorkspaceでは新しいTurnを開始できません。',
      retryable: true,
    };
  if (error instanceof MutationLeaseBusyError)
    return {
      code: 'OPERATION_IN_PROGRESS',
      userMessage: 'Workspaceの安全な編集処理が進行中です。',
      retryable: true,
    };
  if (error instanceof SteerStaleError)
    return {
      code: 'STEER_STALE',
      userMessage: '対象のTurnはすでに切り替わっています。',
      retryable: false,
    };
  if (error instanceof SteerUnsupportedError)
    return {
      code: 'STEER_UNSUPPORTED',
      userMessage: '選択中のruntimeは実行中の追加指示に対応していません。',
      retryable: false,
    };
  if (error instanceof RuntimeUnavailableError)
    return {
      code: 'RUNTIME_UNAVAILABLE',
      userMessage:
        error.kind === 'claude'
          ? 'Claude CLIが利用できないため、このruntimeを選択できません。'
          : 'Codex CLIが利用できないため、このruntimeを選択できません。',
      retryable: false,
    };
  if (error instanceof InvalidModelError)
    return {
      code: 'INVALID_REQUEST',
      userMessage:
        error.kind === 'claude'
          ? '選択したモデルは現在のClaude CLIで利用できません。'
          : '選択したモデルは現在のCodex CLIで利用できません。',
      retryable: false,
    };
  if (error instanceof StalePermissionPolicyError)
    return {
      code: 'OPERATION_CONFLICT',
      userMessage: 'Access modeが別の操作で更新されました。最新状態を読み直してください。',
      retryable: true,
    };
  if (error instanceof FullAccessConfirmationDeclinedError)
    return {
      code: 'FORBIDDEN',
      userMessage: 'フルアクセスへの変更をキャンセルしました。',
      retryable: false,
    };
  if (error instanceof OperationConflictError)
    return {
      code: 'OPERATION_CONFLICT',
      userMessage: '同じ操作IDが異なる内容で再利用されました。',
      retryable: false,
    };
  if (error instanceof OperationInProgressError)
    return {
      code: 'OPERATION_IN_PROGRESS',
      userMessage: '同じ操作を処理中です。',
      retryable: true,
    };
  if (error instanceof CanvasViewConflictError)
    return {
      code: 'OPERATION_CONFLICT',
      userMessage: 'Canvasの配置が別の操作で更新されました。最新状態を読み直してください。',
      retryable: true,
    };
  if (error instanceof InvalidCanvasViewError)
    return {
      code: 'INVALID_REQUEST',
      userMessage: 'Canvasの配置に不正な値が含まれています。',
      retryable: false,
    };
  if (error instanceof SecurityError)
    return { code: 'FORBIDDEN', userMessage: 'この操作は許可されていません。', retryable: false };
  if (error instanceof z.ZodError)
    return {
      code: 'INVALID_REQUEST',
      userMessage: '入力内容を確認してください。',
      retryable: false,
    };
  return {
    code: 'INTERNAL_ERROR',
    userMessage: '処理を完了できませんでした。もう一度お試しください。',
    retryable: true,
  };
}

function runtimeProtocolError(): PublicError {
  return {
    code: 'RUNTIME_PROTOCOL_ERROR',
    userMessage: 'Runtime Hostから無効なイベントを受信しました。',
    retryable: false,
  };
}

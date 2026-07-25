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
import { basename, relative as relativePath, resolve as resolvePath } from 'node:path';
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
  fileChangeRecordSchema,
  filePathPayloadSchema,
  fileEditFrameSchema,
  fileOpenResultSchema,
  fileSaveInputSchema,
  fileSaveResultSchema,
  type FileChange,
  permissionSetInputSchema,
  permissionSettingsSchema,
  runtimeSetInputSchema,
  runtimeModelSetInputSchema,
  runtimeEffortSetInputSchema,
  runtimeCodexEffortSetInputSchema,
  runtimeSettingsSchema,
  reasoningBatchSchema,
  runtimeStatusSchema,
  generatedImageSchema,
  generatedImageBytesSchema,
  generatedImageRefSchema,
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
  type CodexModelOption,
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
import { relativizeWorkspacePath, resolveWriteScope } from './write-scope';
import { readWorkspaceTextFile } from './workspace-file';
import { watchWorkspace, type WorkspaceWatcher } from './workspace-watcher';
import { openWorkspaceFileForEdit, saveWorkspaceFile } from './workspace-edit';

/** sha256 of nothing, used when a refusal has no file to hash. */
const EMPTY_FILE_DIGEST = createHash('sha256').update('').digest('hex');
import { createEditBaselines, type EditBaselines } from './edit-baseline';
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
import { ReasoningBatcher } from './reasoning-batcher';
import { createStreamingSecretRedactor } from './secret-redactor';
import { collectThreadImages } from './generated-image-collector';
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
  // The concrete model id the Claude CLI actually resolved for a turn (captured from the
  // stream-json `system/init` event by ClaudeJsonlNormalizer), keyed by turnId until
  // finishAndAdvance folds it into the outgoing `turn.completed` event. Not persisted — see the
  // `resolvedModel` doc comment on turnEventSchema.
  private readonly resolvedModelByTurn = new Map<string, string>();
  // One reasoning batcher per active turn (issue #17). Keyed by turnId and disposed in
  // finishAndAdvance, so a turn cannot leave a timer behind.
  private readonly reasoningByTurn = new Map<string, ReasoningBatcher>();
  // Streaming redaction state per (turn, path) for live file bodies (issue #39). Bounded at 16
  // concurrent files and cleared when a body completes or its turn ends.
  // One recursive Workspace watch per writing Turn (issue #39), stopped in finishAndAdvance.
  private readonly workspaceWatchByTurn = new Map<string, WorkspaceWatcher>();
  // "The file as this Turn found it", per Turn (issue #41). Disposed with the Turn.
  private readonly baselinesByTurn = new Map<string, EditBaselines>();
  private readonly fileEditByKey = new Map<
    string,
    { redactor: ReturnType<typeof createStreamingSecretRedactor>; safe: string; consumed: number }
  >();
  // Per-turn streaming secret redactor. Streaming (not per-fragment) because a key can straddle a
  // batch boundary — redacting each fragment in isolation would let a split token through.
  private readonly reasoningRedactorByTurn = new Map<
    string,
    ReturnType<typeof createStreamingSecretRedactor>
  >();
  // Codex's own thread id for a turn, from its `thread.started` event. The only handle used to find
  // generated images — never a path from a model message (issue #11; see
  // generated-image-collector.ts for why).
  private readonly codexThreadByTurn = new Map<string, string>();
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
      // Mock pseudo-reasoning goes through the same redact → batch → push path as a real runtime's,
      // so the E2E exercises the actual pipeline rather than a shortcut (issue #17).
      (taskId, turnId, text) => this.pushReasoning(taskId, turnId, text),
      // Mock file bodies go through the same redact → path-check → push path a real Runtime's do,
      // so the E2E exercises the pipeline rather than a shortcut (issue #39).
      (taskId, turnId, path, text, complete) =>
        this.pushFileEdit(
          taskId,
          turnId,
          resolvePath(this.persistence.getWorkspace(taskId) ?? '/', path),
          text,
          {
            complete,
            source: 'stream',
          },
        ),
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
      // Startup recovery outcome (issue #9). Already computed before the window existed — this is
      // just the first path that ever carried it to the renderer.
      recovery: this.persistence.getStartupRecovery(),
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
          effort: this.persistence.getEffort(),
          // Clamped for display against whichever Codex model is currently selected. Normally a
          // no-op — setModel clamps and re-persists on every model change — but the cache can also
          // change underneath us (a CLI upgrade rewrites models_cache.json), so the read never
          // reports a level the selected model does not advertise.
          codexEffort: clampCodexEffort(
            this.persistence.getCodexEffort(),
            codexCapability.models,
            kind === 'claude' ? 'auto' : storedModel,
          ),
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
        return this.runMutation(event, envelope, '', IPC_CHANNELS.settingsSetModel, () => {
          this.persistence.setModel(input.model);
          // Models advertise different reasoning levels, so a model change can strand the stored
          // Codex level (Sol advertises `ultra`, GPT-5.5 does not). Re-clamp and persist here so
          // the synchronous turn dispatch can trust `getCodexEffort()` without a probe — leaving
          // it stale would fail the next turn outright rather than degrade.
          if (runtimeKind === 'codex')
            this.persistence.setCodexEffort(
              clampCodexEffort(this.persistence.getCodexEffort(), capability.models, input.model),
            );
        }).value;
      },
    );
    this.handle(IPC_CHANNELS.filesOpen, filePathPayloadSchema, fileOpenResultSchema, (input) => {
      const workspacePath = this.persistence.getWorkspace(input.taskId);
      // No Workspace means no file to open and nowhere to save one, so this is a refusal rather
      // than an empty document the user could type into and then fail to save.
      if (workspacePath === null)
        return {
          path: input.path,
          text: '',
          digest: EMPTY_FILE_DIGEST,
          editable: false,
          reason: 'outside_workspace' as const,
        };
      return openWorkspaceFileForEdit(workspacePath, input.path);
    });
    this.handleMutation(
      IPC_CHANNELS.filesSave,
      fileSaveInputSchema,
      fileSaveResultSchema,
      (input, event, envelope) =>
        this.runMutation(event, envelope, input.taskId, IPC_CHANNELS.filesSave, () => {
          const workspacePath = this.persistence.getWorkspace(input.taskId);
          if (workspacePath === null)
            return {
              outcome: 'refused' as const,
              digest: null,
              reason: 'outside_workspace' as const,
            };
          const result = saveWorkspaceFile(workspacePath, input.path, input.text, input.baseDigest);
          // Audited only on an actual write, and as its own event type: `files.changed` is the record
          // of what a Runtime did, and a human's edit does not belong in it (issue #43).
          if (result.outcome === 'saved')
            this.publish(
              this.persistence.recordUserFileSave({
                taskId: input.taskId,
                path: input.path,
                byteLength: Buffer.byteLength(input.text, 'utf8'),
              }),
            );
          return result;
        }).value,
    );
    this.handle(
      IPC_CHANNELS.filesList,
      taskIdPayloadSchema,
      z.array(fileChangeRecordSchema),
      (input) => this.persistence.listFileChanges(input.taskId),
    );
    this.handle(
      IPC_CHANNELS.imagesList,
      taskIdPayloadSchema,
      z.array(generatedImageSchema),
      (input) => this.persistence.listGeneratedImages(input.taskId),
    );
    this.handle(
      IPC_CHANNELS.imagesRead,
      generatedImageRefSchema,
      generatedImageBytesSchema,
      (input) => {
        const found = this.persistence.readGeneratedImage(input.imageId);
        if (found === null) throw new NotFoundError('Generated image not found');
        // base64 rather than a path or a file:// URL: the renderer builds a `data:` URL from it, so
        // displaying an image can neither touch the filesystem nor issue a request (ADR-004).
        return {
          id: found.image.id,
          mimeType: found.image.mimeType,
          base64: found.bytes.toString('base64'),
        };
      },
    );
    this.handleMutation(
      IPC_CHANNELS.settingsSetEffort,
      runtimeEffortSetInputSchema,
      z.undefined(),
      async (input, event, envelope) =>
        // Unlike setModel, no Runtime-kind capability check: `claudeEffortSchema` (enforced by
        // runtimeEffortSetInputSchema itself, a fixed 5-value enum verified against the installed
        // CLI's --help) is the only validation needed, and the setting is a single global key
        // that only takes effect on Claude turns regardless of which Runtime is currently active
        // — the Composer's effort selector is what gates *visibility*, not this handler.
        this.runMutation(event, envelope, '', IPC_CHANNELS.settingsSetEffort, () =>
          this.persistence.setEffort(input.effort),
        ).value,
    );
    this.handleMutation(
      IPC_CHANNELS.settingsSetCodexEffort,
      runtimeCodexEffortSetInputSchema,
      z.undefined(),
      async (input, event, envelope) => {
        // Unlike Claude's handler, this one *must* validate against a capability list: the set of
        // valid levels is per-model (published in models_cache.json) rather than a fixed enum, and
        // an unsupported level does not fall back — it fails the turn with an API 400.
        const capability = await this.runtimeFor('codex').probe();
        if (!capability.available) throw new RuntimeUnavailableError('codex');
        const selected = capability.models.find(({ id }) => id === this.persistence.getModel());
        if (!selected?.efforts?.some(({ id }) => id === input.effort))
          throw new InvalidEffortError(selected?.displayName ?? 'このモデル');
        return this.runMutation(event, envelope, '', IPC_CHANNELS.settingsSetCodexEffort, () =>
          this.persistence.setCodexEffort(input.effort),
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
            return {
              turnId: started.turnId,
              ...(started.renamedTask === undefined ? {} : { renamedTask: started.renamedTask }),
            };
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
    // A watch outlives its Turn only if the app is torn down mid-write; close them here so the
    // process can actually exit (issue #39).
    for (const watcher of this.workspaceWatchByTurn.values()) watcher.stop();
    this.workspaceWatchByTurn.clear();
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
    const kind = this.turnRuntimes.get(turnId);
    this.turnRuntimes.delete(turnId);
    // Flush the tail and stop the timer before the turn is finalised, so the last thought is not
    // lost to the 120ms window and no timer outlives the turn.
    this.reasoningByTurn.get(turnId)?.dispose();
    this.reasoningByTurn.delete(turnId);
    this.reasoningRedactorByTurn.delete(turnId);
    this.workspaceWatchByTurn.get(turnId)?.stop();
    this.workspaceWatchByTurn.delete(turnId);
    this.baselinesByTurn.delete(turnId);
    // A turn that ends mid-write leaves its redaction state behind otherwise (issue #39).
    for (const key of this.fileEditByKey.keys())
      if (key.startsWith(`${turnId}\u0000`)) this.fileEditByKey.delete(key);
    // Back to idle on a clean finish. A failure already pushed its own `failed` status with the
    // reason attached (see handleRuntimeFailure), and must not be overwritten by an idle here.
    if (kind !== undefined && state === 'completed')
      this.pushRuntimeStatus({
        kind,
        state: 'idle',
        taskId,
        errorCode: null,
        userMessage: null,
      });
    // Before the Turn is finalised, so `image.generated` lands in the event stream ahead of
    // `turn.completed` and the timeline shows the image inside the Turn that produced it.
    this.ingestGeneratedImages(taskId, turnId);
    this.teamMcpBridge.unregister(turnId);
    const event = this.persistence.completeTurn(taskId, turnId, state);
    const resolvedModel = this.resolvedModelByTurn.get(turnId);
    this.resolvedModelByTurn.delete(turnId);
    this.publish(
      event.type === 'turn.completed' && resolvedModel !== undefined
        ? { ...event, resolvedModel }
        : event,
    );
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
    this.pushRuntimeStatus({
      kind: started.runtimeKind,
      state: 'running',
      taskId: started.event.taskId,
      errorCode: null,
      userMessage: null,
    });
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
    // Watch the Workspace for the duration of the Turn (issue #39). Above the mock early-return on
    // purpose: this is about what the Turn writes, not about which Runtime writes it.
    //
    // This is the coverage net, not the fast path — measured, a watcher notification lands ~270ms
    // after the CLI's own report of the same write. What it catches is the writes no Runtime reports
    // at all: a file a shell command rewrote, a formatter that ran on save. The reported ones are
    // read back in recordFileChanges, which is quicker.
    //
    // Only started when the Turn can actually write: at read-only there is nothing to watch for, and
    // a recursive watch on a large repository is not free.
    const turnWorkspace = this.persistence.getWorkspace(taskId);
    if (
      turnWorkspace !== null &&
      resolveWriteScope(this.persistence.getPermissionPolicy(taskId).preset, turnWorkspace) !==
        'read-only'
    ) {
      this.startWorkspaceWatch(taskId, started.turnId, turnWorkspace);
      // Baselines are per Turn: "the file as this Turn found it" is only meaningful inside one
      // (issue #41). Created here so `git status` is read once, at the moment the Turn starts,
      // rather than after the Runtime has already begun changing things.
      this.baselinesByTurn.set(started.turnId, createEditBaselines(turnWorkspace));
    }
    if (kind === 'mock') {
      this.mockRuntime.start(taskId, started.turnId, started.text);
      return;
    }
    const workspacePath = turnWorkspace;
    const workspaceId =
      workspacePath === null ? null : digestCanonical({ workspacePath: workspacePath });
    const context = this.prepareContext(taskId, started.turnId);
    // What this Turn may write (issue #37). Both inputs matter: the Access preset is the user's
    // choice, and the Workspace is what makes a write meaningful at all — without one the Runtime's
    // cwd is a throwaway temp directory, so an edit would land somewhere the user can never see.
    const writeScope = resolveWriteScope(
      this.persistence.getPermissionPolicy(taskId).preset,
      workspacePath,
    );
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
          // Reasoning effort: read live (not captured on StartedTurn) since it isn't persisted
          // per-turn, unlike model — see persistence.ts's getEffort doc comment. The Codex value
          // needs no probe here because setModel/setCodexEffort keep the stored level clamped to
          // the selected model's advertised set; '' means "no override".
          kind === 'claude'
            ? this.persistence.getEffort()
            : this.persistence.getCodexEffort() || undefined,
          writeScope,
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
        else if (runtimeEvent.type === 'reasoning')
          this.pushReasoning(taskId, turnId, runtimeEvent.text);
        else if (runtimeEvent.type === 'delta')
          this.publish(
            this.persistence.appendDelta(
              taskId,
              turnId,
              runtimeEvent.messageId,
              runtimeEvent.delta,
            ),
          );
        else if (runtimeEvent.type === 'thread')
          this.codexThreadByTurn.set(turnId, runtimeEvent.threadId);
        else if (runtimeEvent.type === 'fileChange')
          this.recordFileChanges(taskId, turnId, runtimeEvent.changes);
        else if (runtimeEvent.type === 'fileEdit')
          this.pushFileEdit(taskId, turnId, runtimeEvent.path, runtimeEvent.text, {
            complete: runtimeEvent.complete,
            source: 'stream',
          });
        else {
          if (runtimeEvent.resolvedModel !== undefined)
            this.resolvedModelByTurn.set(turnId, runtimeEvent.resolvedModel);
          this.finishAndAdvance(taskId, turnId, 'completed');
        }
      })
      .catch(() => this.handleRuntimeFailure(kind, taskId, turnId, runtimeProtocolError()));
  }

  /**
   * Follows the Workspace for the life of a Turn, pushing each changed file's contents (issue #39).
   *
   * Deliberately not filtered against what the Runtime reported: the point is to catch the writes it
   * does not report. The path is still checked against the Workspace root by `pushFileEdit`, and the
   * read itself refuses symlinks and binaries (see workspace-file.ts), so "anything that changed" is
   * a safe net to cast here.
   */
  private startWorkspaceWatch(taskId: string, turnId: string, workspacePath: string): void {
    this.workspaceWatchByTurn.get(turnId)?.stop();
    const watcher = watchWorkspace(workspacePath, (relativePath) => {
      // Turn already finished: a late filesystem event must not reopen a closed Turn's view.
      if (!this.workspaceWatchByTurn.has(turnId)) return;
      const body = readWorkspaceTextFile(workspacePath, relativePath);
      if (body === null) return;
      this.pushFileEdit(taskId, turnId, resolvePath(workspacePath, relativePath), body, {
        // Never "complete": on disk there is no such thing as finished, only current. The Turn
        // ending is what stops the view following.
        complete: false,
        source: 'disk',
      });
    });
    if (watcher !== null) this.workspaceWatchByTurn.set(turnId, watcher);
  }

  /**
   * Pushes the body of a file a Runtime is writing, redacted and path-checked (issue #39).
   *
   * Redaction happens here, in Main, before the text leaves the process — the same rule reasoning
   * follows, and it matters more here: a model writing a config file can put a real key in the
   * body. The redactor is per (turn, path) and streaming, because a secret can straddle two frames
   * and redacting each frame in isolation would let a split token through. Frames carry the whole
   * body so far, so the redactor is fed only the newly appended tail.
   *
   * Non-persisted push channel, exactly like reasoning: this is high-frequency and the durable
   * record is `files.changed` plus the file itself.
   */
  private pushFileEdit(
    taskId: string,
    turnId: string,
    absolutePath: string,
    text: string,
    options: { complete: boolean; source: 'stream' | 'disk' },
  ): void {
    const workspacePath = this.persistence.getWorkspace(taskId);
    if (workspacePath === null) return;
    const path = relativizeWorkspacePath(workspacePath, absolutePath, resolvePath, relativePath);
    if (path === null) return;
    const key = `${turnId}\u0000${path}`;
    let state = this.fileEditByKey.get(key);
    if (state === undefined) {
      if (this.fileEditByKey.size >= 16) return;
      state = { redactor: createStreamingSecretRedactor(), safe: '', consumed: 0 };
      this.fileEditByKey.set(key, state);
      // First time this Turn has mentioned this path — the last moment the file might still hold
      // its "before" content (issue #41). For a streamed write that is genuinely before the write;
      // for a watcher event it is already too late, which `note` handles by falling back to git.
      this.baselinesByTurn.get(turnId)?.note(path);
    }
    // Frames are cumulative. A shorter body than last time means the Runtime restarted the value,
    // which the redactor cannot un-consume — drop rather than emit a spliced mixture of two bodies.
    if (text.length < state.consumed) return;
    state.safe += state.redactor.write(text.slice(state.consumed));
    state.consumed = text.length;
    if (options.complete) this.fileEditByKey.delete(key);
    const safeText = state.safe.slice(-262_144);
    // The tail is what the user is watching; an early frame of a large file is not worth the IPC.
    // The cap matches the schema's.
    this.sendFileEditFrame(taskId, turnId, path, safeText, options, null);
    // The baseline can require a git call, so it is never waited for: the text goes out now and the
    // frame that carries the diff follows when there is one. Frames are cumulative, so the view
    // simply gains its diff. Only for a settled body — a diff recomputed against a half-written file
    // would show every unfinished line as a change.
    if (!options.complete) return;
    const baselines = this.baselinesByTurn.get(turnId);
    if (baselines === undefined) return;
    void baselines
      .get(path)
      .then((baseline) => {
        // Nothing to compare against, or the file is unchanged: no second frame, no wasted repaint.
        if (baseline === null || baseline === safeText) return;
        this.sendFileEditFrame(taskId, turnId, path, safeText, options, baseline);
      })
      .catch(() => undefined);
  }

  private sendFileEditFrame(
    taskId: string,
    turnId: string,
    path: string,
    text: string,
    options: { complete: boolean; source: 'stream' | 'disk' },
    baseline: string | null,
  ): void {
    if (this.window.isDestroyed()) return;
    this.window.webContents.send(
      IPC_CHANNELS.fileEditEvent,
      fileEditFrameSchema.parse({
        taskId,
        turnId,
        path,
        text,
        complete: options.complete,
        source: options.source,
        baseline: baseline === null ? null : baseline.slice(-262_144),
      }),
    );
  }

  /**
   * Records the files a Runtime changed, after checking each path is inside the Workspace.
   *
   * The check is the reason this lives in Main rather than in the adapter: only Main knows the
   * Workspace root, and only Main can decide that a path outside it is not shown. A Runtime that
   * reports `/Users/x/.ssh/id_rsa` — because it was prompt-injected, or simply because the model
   * hallucinated the path into a tool call — must not get that string rendered in a timeline the
   * user reads as a record of what happened. Out-of-root paths are dropped silently; the Turn's own
   * output still stands, and there is nothing truthful to say about an edit that either did not
   * happen or happened somewhere the app never authorised.
   */
  private recordFileChanges(
    taskId: string,
    turnId: string,
    changes: readonly { path: string; kind: 'add' | 'update' | 'delete' }[],
  ): void {
    const workspacePath = this.persistence.getWorkspace(taskId);
    if (workspacePath === null) return;
    const inside: FileChange[] = [];
    for (const change of changes) {
      const path = relativizeWorkspacePath(workspacePath, change.path, resolvePath, relativePath);
      if (path !== null) inside.push({ path, kind: change.kind });
    }
    if (inside.length === 0) return;
    const event = this.persistence.recordFileChanges({ taskId, turnId, changes: inside });
    if (event !== null) this.publish(event);
    // Codex reports no body at all while it writes (verified on 0.144.4: `file_change` carries only
    // path and kind, and apply_patch writes to a temp file and renames, so there is nothing to tail
    // either). Reading the result back is the only way to show its content — clearly marked
    // `source: 'disk'` so the UI does not present it as live typing. Claude streams instead, and its
    // frames have already arrived by now, so re-reading would only overwrite the live body with the
    // same bytes.
    for (const change of inside) {
      if (change.kind === 'delete') continue;
      if (this.fileEditByKey.has(`${turnId}\u0000${change.path}`)) continue;
      const body = readWorkspaceTextFile(workspacePath, change.path);
      if (body !== null)
        this.pushFileEdit(taskId, turnId, resolvePath(workspacePath, change.path), body, {
          complete: true,
          source: 'disk',
        });
    }
  }

  /**
   * Redacts, batches, and pushes reasoning text for a turn.
   *
   * Redaction happens here, in Main, before the text ever leaves the process — the renderer must
   * never be the place a key is first seen, and this text is provider output that can echo whatever
   * the model read.
   */
  private pushReasoning(taskId: string, turnId: string, text: string): void {
    let redactor = this.reasoningRedactorByTurn.get(turnId);
    if (redactor === undefined) {
      redactor = createStreamingSecretRedactor();
      this.reasoningRedactorByTurn.set(turnId, redactor);
    }
    const safe = redactor.write(text);
    let batcher = this.reasoningByTurn.get(turnId);
    if (batcher === undefined) {
      batcher = new ReasoningBatcher(({ text: batch, truncated }) => {
        if (this.window.isDestroyed()) return;
        this.window.webContents.send(
          IPC_CHANNELS.reasoningEvent,
          reasoningBatchSchema.parse({ taskId, turnId, text: batch, truncated }),
        );
      });
      this.reasoningByTurn.set(turnId, batcher);
    }
    if (safe !== '') batcher.push(safe);
  }

  /**
   * Moves any images Codex generated for this turn into the app's own storage.
   *
   * Best-effort: a failure here must never keep a Turn from finalising, since the conversation is
   * more important than the artifact. Runs for failed turns too — Codex generates the image before
   * the shell copy that the read-only sandbox refuses, so a Turn whose final message says it could
   * not save the file has still produced one.
   */
  private ingestGeneratedImages(taskId: string, turnId: string): void {
    const threadId = this.codexThreadByTurn.get(turnId);
    this.codexThreadByTurn.delete(turnId);
    if (threadId === undefined) return;
    try {
      for (const { bytes } of collectThreadImages(threadId)) {
        const recorded = this.persistence.recordGeneratedImage({ taskId, turnId, bytes });
        if (recorded !== null) this.publish(recorded.event);
      }
    } catch {
      // Nothing to surface: the image is an extra, and the Turn's own result already stands.
    }
  }

  private handleRuntimeFailure(
    kind: 'codex' | 'claude',
    taskId: string,
    turnId: string,
    error: PublicError,
  ): void {
    void this.mailbox.run(taskId, () => {
      if (this.turnRuntimes.get(turnId) !== kind) return;
      // The reason used to be dropped here, so the renderer saw a Turn end in `failed` with no way
      // to tell "the model refused" from "the CLI is gone" (issue #9). Pushed on the transient
      // status channel rather than folded into the persisted Turn event.
      this.pushRuntimeStatus({
        kind,
        state: 'failed',
        taskId,
        errorCode: error.code,
        userMessage: error.userMessage,
      });
      this.finishAndAdvance(taskId, turnId, 'failed');
    });
  }

  /**
   * Sends Runtime liveness to the renderer. Best-effort and non-persisted: a dropped status only
   * costs a stale footer line until the next transition, whereas persisting it would replay a
   * long-dead failure every time the Task is reopened.
   */
  private pushRuntimeStatus(status: {
    kind: RuntimeKind;
    state: 'idle' | 'running' | 'failed';
    taskId: string | null;
    errorCode: string | null;
    userMessage: string | null;
  }): void {
    if (this.window.isDestroyed()) return;
    this.window.webContents.send(
      IPC_CHANNELS.runtimeStatusEvent,
      runtimeStatusSchema.parse(status),
    );
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
/**
 * Narrows a stored Codex reasoning level to something the given model actually advertises.
 *
 * Returns '' ("no override, use the CLI's own default") whenever there is nothing trustworthy to
 * send: the `auto` sentinel, a model that publishes no level set, or a cache we could not read.
 * Otherwise an unsupported stored value falls back to the model's advertised default rather than
 * being dropped, so raising effort on Sol and switching to GPT-5.5 keeps a deliberate level
 * instead of silently reverting to whatever the CLI defaults to.
 */
export function clampCodexEffort(
  stored: string,
  models: readonly CodexModelOption[],
  selectedModelId: string,
): string {
  if (stored === '' || selectedModelId === 'auto') return '';
  const efforts = models.find(({ id }) => id === selectedModelId)?.efforts;
  if (efforts === undefined || efforts.length === 0) return '';
  if (efforts.some(({ id }) => id === stored)) return stored;
  return models.find(({ id }) => id === selectedModelId)?.defaultEffort ?? '';
}

class InvalidModelError extends Error {
  constructor(readonly kind: 'codex' | 'claude' = 'codex') {
    super();
  }
}
/**
 * A Codex reasoning level the selected model does not advertise.
 *
 * Rejected up front rather than passed through, because the CLI does not degrade gracefully: an
 * unsupported level makes the API answer 400 and `codex exec` exit 1, i.e. the whole turn dies.
 * Better to refuse the setting while the user is in the picker than to let them discover it when
 * their next message fails.
 */
class InvalidEffortError extends Error {
  constructor(readonly modelDisplayName: string) {
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
  if (error instanceof InvalidEffortError)
    return {
      code: 'INVALID_REQUEST',
      userMessage: `選択したEffortは${error.modelDisplayName}では利用できません。`,
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

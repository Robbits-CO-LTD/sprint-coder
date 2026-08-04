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
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  basename,
  isAbsolute,
  join,
  relative as relativePath,
  resolve as resolvePath,
  sep,
} from 'node:path';
import { workspaceMutationBinding } from './path-guard';
import { z } from 'zod';
import {
  IPC_CHANNELS,
  anthropicConnectionCreateInputSchema,
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
  geminiConnectionCreateInputSchema,
  type FileChange,
  permissionSetInputSchema,
  permissionSettingsSchema,
  modelCatalogQueryInputSchema,
  modelCatalogQueryResultSchema,
  modelCatalogSelectionSetInputSchema,
  modelSelectionSchema,
  type ModelSelection,
  type NormalizedProviderUsage,
  type NormalizedProviderError,
  openAIConnectionCreateInputSchema,
  openRouterConnectionCreateInputSchema,
  providerConnectionSchema,
  providerConnectionRateLimitLowerInputSchema,
  providerProfileConnectionCreateInputSchema,
  providerProfileSchema,
  projectAssignTaskInputSchema,
  projectContextManifestGetInputSchema,
  projectContextManifestSchema,
  projectContextManifestsListInputSchema,
  projectContextManifestSummarySchema,
  projectCreateInputSchema,
  projectFolderPickerResultSchema,
  projectFolderSchema,
  projectFoldersListInputSchema,
  projectFoldersReplaceInputSchema,
  projectGetInputSchema,
  projectInstructionResultSchema,
  projectInstructionSetInputSchema,
  projectMemoriesListInputSchema,
  projectMemoryCreateInputSchema,
  projectMemorySchema,
  projectMemoryUpdateInputSchema,
  projectReferenceAddInputSchema,
  projectReferencePickInputSchema,
  projectReferenceRemoveInputSchema,
  projectReferenceSchema,
  projectReferencesListInputSchema,
  projectReferenceUpdateInputSchema,
  projectSummarySchema,
  projectUnassignTaskInputSchema,
  projectUpdateInputSchema,
  connectionIdSchema,
  createdSkillMutationInputSchema,
  createdSkillEnabledInputSchema,
  runtimeSetInputSchema,
  runtimeSettingsGetInputSchema,
  runtimeModelSetInputSchema,
  runtimeEffortSetInputSchema,
  runtimeCodexEffortSetInputSchema,
  runtimeSettingsSchema,
  teamModelResearchSettingsSchema,
  teamModelResearchSettingsSetInputSchema,
  teamModelRestrictionSetInputSchema,
  teamModelSettingsSchema,
  teamBlueprintSchema,
  skillCandidateInputSchema,
  skillCatalogSchema,
  skillCatalogItemSchema,
  skillDraftSchema,
  skillDraftCreateInputSchema,
  skillDraftInstallInputSchema,
  skillDraftIdInputSchema,
  skillEnabledInputSchema,
  skillImportInputSchema,
  skillImportResultSchema,
  skillInstalledInputSchema,
  skillPreviewResultSchema,
  skillScanResultSchema,
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
  taskSkillSelectionInputSchema,
  teamDetailSchema,
  teamEventSchema,
  teamHireWorkerInputSchema,
  teamMissionSummarySchema,
  teamResumeMissionInputSchema,
  teamResumeExecutionIntegrationInputSchema,
  teamMessageSummarySchema,
  teamPolicyUpdateInputSchema,
  teamPolicySchema,
  teamSendMessageInputSchema,
  teamSummarySchema,
  teamWorkerRefSchema,
  workerSummarySchema,
  turnCancelInputSchema,
  turnEventSchema,
  xAIConnectionCreateInputSchema,
  turnQueueInputSchema,
  turnQueueResultSchema,
  turnSnapshotSchema,
  turnStartInputSchema,
  turnStartResultSchema,
  turnSkillSelectionsSchema,
  turnSteerInputSchema,
  turnStopAndSendInputSchema,
  turnSubscriptionInputSchema,
  workspaceSelectionSchema,
  effectiveWorkspaceSetSchema,
  type EffectiveWorkspaceSet,
  type CommandEnvelope,
  type CommandResult,
  type AccessPreset,
  type CanonicalProviderEvent,
  type CodexModelOption,
  type ProviderExecutionRequest,
  type ProviderConnection,
  type ProviderMessageToolCall,
  type ProviderModel,
  type PublicError,
  type ProjectFolderInput,
  type ProjectFolder,
  type ProjectReference,
  type RuntimeKind,
  type TurnEvent,
} from '@sprint-coder/contracts';
import type { PreparedContext } from './context-ledger';
import { digestCanonical } from './context-compiler';
import { createEmptyToolCatalogSnapshot } from './default-tools';
import type {
  PersistedTurnSkill,
  PersistenceClient,
  QueueTransition,
  StartedTurn,
  StopAndSendTransition,
  ProjectFolderBinding,
} from './persistence';
import { toApprovalAuditSummary, toApprovalSummary } from './persistence';
import {
  CanvasViewConflictError,
  InvalidCanvasViewError,
  NotFoundError,
  OperationConflictError,
  OperationInProgressError,
  InvalidProjectError,
  ProjectArchivedError,
  ProjectConflictError,
  ProjectFolderMutationBlockedError,
  ReferenceInUseError,
  SteerStaleError,
  TaskAssignmentBlockedError,
  TurnActiveError,
} from './persistence';
import { MockRuntimeAdapter } from './runtime';
import { RuntimeHostClient, toRuntimeContextFragment } from './runtime-host';
import { PermissionBroker } from './permission-broker';
import { ApprovalCoordinator, approvalFactsForTool } from './approval-coordinator';
import { relativizeWorkspacePath, resolveWriteScope } from './write-scope';
import { readWorkspaceTextFile } from './workspace-file';
import { watchWorkspace, type WorkspaceWatcher } from './workspace-watcher';
import {
  openWorkspaceFileForEdit,
  recoverWorkspaceFileForEdit,
  saveWorkspaceFile,
} from './workspace-edit';
import {
  SkillSettingsError,
  SkillSettingsService,
  skillSettingsPublicError,
} from './skill-settings-service';

/** sha256 of nothing, used when a refusal has no file to hash. */
const EMPTY_FILE_DIGEST = createHash('sha256').update('').digest('hex');
const MAX_PROVIDER_LEADER_ROUNDS = 32;
import { createEditBaselines, type EditBaselines } from './edit-baseline';
import {
  ToolAuthorizationDeniedError,
  type ToolAuthorizationRequest,
} from './tool-broker';
import type { RuntimeCanonicalEvent, RuntimeWorkspaceSet } from '../runtime-host/protocol';
import { serializeCliExecutionPayload } from '../runtime-host/execution-payload';
import {
  permissionRequestFingerprint,
  toolValueMatchesSchema,
  type Capability,
  type ToolCatalogSnapshot,
} from '@sprint-coder/domain';
import { AutoReviewer, autoReviewerInputDigest } from './auto-reviewer';
import { MutationLeaseBusyError, MutationQuarantinedError } from './mutation-lease';
import {
  authorizeClaudeProviderEgress,
  authorizeCodexProviderEgress,
  authorizeOfficialApiProviderEgress,
  dispatchAfterCodexProviderEgress,
  dispatchAfterClaudeProviderEgress,
} from './provider-egress';
import { ReasoningBatcher } from './reasoning-batcher';
import { projectContextProviderMessages } from './project-context-delivery';
import { RetryableActionRegistry } from './retryable-action';
import { createStreamingSecretRedactor, redactSecrets } from './secret-redactor';
import { secureLogger } from './secure-logger';
import { collectThreadImages } from './generated-image-collector';
import { TeamCoordinator } from './team-coordinator';
import { WorkerWorktreeManager } from './worker-worktree';
import {
  RuntimeHostTeamWorkerRuntime,
  buildInheritedWorkerContext,
  chooseWorkerRuntime,
} from './team-worker-runtime';
import {
  isTeamScenarioInput,
  LEADER_MCP_SYSTEM_PROMPT,
  LEADER_PROVIDER_TOOLS,
  MANAGER_PROVIDER_TOOLS,
  MANAGER_MCP_SYSTEM_PROMPT,
  WORKER_MCP_SYSTEM_PROMPT,
  WORKER_PROVIDER_TOOLS,
  executeTeamTool,
  type ExecuteTeamToolOptions,
} from './team-tools';
import {
  BUILTIN_TEAM_SKILL_AUDIT,
  BUILTIN_TEAM_SKILL_CONTENT,
  BUILTIN_TEAM_SKILL_DIGEST,
  BUILTIN_TEAM_SKILL_FRAGMENT_ID,
  BUILTIN_TEAM_SKILL_ID,
  verifyBuiltinTeamSkillAcceptance,
  type TeamSkillResolutionAudit,
} from './team-skill';
import {
  BUILTIN_SKILL_CREATOR_CONTENT,
  BUILTIN_SKILL_CREATOR_DIGEST,
  BUILTIN_SKILL_CREATOR_ID,
} from './skill-creator-builtin';
import { SkillStore } from './skill-store';
import { TeamMcpBridge, defaultSocketPathFactory } from './team-mcp-bridge';
import {
  PROJECT_MEMORY_MCP_GUIDANCE,
  PROJECT_MEMORY_PROVIDER_TOOL,
  appendProjectMemoryCandidate,
  parseProjectMemoryCandidate,
} from './project-memory-guidance';
import type { RuntimeTeamMcpOption } from '../runtime-host/protocol';
import { ModelCatalogService, teamModelIdentityKey } from './model-catalog-service';
import {
  PROVIDER_NO_TOOL_GUIDANCE,
  PROVIDER_WORKSPACE_GUIDANCE,
  ProviderWorkspaceTools,
  WorkspaceToolRejection,
  providerToolsFromSnapshot,
  workspaceToolAuthorizationGuard,
} from './provider-workspace-tools';
import type { WorkspacePatchDeps } from './workspace-patch-tool';
import {
  BUILTIN_CODEX_CONNECTION_ID,
  builtinRuntimeForModelSelection,
  modelSelectionForRuntime,
} from './connection-identity';
import {
  multiProviderModelPickerV2Enabled,
  projectMultiFolderUxEnabled,
  settingsWorkspaceV2Enabled,
} from './feature-flags';
import {
  ProviderSecretStorage,
  ProviderSecretStorageUnavailableError,
} from './provider-secret-storage';
import { ElectronProviderSecretCipher } from './electron-provider-secret-cipher';
import { MainProviderRegistry } from './provider-runtime';
import { ProviderVerificationService } from './provider-verification';
import { OpenAIProviderClient, parseOpenAICredential } from './openai-provider-client';
import { OpenRouterCatalogClient } from './openrouter-provider-client';
import { AnthropicProviderClient, parseAnthropicCredential } from './anthropic-provider-client';
import { GeminiProviderClient, parseGeminiCredential } from './gemini-provider-client';
import { XAIProviderClient, parseXAICredential } from './xai-provider-client';
import { ProviderConnectionService } from './provider-connection-service';
import { ProviderAwareTeamWorkerRuntime } from './provider-team-worker-runtime';
import {
  MainProviderProfileRegistry,
  parseOpenAICompatibleCredential,
  resolvedProfileEndpointTrust,
  type OpenAICompatibleCredential,
} from './provider-profile';
import { BUNDLED_PROVIDER_PROFILES } from './bundled-provider-profiles';
import { OpenAICompatibleProviderClient } from './openai-compatible-provider-client';
import {
  MODEL_TASK_TITLE_TIMEOUT_MS,
  TASK_TITLE_PROMPT,
  createTaskTitleContext,
  sanitizeGeneratedTaskTitle,
} from './model-task-title';
import { TaskTitleAbortRegistry, TaskTitleRuntimePool } from './task-title-runtime-pool';

const MODEL_RESEARCH_GUIDANCE = `
このTeamでは「Worker採用前にモデルをWeb調査」が有効です。各Workerを雇う前に必ず次の順序を守ってください。
1. team_list_modelsで候補を絞る。
2. 候補モデルごとに、公式Provider文書または信頼できる一次情報をlive Web検索し、今回の作業への適性、制約、価格または速度に関する確認可能な事実を調べる。
3. 採用する正確なconnection ID、provider ID、model IDについてteam_record_model_researchを呼び、調査要約と実際に参照したURLを記録する。
4. その後にだけteam_hire_workerを呼び、modelSelectionReasonへWeb調査の根拠を明示する。
Web検索できない、または信頼できる根拠が見つからない場合は、そのモデルを推測で採用しないでください。`;

function teamGuidance(base: string, requireModelResearch: boolean): string {
  return requireModelResearch ? `${base}\n${MODEL_RESEARCH_GUIDANCE}` : base;
}

type InvokeEvent = IpcMainInvokeEvent;
type PortBinding = { taskId: string; port: MessagePortMain };
type ActiveRuntimeKind = RuntimeKind | 'provider';
type TaskTitleRequest = Pick<StartedTurn, 'text' | 'runtimeKind' | 'model' | 'modelSelection'> & {
  taskId: string;
};
type CliTaskTitleJob = {
  taskId: string;
  kind: 'codex' | 'claude';
  output: string;
  timer: NodeJS.Timeout;
  resolve: (title: string | null) => void;
};

export class IpcRouter {
  private readonly ports = new Set<PortBinding>();
  private readonly mailbox = new TaskMailbox();
  private readonly mockRuntime: MockRuntimeAdapter;
  private readonly codexRuntime: RuntimeHostClient;
  private readonly teamWorkerRuntime: ProviderAwareTeamWorkerRuntime;
  private readonly claudeRuntime: RuntimeHostClient;
  private readonly taskTitleRuntimes: TaskTitleRuntimePool<RuntimeHostClient>;
  private readonly taskTitleProviderAborts = new TaskTitleAbortRegistry();
  private disposed = false;
  private readonly turnRuntimes = new Map<string, ActiveRuntimeKind>();
  /** First-Turn requests awaiting successful completion before title generation begins. */
  private readonly pendingTaskTitles = new Map<string, TaskTitleRequest>();
  /** Synthetic CLI executions use isolated Runtime Hosts and never enter Turn persistence. */
  private readonly cliTaskTitleJobs = new Map<string, CliTaskTitleJob>();
  private readonly runtimeCancelActions = new RetryableActionRegistry();
  private readonly pendingStopAndSendByOperation = new Map<
    string,
    {
      taskId: string;
      canceledTurnId: string | null;
      transition: StopAndSendTransition;
      logicalEndNotified: boolean;
    }
  >();
  // The concrete model id the Claude CLI actually resolved for a turn (captured from the
  // stream-json `system/init` event by ClaudeJsonlNormalizer), keyed by turnId until
  // finishAndAdvance persists it as execution resolution and folds it into the outgoing
  // `turn.completed` event.
  private readonly resolvedModelByTurn = new Map<string, string>();
  private readonly resolvedProviderByTurn = new Map<string, string>();
  private readonly providerAbortByTurn = new Map<string, AbortController>();
  // One reasoning batcher per active turn (issue #17). Keyed by turnId and disposed in
  // finishAndAdvance, so a turn cannot leave a timer behind.
  private readonly reasoningByTurn = new Map<string, ReasoningBatcher>();
  // Streaming redaction state per (turn, path) for live file bodies (issue #39). Bounded at 16
  // concurrent files and cleared when a body completes or its turn ends.
  // One recursive watch per sealed root for each writing Turn, stopped in finishAndAdvance.
  private readonly workspaceWatchByTurn = new Map<string, readonly WorkspaceWatcher[]>();
  // The immutable Workspace snapshot and per-root baselines owned by each Turn.
  private readonly turnWorkspaceByTurn = new Map<string, EffectiveWorkspaceSet>();
  private readonly baselinesByTurn = new Map<string, ReadonlyMap<string, EditBaselines>>();
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
  private readonly providerWorkspaceTools: ProviderWorkspaceTools;
  private readonly autoReviewer = AutoReviewer.createProduction();
  private readonly teamCoordinator: TeamCoordinator;
  private readonly teamSubscriptions = new Set<string>();
  private readonly teamEventSeqByTask = new Map<string, number>();
  private readonly teamMcpBridge: TeamMcpBridge;
  private readonly skillSettings: SkillSettingsService;
  private readonly modelCatalog = new ModelCatalogService();
  private readonly providerRegistry = new MainProviderRegistry();
  private readonly providerProfiles = new MainProviderProfileRegistry();
  private readonly providerEgressTrustForConnection: (
    connection: ProviderConnection,
  ) => 'trusted-local' | 'trusted-remote';
  private readonly providerVerification: ProviderVerificationService;
  private readonly providerConnections: ProviderConnectionService;
  private teamSkillReady = false;
  private readonly teamSkillExpectedTurns = new Set<string>();
  private readonly teamSkillResolutionByTurn = new Map<string, TeamSkillResolutionAudit>();
  private readonly teamRequiredTurns = new Set<string>();
  private readonly pendingProjectMemoriesByTurn = new Map<
    string,
    { projectId: string; content: string }[]
  >();

  constructor(
    private readonly window: BrowserWindow,
    private readonly persistence: PersistenceClient,
    private readonly trustedRendererOrigin: string,
    workspaceEdit?: WorkspacePatchDeps,
  ) {
    const providerSecrets = new ProviderSecretStorage(
      join(app.getPath('userData'), 'provider-secrets'),
      new ElectronProviderSecretCipher(),
    );
    for (const profile of BUNDLED_PROVIDER_PROFILES) this.providerProfiles.register(profile);
    const resolveCompatibleCredential = (
      connection: ProviderConnection,
    ): OpenAICompatibleCredential => {
      if (connection.secretReference === null)
        throw new Error('Provider Profile Connection has no secret reference');
      return parseOpenAICompatibleCredential(providerSecrets.get(connection.secretReference));
    };
    this.providerEgressTrustForConnection = (connection) => {
      if (connection.runtimeKind !== 'openai_compatible') return 'trusted-remote';
      return resolvedProfileEndpointTrust(
        this.providerProfiles.get(connection.providerId),
        resolveCompatibleCredential(connection),
      );
    };
    const compatible = new OpenAICompatibleProviderClient(
      this.providerProfiles,
      resolveCompatibleCredential,
    );
    this.providerRegistry.register({
      runtimeKind: 'openai_compatible',
      providerId: null,
      runtime: compatible,
    });
    const openAI = new OpenAIProviderClient((connection) => {
      if (connection.secretReference === null)
        throw new Error('OpenAI Connection has no secret reference');
      return parseOpenAICredential(providerSecrets.get(connection.secretReference));
    });
    this.providerRegistry.register({
      runtimeKind: 'official_api',
      providerId: 'openai',
      runtime: openAI,
    });
    const openRouter = new OpenRouterCatalogClient((connection) => {
      if (connection.secretReference === null)
        throw new Error('OpenRouter Connection has no secret reference');
      return parseOpenAICredential(providerSecrets.get(connection.secretReference));
    });
    this.providerRegistry.register({
      runtimeKind: 'official_api',
      providerId: 'openrouter',
      runtime: openRouter,
    });
    const anthropic = new AnthropicProviderClient((connection) => {
      if (connection.secretReference === null)
        throw new Error('Anthropic Connection has no secret reference');
      return parseAnthropicCredential(providerSecrets.get(connection.secretReference));
    });
    this.providerRegistry.register({
      runtimeKind: 'official_api',
      providerId: 'anthropic',
      runtime: anthropic,
    });
    const gemini = new GeminiProviderClient((connection) => {
      if (connection.secretReference === null)
        throw new Error('Gemini Connection has no secret reference');
      return parseGeminiCredential(providerSecrets.get(connection.secretReference));
    });
    this.providerRegistry.register({
      runtimeKind: 'official_api',
      providerId: 'google',
      runtime: gemini,
    });
    const xai = new XAIProviderClient((connection) => {
      if (connection.secretReference === null)
        throw new Error('xAI Connection has no secret reference');
      return parseXAICredential(providerSecrets.get(connection.secretReference));
    });
    this.providerRegistry.register({
      runtimeKind: 'official_api',
      providerId: 'xai',
      runtime: xai,
    });
    this.providerVerification = new ProviderVerificationService(
      this.persistence,
      this.providerRegistry,
    );
    this.providerConnections = new ProviderConnectionService(
      this.persistence,
      providerSecrets,
      undefined,
      undefined,
      this.providerProfiles,
    );
    this.skillSettings = new SkillSettingsService({
      homePath: process.env['SPRINT_CODER_SKILL_HOME'] ?? app.getPath('home'),
    });
    const cliTeamWorkerRuntime = new RuntimeHostTeamWorkerRuntime({
      // Real worker execution is opt-in when the selected chat runtime is mock. Runtime probe or
      // policy failures remain explicit and are never replaced with simulated Team output.
      selectRuntime: (worker) => {
        const selected = builtinRuntimeForModelSelection(worker.modelSelection);
        const choice =
          selected === null
            ? chooseWorkerRuntime(
                this.persistence.getRuntime(),
                this.persistence.getModel(),
                process.env['SPRINT_CODER_REAL_WORKERS'] === '1',
              )
            : { kind: selected.runtimeKind, model: selected.model };
        return process.env['SPRINT_CODER_TEAM_CODEX_ONLY'] === '1' && choice?.kind !== 'codex'
          ? null
          : choice;
      },
      workspaceFor: (taskId) => this.persistence.getWorkspace(taskId),
      catalogFor: (kind, workspacePath) =>
        createEmptyToolCatalogSnapshot(
          kind,
          workspacePath === null ? null : digestCanonical({ workspacePath }),
        ),
      authorizeEgress: (kind, taskId, turnId, prompt, context) => {
        const authorize =
          kind === 'claude' ? authorizeClaudeProviderEgress : authorizeCodexProviderEgress;
        return authorize({
          broker: this.permissionBroker,
          task: this.persistence.getTask(taskId),
          turnId,
          prompt,
          context,
          now: new Date().toISOString(),
        }).allowed;
      },
      contextFor: (worker, executionId) =>
        executionId === undefined
          ? buildInheritedWorkerContext(worker, this.persistence.listMessages(worker.taskId))
          : this.persistence.prepareTeamExecutionContext(worker.taskId, executionId),
      writeScopeFor: (worker, workspacePath) =>
        worker.writeCapable
          ? resolveWriteScope(
              this.persistence.getPermissionPolicy(worker.taskId).preset,
              workspacePath,
            )
          : 'read-only',
      teamMcpFor: (worker, turnId, executionId) =>
        worker.canDelegate
          ? this.registerManagerMcp(turnId, worker.taskId, worker.id, executionId)
          : this.registerWorkerMcp(turnId, worker.taskId, worker.id, executionId),
      releaseTeamMcp: (turnId) => this.teamMcpBridge.unregister(turnId),
      allowSimulation: process.env['SPRINT_CODER_ALLOW_SIMULATED_TEAM_WORKERS'] === '1',
    });
    this.teamWorkerRuntime = new ProviderAwareTeamWorkerRuntime({
      fallback: cliTeamWorkerRuntime,
      verification: this.providerVerification,
      registry: this.providerRegistry,
      getConnection: (connectionId) => this.persistence.getProviderConnection(connectionId),
      authorizeEgress: ({ worker, executionId, connection, prompt, context }) =>
        authorizeOfficialApiProviderEgress(
          {
            broker: this.permissionBroker,
            task: this.persistence.getTask(worker.taskId),
            turnId: executionId,
            prompt,
            context,
            now: new Date().toISOString(),
          },
          connection.providerId,
          this.providerEgressTrustForConnection(connection),
        ).allowed,
      contextFor: (worker, executionId) =>
        executionId === undefined
          ? buildInheritedWorkerContext(worker, this.persistence.listMessages(worker.taskId))
          : this.persistence.prepareTeamExecutionContext(worker.taskId, executionId),
      managerGuidance: MANAGER_MCP_SYSTEM_PROMPT,
      managerTools: MANAGER_PROVIDER_TOOLS,
      workerGuidance: WORKER_MCP_SYSTEM_PROMPT,
      workerTools: WORKER_PROVIDER_TOOLS,
      executeManagerTool: ({ worker, name, input, reportCursor, modelCatalogAudit, executionId }) =>
        executeTeamTool(this.teamCoordinator, worker.taskId, name, input, {
          requesterAgentId: worker.id,
          accessCeiling:
            executionId === undefined
              ? 'read-only'
              : this.persistence.getTeamExecution(executionId).accessMode,
          ...(executionId === undefined
            ? {}
            : { contextOwner: { type: 'team_execution' as const, id: executionId } }),
          longPoll: name === 'team_wait_reports',
          waitReportsCursor: reportCursor,
          listModelCandidates: (query) => this.listTeamModelCandidates(query),
          modelCatalogAudit,
        }),
    });
    this.teamCoordinator = new TeamCoordinator(
      persistence,
      this.teamWorkerRuntime,
      (taskId, detail) => {
        if (
          this.teamSubscriptions.has(taskId) &&
          !this.window.isDestroyed() &&
          !this.window.webContents.isDestroyed()
        ) {
          const seq = (this.teamEventSeqByTask.get(taskId) ?? 0) + 1;
          this.teamEventSeqByTask.set(taskId, seq);
          this.window.webContents.send(IPC_CHANNELS.teamsEvent, {
            taskId,
            event: teamEventSchema.parse({ type: 'updated', seq, detail }),
          });
        }
      },
      undefined,
      // Long Team work is split into bounded Mission steps. A step may run for up to 30 minutes;
      // heartbeat and progress leases inside TeamCoordinator detect dead/stalled runtimes sooner.
      30 * 60_000,
      undefined,
      (selection, taskId) => this.validateTeamModelSelection(selection, taskId),
      (taskId) => {
        const activeTurnId = this.persistence.getActiveTurnId(taskId);
        if (activeTurnId === null) return null;
        const teamSkill = this.persistence
          .getTurnSkills(taskId, activeTurnId)
          .find(({ selection }) => selection.kind === 'team');
        if (teamSkill === undefined) return null;
        const blueprintPath = join(teamSkill.packagePath, 'team', 'blueprint.json');
        const blueprint = teamBlueprintSchema.parse(
          JSON.parse(readFileSync(blueprintPath, 'utf8')),
        );
        return {
          selection: teamSkill.selection,
          name: teamSkill.name,
          packagePath: teamSkill.packagePath,
          blueprint,
        };
      },
      new WorkerWorktreeManager({
        worktreesRoot: join(app.getPath('userData'), 'team-worker-worktrees'),
      }),
      async (taskId) => {
        const workspace = this.persistence.getEffectiveWorkspaceSet(taskId);
        await verifyTurnWorkspaceIdentities(
          workspace,
          this.persistence.getEffectiveWorkspaceRootIdentities(taskId),
        );
      },
    );
    // Leader MCP (default on; SPRINT_CODER_LEADER_MCP=0 opts out): the socket the real CLI Leader
    // connects back through to reach this same TeamCoordinator. Starting it here (rather than
    // lazily on first team turn) means `initialize()` can await it once at app startup; a failed
    // start degrades to `socketPath === null`, which startSelectedRuntime treats as "fall back to
    // the mock leader path" rather than a hard failure.
    this.teamMcpBridge = new TeamMcpBridge(
      this.teamCoordinator,
      defaultSocketPathFactory(app.getPath('userData')),
      undefined,
      (query) => this.listTeamModelCandidates(query),
      async (input, context) => {
        const draft = await this.skillSettings
          .createDraft(skillDraftCreateInputSchema.parse(input))
          .catch((error) => Promise.reject(skillSettingsPublicError(error)));
        this.publish(this.persistence.recordSkillDraft(context.taskId, context.turnId, draft));
        return draft;
      },
      async (input, context) => this.queueProjectMemoryCandidate(input, context),
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
    this.providerWorkspaceTools = new ProviderWorkspaceTools({
      workspaceFor: (taskId, turnId) =>
        this.persistence.readTurnWorkspaceSetForTask(taskId, turnId),
      rootIdentityFor: (turnId, rootId) =>
        this.persistence.getTurnWorkspaceRootIdentities(turnId).get(rootId),
      policyEpochFor: (taskId) => this.persistence.getPermissionPolicy(taskId).policyEpoch,
      authorizer: this.approvalCoordinator.authorizeTool.bind(this.approvalCoordinator),
      command: {
        persistence: this.persistence,
        publish: (event) => this.publish(event),
      },
      ...(workspaceEdit === undefined ? {} : { workspaceEdit }),
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
      (taskId, turnId, fragmentIds, projectItemIds, snapshotDigest) =>
        this.acknowledgeRuntimeContext(taskId, turnId, fragmentIds, projectItemIds, snapshotDigest),
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
          resolvePath(
            primaryWorkspacePath(this.persistence.getEffectiveWorkspaceSet(taskId)) ?? '/',
            path,
          ),
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
      (taskId, turnId, fragmentIds, projectItemIds, snapshotDigest) =>
        this.acknowledgeRuntimeContext(taskId, turnId, fragmentIds, projectItemIds, snapshotDigest),
      'codex',
    );
    this.claudeRuntime = new RuntimeHostClient(
      (taskId, turnId, runtimeEvent) =>
        this.handleRuntimeEvent('claude', taskId, turnId, runtimeEvent),
      (taskId, turnId, error) => this.handleRuntimeFailure('claude', taskId, turnId, error),
      (taskId, turnId) => this.prepareContext(taskId, turnId),
      (taskId, turnId, fragmentIds, projectItemIds, snapshotDigest) =>
        this.acknowledgeRuntimeContext(taskId, turnId, fragmentIds, projectItemIds, snapshotDigest),
      'claude',
    );
    this.taskTitleRuntimes = new TaskTitleRuntimePool(
      (kind) =>
        new RuntimeHostClient(
          (taskId, turnId, event) => this.routeCliTaskTitleEvent(kind, taskId, turnId, event),
          (taskId, turnId, error) => this.routeCliTaskTitleFailure(kind, taskId, turnId, error),
          undefined,
          undefined,
          kind,
        ),
    );
  }

  register(): void {
    this.handle(IPC_CHANNELS.appGetInfo, emptyPayloadSchema, appInfoSchema, () => ({
      version: app.getVersion(),
      platform: process.platform,
      settingsWorkspaceV2: settingsWorkspaceV2Enabled(),
      projectMultiFolderUx: projectMultiFolderUxEnabled(),
      // Startup recovery outcome (issue #9). Already computed before the window existed — this is
      // just the first path that ever carried it to the renderer.
      recovery: this.persistence.getStartupRecovery(),
    }));
    this.handle(
      IPC_CHANNELS.settingsGetRuntime,
      runtimeSettingsGetInputSchema,
      runtimeSettingsSchema,
      async (input) => {
        const [codexCapability, claudeCapability] = await Promise.all([
          this.codexRuntime.probe(),
          this.claudeRuntime.probe(),
        ]);
        const taskSelection =
          input.taskId === undefined ? null : this.persistence.getTaskModelSelection(input.taskId);
        const taskRuntime =
          taskSelection === null ? null : builtinRuntimeForModelSelection(taskSelection);
        const kind = taskRuntime?.runtimeKind ?? this.persistence.getRuntime();
        const activeCapability = kind === 'claude' ? claudeCapability : codexCapability;
        const storedModel = taskRuntime?.model ?? this.persistence.getModel();
        const model = activeCapability.models.some(({ id }) => id === storedModel)
          ? storedModel
          : 'auto';
        return {
          kind,
          codexAvailable: codexCapability.available,
          codexReadiness: codexCapability.readiness,
          claudeAvailable: claudeCapability.available,
          claudeReadiness: claudeCapability.readiness,
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
    this.handle(
      IPC_CHANNELS.settingsGetTeamModelResearch,
      emptyPayloadSchema,
      teamModelResearchSettingsSchema,
      () => ({
        researchBeforeHiring: this.persistence.getTeamModelResearchBeforeHiring(),
      }),
    );
    this.handleMutation(
      IPC_CHANNELS.settingsSetTeamModelResearch,
      teamModelResearchSettingsSetInputSchema,
      z.undefined(),
      (input, event, envelope) =>
        this.runMutation(event, envelope, '', IPC_CHANNELS.settingsSetTeamModelResearch, () =>
          this.persistence.setTeamModelResearchBeforeHiring(input.researchBeforeHiring),
        ).value,
    );
    this.handle(
      IPC_CHANNELS.settingsGetTeamModelSettings,
      emptyPayloadSchema,
      teamModelSettingsSchema,
      async () => {
        await this.refreshModelCatalog();
        const availableModels: ProviderModel[] = [];
        let cursor: string | null = null;
        do {
          const page = this.modelCatalog.query({
            taskId: 'settings',
            text: '',
            connectionIds: [],
            providerIds: [],
            accessTypes: [],
            capabilities: [],
            availableOnly: true,
            cursor,
            limit: 100,
          });
          availableModels.push(...page.items.slice(0, 512 - availableModels.length));
          cursor = availableModels.length >= 512 ? null : page.nextCursor;
        } while (cursor !== null);
        return {
          restriction: this.persistence.getTeamModelRestriction(),
          availableModels,
        };
      },
    );
    this.handleMutation(
      IPC_CHANNELS.settingsSetTeamModelRestriction,
      teamModelRestrictionSetInputSchema,
      z.undefined(),
      (input, event, envelope) =>
        this.runMutation(event, envelope, '', IPC_CHANNELS.settingsSetTeamModelRestriction, () =>
          this.persistence.setTeamModelRestriction(input),
        ).value,
    );
    this.handle(
      IPC_CHANNELS.settingsGetDefaultTeamPolicy,
      emptyPayloadSchema,
      teamPolicySchema,
      () => this.persistence.getDefaultTeamPolicy(),
    );
    this.handleMutation(
      IPC_CHANNELS.settingsSetDefaultTeamPolicy,
      teamPolicySchema,
      z.undefined(),
      (input, event, envelope) =>
        this.runMutation(event, envelope, '', IPC_CHANNELS.settingsSetDefaultTeamPolicy, () =>
          this.persistence.setDefaultTeamPolicy(input),
        ).value,
    );
    this.handle(IPC_CHANNELS.settingsSkillsScan, emptyPayloadSchema, skillScanResultSchema, () =>
      this.skillSettings.scan().catch((error) => Promise.reject(skillSettingsPublicError(error))),
    );
    this.handle(
      IPC_CHANNELS.settingsSkillsPreview,
      skillCandidateInputSchema,
      skillPreviewResultSchema,
      (input, event) =>
        this.skillSettings
          .preview(event.sender.id, input.provider, input.skillId)
          .catch((error) => Promise.reject(skillSettingsPublicError(error))),
    );
    this.handle(
      IPC_CHANNELS.settingsSkillsImport,
      skillImportInputSchema,
      skillImportResultSchema,
      (input, event) =>
        this.skillSettings
          .import(event.sender.id, input.previewId)
          .catch((error) => Promise.reject(skillSettingsPublicError(error))),
    );
    this.handle(
      IPC_CHANNELS.settingsSkillsUpdate,
      skillImportInputSchema,
      skillImportResultSchema,
      (input, event) =>
        this.skillSettings
          .update(event.sender.id, input.previewId)
          .catch((error) => Promise.reject(skillSettingsPublicError(error))),
    );
    this.handle(
      IPC_CHANNELS.settingsSkillsSetEnabled,
      skillEnabledInputSchema,
      z.undefined(),
      (input) =>
        this.skillSettings
          .setEnabled(input.provider, input.skillId, input.enabled)
          .catch((error) => Promise.reject(skillSettingsPublicError(error))),
    );
    this.handle(
      IPC_CHANNELS.settingsSkillsRemove,
      skillInstalledInputSchema,
      z.undefined(),
      (input) =>
        this.skillSettings
          .remove(input.provider, input.skillId)
          .catch((error) => Promise.reject(skillSettingsPublicError(error))),
    );
    this.handle(IPC_CHANNELS.skillsList, emptyPayloadSchema, skillCatalogSchema, () =>
      this.skillSettings
        .listCatalog()
        .catch((error) => Promise.reject(skillSettingsPublicError(error))),
    );
    this.handle(
      IPC_CHANNELS.skillsGetDraftSelection,
      taskIdPayloadSchema,
      turnSkillSelectionsSchema,
      (input) => this.persistence.getDraftSkillSelections(input.taskId),
    );
    this.handleMutation(
      IPC_CHANNELS.skillsSetDraftSelection,
      taskSkillSelectionInputSchema,
      z.undefined(),
      (input, event, envelope) =>
        this.runMutation(event, envelope, input.taskId, IPC_CHANNELS.skillsSetDraftSelection, () =>
          this.persistence.setDraftSkillSelections(input.taskId, input.skills),
        ).value,
    );
    this.handle(IPC_CHANNELS.skillsListDrafts, emptyPayloadSchema, z.array(skillDraftSchema), () =>
      this.skillSettings.listDrafts(),
    );
    this.handle(
      IPC_CHANNELS.skillsCreateDraft,
      skillDraftCreateInputSchema,
      skillDraftSchema,
      (input) =>
        this.skillSettings
          .createDraft(input)
          .catch((error) => Promise.reject(skillSettingsPublicError(error))),
    );
    this.handle(
      IPC_CHANNELS.skillsInstallDraft,
      skillDraftInstallInputSchema,
      skillCatalogItemSchema,
      (input) =>
        this.skillSettings
          .installDraft(input.draftId, input.expectedDigest)
          .catch((error) => Promise.reject(skillSettingsPublicError(error))),
    );
    this.handle(IPC_CHANNELS.skillsDiscardDraft, skillDraftIdInputSchema, z.undefined(), (input) =>
      this.skillSettings.discardDraft(input.draftId),
    );
    this.handle(
      IPC_CHANNELS.skillsRemoveCreated,
      createdSkillMutationInputSchema,
      z.undefined(),
      (input) =>
        this.skillSettings
          .removeCreated(input.skillId, input.digest)
          .catch((error) => Promise.reject(skillSettingsPublicError(error))),
    );
    this.handle(
      IPC_CHANNELS.skillsSetCreatedEnabled,
      createdSkillEnabledInputSchema,
      z.undefined(),
      (input) =>
        this.skillSettings
          .setCreatedEnabled(input.skillId, input.digest, input.enabled)
          .catch((error) => Promise.reject(skillSettingsPublicError(error))),
    );
    this.handle(
      IPC_CHANNELS.skillsExportCreated,
      createdSkillMutationInputSchema,
      z.string().nullable(),
      async (input) => {
        const result = await dialog.showOpenDialog(this.window, {
          title: `${input.skillId}のExport先を選択`,
          properties: ['openDirectory', 'createDirectory'],
        });
        const destinationParent = result.filePaths[0];
        if (result.canceled || destinationParent === undefined) return null;
        return this.skillSettings
          .exportCreated(input.skillId, input.digest, destinationParent)
          .catch((error) => Promise.reject(skillSettingsPublicError(error)));
      },
    );
    this.handle(
      IPC_CHANNELS.modelsCatalogQuery,
      modelCatalogQueryInputSchema,
      modelCatalogQueryResultSchema,
      async (input) => {
        await this.refreshModelCatalog();
        const result = this.modelCatalog.query(input);
        const runtimeKind = this.persistence.getRuntime();
        const selection =
          this.persistence.getTaskModelSelection(input.taskId) ??
          modelSelectionForRuntime(runtimeKind, this.persistence.getModel());
        return {
          ...result,
          selection,
          multiProviderModelPickerV2: multiProviderModelPickerV2Enabled(),
        };
      },
    );
    this.handle(
      IPC_CHANNELS.providersListConnections,
      emptyPayloadSchema,
      z.array(providerConnectionSchema),
      () => [...this.providerConnections.list()],
    );
    this.handle(
      IPC_CHANNELS.providersListProfiles,
      emptyPayloadSchema,
      z.array(providerProfileSchema),
      () => [...this.providerProfiles.list()],
    );
    this.handleMutation(
      IPC_CHANNELS.providersCreateOpenAIConnection,
      openAIConnectionCreateInputSchema,
      providerConnectionSchema,
      async (input, event, envelope) => {
        const created = this.runMutation(
          event,
          envelope,
          '',
          IPC_CHANNELS.providersCreateOpenAIConnection,
          () => this.providerConnections.createOpenAI(input),
        ).value;
        return this.providerVerification.verify(created);
      },
    );
    this.handleMutation(
      IPC_CHANNELS.providersCreateOpenRouterConnection,
      openRouterConnectionCreateInputSchema,
      providerConnectionSchema,
      async (input, event, envelope) => {
        const created = this.runMutation(
          event,
          envelope,
          '',
          IPC_CHANNELS.providersCreateOpenRouterConnection,
          () => this.providerConnections.createOpenRouter(input),
        ).value;
        return this.providerVerification.verify(created);
      },
    );
    this.handleMutation(
      IPC_CHANNELS.providersCreateAnthropicConnection,
      anthropicConnectionCreateInputSchema,
      providerConnectionSchema,
      async (input, event, envelope) => {
        const created = this.runMutation(
          event,
          envelope,
          '',
          IPC_CHANNELS.providersCreateAnthropicConnection,
          () => this.providerConnections.createAnthropic(input),
        ).value;
        return this.providerVerification.verify(created);
      },
    );
    this.handleMutation(
      IPC_CHANNELS.providersCreateGeminiConnection,
      geminiConnectionCreateInputSchema,
      providerConnectionSchema,
      async (input, event, envelope) => {
        const created = this.runMutation(
          event,
          envelope,
          '',
          IPC_CHANNELS.providersCreateGeminiConnection,
          () => this.providerConnections.createGemini(input),
        ).value;
        return this.providerVerification.verify(created);
      },
    );
    this.handleMutation(
      IPC_CHANNELS.providersCreateXAIConnection,
      xAIConnectionCreateInputSchema,
      providerConnectionSchema,
      async (input, event, envelope) => {
        const created = this.runMutation(
          event,
          envelope,
          '',
          IPC_CHANNELS.providersCreateXAIConnection,
          () => this.providerConnections.createXAI(input),
        ).value;
        return this.providerVerification.verify(created);
      },
    );
    this.handleMutation(
      IPC_CHANNELS.providersCreateProfileConnection,
      providerProfileConnectionCreateInputSchema,
      providerConnectionSchema,
      async (input, event, envelope) => {
        const created = this.runMutation(
          event,
          envelope,
          '',
          IPC_CHANNELS.providersCreateProfileConnection,
          () => this.providerConnections.createProfile(input),
        ).value;
        return this.providerVerification.verify(created);
      },
    );
    this.handle(
      IPC_CHANNELS.providersVerifyConnection,
      z.object({ connectionId: connectionIdSchema }).strict(),
      providerConnectionSchema,
      (input) =>
        this.providerVerification.verify(
          this.persistence.getProviderConnection(input.connectionId),
        ),
    );
    this.handleMutation(
      IPC_CHANNELS.providersLowerRateLimits,
      providerConnectionRateLimitLowerInputSchema,
      providerConnectionSchema,
      (input, event, envelope) =>
        this.runMutation(event, envelope, '', IPC_CHANNELS.providersLowerRateLimits, () =>
          this.persistence.lowerProviderConnectionRateLimits(input.connectionId, {
            ...(input.maxConcurrentRequests === undefined
              ? {}
              : { maxConcurrentRequests: input.maxConcurrentRequests }),
            ...(input.requestsPerMinute === undefined
              ? {}
              : { requestsPerMinute: input.requestsPerMinute }),
            ...(input.tokensPerMinute === undefined
              ? {}
              : { tokensPerMinute: input.tokensPerMinute }),
          }),
        ).value,
    );
    this.handleMutation(
      IPC_CHANNELS.modelsSetSelection,
      modelCatalogSelectionSetInputSchema,
      modelSelectionSchema,
      async (input, event, envelope) => {
        const runtime = builtinRuntimeForModelSelection(input.selection);
        if (runtime === null) {
          if (input.selection.connectionId === null || input.selection.requestedModel === null)
            throw new InvalidModelError('provider');
          const connection = await this.providerVerification.requireVerifiedForExecution(
            input.selection.connectionId,
          );
          if (connection.providerId !== input.selection.requestedProvider || !connection.enabled)
            throw new InvalidModelError('provider');
          const models = await this.providerRegistry
            .resolve(connection)
            .listModels(connection, new AbortController().signal);
          if (!models.some(({ modelId }) => modelId === input.selection.requestedModel))
            throw new InvalidModelError('provider');
        } else {
          const capability = await this.runtimeFor(runtime.runtimeKind).probe();
          if (capability.readiness !== 'ready')
            throw new RuntimeUnavailableError(runtime.runtimeKind);
          if (!capability.models.some(({ id }) => id === runtime.model))
            throw new InvalidModelError(runtime.runtimeKind);
        }
        return this.runMutation(
          event,
          envelope,
          input.taskId,
          IPC_CHANNELS.modelsSetSelection,
          () => {
            if (runtime !== null) {
              this.persistence.setRuntime(runtime.runtimeKind);
              this.persistence.setModel(runtime.model);
            }
            return (
              this.persistence.setTaskModelSelection(input.taskId, input.selection) ??
              input.selection
            );
          },
        ).value;
      },
    );
    this.handleMutation(
      IPC_CHANNELS.settingsSetRuntime,
      runtimeSetInputSchema,
      z.undefined(),
      async (input, event, envelope) => {
        if (input.kind === 'codex' || input.kind === 'claude') {
          const capability = await this.runtimeFor(input.kind).probe();
          if (capability.readiness !== 'ready') throw new RuntimeUnavailableError(input.kind);
        }
        return this.runMutation(
          event,
          envelope,
          input.taskId ?? '',
          IPC_CHANNELS.settingsSetRuntime,
          () => {
            this.persistence.setRuntime(input.kind);
            if (input.taskId !== undefined)
              this.persistence.setTaskModelSelection(
                input.taskId,
                modelSelectionForRuntime(input.kind, this.persistence.getModel()),
              );
          },
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
        const taskSelection =
          input.taskId === undefined ? null : this.persistence.getTaskModelSelection(input.taskId);
        const taskRuntime =
          taskSelection === null ? null : builtinRuntimeForModelSelection(taskSelection);
        const kind = taskRuntime?.runtimeKind ?? this.persistence.getRuntime();
        const runtimeKind = kind === 'claude' ? 'claude' : 'codex';
        const capability = await this.runtimeFor(runtimeKind).probe();
        if (capability.readiness !== 'ready') throw new RuntimeUnavailableError(runtimeKind);
        if (!capability.models.some(({ id }) => id === input.model))
          throw new InvalidModelError(runtimeKind);
        return this.runMutation(
          event,
          envelope,
          input.taskId ?? '',
          IPC_CHANNELS.settingsSetModel,
          () => {
            if (this.persistence.getRuntime() !== runtimeKind)
              this.persistence.setRuntime(runtimeKind);
            this.persistence.setModel(input.model);
            if (input.taskId !== undefined)
              this.persistence.setTaskModelSelection(
                input.taskId,
                modelSelectionForRuntime(runtimeKind, input.model),
              );
            // Models advertise different reasoning levels, so a model change can strand the stored
            // Codex level (Sol advertises `ultra`, GPT-5.5 does not). Re-clamp and persist here so
            // the synchronous turn dispatch can trust `getCodexEffort()` without a probe — leaving
            // it stale would fail the next turn outright rather than degrade.
            if (runtimeKind === 'codex')
              this.persistence.setCodexEffort(
                clampCodexEffort(this.persistence.getCodexEffort(), capability.models, input.model),
              );
          },
        ).value;
      },
    );
    this.handle(
      IPC_CHANNELS.filesPick,
      taskIdPayloadSchema,
      fileOpenResultSchema.nullable(),
      async (input) => {
        const workspace = this.persistence.getEffectiveWorkspaceSet(input.taskId);
        const workspacePath = primaryWorkspacePath(workspace);
        if (workspacePath === null) return null;
        const selected = await dialog.showOpenDialog(this.window, {
          title: 'Workspaceのファイルを開く',
          defaultPath: workspacePath,
          properties: ['openFile', 'dontAddToRecent'],
        });
        if (selected.canceled || selected.filePaths.length === 0) return null;
        const rooted = resolveTurnRootedPath(workspace, selected.filePaths[0]!);
        if (rooted === null)
          return {
            rootId: workspace.primaryRootId ?? 'legacy-primary',
            path: selected.filePaths[0]!,
            text: '',
            digest: EMPTY_FILE_DIGEST,
            editable: false,
            reason: 'outside_workspace' as const,
          };
        return {
          ...openWorkspaceFileForEdit(rooted.root.path, rooted.path),
          rootId: rooted.root.rootId,
        };
      },
    );
    this.handle(IPC_CHANNELS.filesOpen, filePathPayloadSchema, fileOpenResultSchema, (input) => {
      const root = resolveEffectiveWorkspaceRoot(
        this.persistence.getEffectiveWorkspaceSet(input.taskId),
        input.rootId,
      );
      // No Workspace means no file to open and nowhere to save one, so this is a refusal rather
      // than an empty document the user could type into and then fail to save.
      if (root === null)
        return {
          rootId: input.rootId,
          path: input.path,
          text: '',
          digest: EMPTY_FILE_DIGEST,
          editable: false,
          reason: 'outside_workspace' as const,
        };
      return { ...openWorkspaceFileForEdit(root.path, input.path), rootId: root.rootId };
    });
    this.handle(IPC_CHANNELS.filesRecover, filePathPayloadSchema, fileOpenResultSchema, (input) => {
      const root = resolveEffectiveWorkspaceRoot(
        this.persistence.getEffectiveWorkspaceSet(input.taskId),
        input.rootId,
      );
      if (root === null)
        return {
          rootId: input.rootId,
          path: input.path,
          text: '',
          digest: EMPTY_FILE_DIGEST,
          editable: false,
          reason: 'outside_workspace' as const,
        };
      return { ...recoverWorkspaceFileForEdit(root.path, input.path), rootId: root.rootId };
    });
    this.handleMutation(
      IPC_CHANNELS.filesSave,
      fileSaveInputSchema,
      fileSaveResultSchema,
      (input, event, envelope) =>
        this.runMutation(event, envelope, input.taskId, IPC_CHANNELS.filesSave, () => {
          const root = resolveEffectiveWorkspaceRoot(
            this.persistence.getEffectiveWorkspaceSet(input.taskId),
            input.rootId,
          );
          if (root === null)
            return {
              outcome: 'refused' as const,
              digest: null,
              reason: 'outside_workspace' as const,
              conflictPath: null,
            };
          const result = saveWorkspaceFile(root.path, input.path, input.text, input.baseDigest);
          // Audited only on an actual write, and as its own event type: `files.changed` is the record
          // of what a Runtime did, and a human's edit does not belong in it (issue #43).
          if (result.outcome === 'saved')
            this.publish(
              this.persistence.recordUserFileSave({
                taskId: input.taskId,
                rootId: root.rootId,
                rootLabel: root.label,
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
        if (capability.readiness !== 'ready') throw new RuntimeUnavailableError('codex');
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
        this.runMutation(
          _event,
          envelope,
          _input.projectId === undefined ? 'tasks' : `project:${_input.projectId}`,
          IPC_CHANNELS.tasksCreate,
          () => this.persistence.createTask(_input.title, _input.localOnly, _input.projectId),
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

    this.handle(IPC_CHANNELS.projectsList, emptyPayloadSchema, z.array(projectSummarySchema), () =>
      this.persistence.listProjects(),
    );
    this.handle(
      IPC_CHANNELS.projectsPickFolders,
      emptyPayloadSchema,
      projectFolderPickerResultSchema,
      async () => {
        const selected = await dialog.showOpenDialog(this.window, {
          properties: ['openDirectory', 'multiSelections'],
        });
        if (selected.canceled) return { canceled: true as const };
        if (selected.filePaths.length > 16)
          throw new InvalidProjectError('Project folder limit reached');
        const bindings = await canonicalProjectFolderBindings(
          selected.filePaths.map((path, ordinal) => ({
            path,
            role: ordinal === 0 ? ('primary' as const) : ('secondary' as const),
          })),
        );
        await confirmHomeDirectoryAccess(
          this.window,
          bindings.map(({ canonicalPath }) => canonicalPath),
        );
        return {
          canceled: false as const,
          folders: bindings.map(({ canonicalPath, label }) => ({ path: canonicalPath, label })),
        };
      },
    );
    this.handle(
      IPC_CHANNELS.projectsFoldersList,
      projectFoldersListInputSchema,
      z.array(projectFolderSchema),
      async (input) => {
        const folders = this.persistence.listProjectFolders(input.projectId);
        const identities = this.persistence.getProjectFolderRootIdentities(input.projectId);
        return Promise.all(
          folders.map(async (folder) => ({
            ...folder,
            status: await projectFolderHealth(folder.path, identities.get(folder.id)),
          })),
        );
      },
    );
    this.handleMutation(
      IPC_CHANNELS.projectsFoldersReplace,
      projectFoldersReplaceInputSchema,
      projectSummarySchema,
      async (input, event, envelope) => {
        const folders = await canonicalProjectFolderBindings(input.folders);
        await confirmHomeDirectoryAccess(
          this.window,
          folders.map(({ canonicalPath }) => canonicalPath),
        );
        return this.runMutation(
          event,
          envelope,
          `project:${input.projectId}`,
          IPC_CHANNELS.projectsFoldersReplace,
          () => this.persistence.replaceProjectFolders({ ...input, folders }),
        ).value;
      },
    );
    this.handle(
      IPC_CHANNELS.projectsGet,
      projectGetInputSchema,
      projectInstructionResultSchema,
      (input) => this.persistence.getProjectInstruction(input.projectId),
    );
    this.handleMutation(
      IPC_CHANNELS.projectsSetInstruction,
      projectInstructionSetInputSchema,
      projectInstructionResultSchema,
      (input, event, envelope) =>
        this.runMutation(
          event,
          envelope,
          `project:${input.projectId}`,
          IPC_CHANNELS.projectsSetInstruction,
          () => this.persistence.setProjectInstruction(input),
        ).value,
    );
    this.handle(
      IPC_CHANNELS.projectsListContextManifests,
      projectContextManifestsListInputSchema,
      z.array(projectContextManifestSummarySchema),
      (input) => this.persistence.listProjectContextManifests(input.taskId),
    );
    this.handle(
      IPC_CHANNELS.projectsGetContextManifest,
      projectContextManifestGetInputSchema,
      projectContextManifestSchema,
      (input) => this.persistence.getProjectContextManifest(input.taskId, input.turnId),
    );
    this.handle(
      IPC_CHANNELS.projectsReferencesList,
      projectReferencesListInputSchema,
      z.array(projectReferenceSchema),
      (input) => this.persistence.listProjectReferences(input.projectId),
    );
    this.handleMutation(
      IPC_CHANNELS.projectsReferencesAdd,
      projectReferenceAddInputSchema,
      projectReferenceSchema,
      async (input, event, envelope) => {
        const cached = this.persistence.getOperationResult<ProjectReference>(
          principalFor(event),
          `project:${input.projectId}`,
          IPC_CHANNELS.projectsReferencesAdd,
          envelope.operationId,
          requestHash(envelope.payload),
        );
        if (cached.found && cached.value !== null) return cached.value;
        const workspace =
          input.projectRootId === undefined
            ? this.persistence.getWorkspace(input.sourceTaskId!)
            : (this.persistence
                .listProjectFolders(input.projectId)
                .find(({ id }) => id === input.projectRootId)?.path ?? null);
        if (workspace === null) throw new InvalidProjectError('Source Task has no Workspace');
        const binding = await workspaceMutationBinding(workspace);
        return this.runMutation(
          event,
          envelope,
          `project:${input.projectId}`,
          IPC_CHANNELS.projectsReferencesAdd,
          () =>
            this.persistence.addProjectReference({
              projectId: input.projectId,
              ...(input.sourceTaskId === undefined ? {} : { sourceTaskId: input.sourceTaskId }),
              ...(input.projectRootId === undefined ? {} : { projectRootId: input.projectRootId }),
              relativePath: input.relativePath,
              registeredRootIdentity: binding.rootIdentityDigest,
            }),
        ).value;
      },
    );
    this.handleMutation(
      IPC_CHANNELS.projectsReferencesPick,
      projectReferencePickInputSchema,
      projectReferenceSchema.nullable(),
      async (input, event, envelope) => {
        const workspace =
          input.projectRootId === undefined
            ? this.persistence.getWorkspace(input.sourceTaskId!)
            : (this.persistence
                .listProjectFolders(input.projectId)
                .find(({ id }) => id === input.projectRootId)?.path ?? null);
        if (workspace === null) throw new InvalidProjectError('Source Task has no Workspace');
        const cached = this.persistence.getOperationResult<ProjectReference | null>(
          principalFor(event),
          `project:${input.projectId}`,
          IPC_CHANNELS.projectsReferencesPick,
          envelope.operationId,
          requestHash(envelope.payload),
        );
        if (cached.found) return cached.value ?? null;
        const selected = await dialog.showOpenDialog(this.window, {
          defaultPath: workspace,
          properties: ['openFile'],
        });
        if (selected.canceled || selected.filePaths[0] === undefined)
          return this.runMutation(
            event,
            envelope,
            `project:${input.projectId}`,
            IPC_CHANNELS.projectsReferencesPick,
            () => null,
          ).value;
        const relative = relativePath(workspace, selected.filePaths[0]);
        const binding = await workspaceMutationBinding(workspace);
        return this.runMutation(
          event,
          envelope,
          `project:${input.projectId}`,
          IPC_CHANNELS.projectsReferencesPick,
          () =>
            this.persistence.addProjectReference({
              projectId: input.projectId,
              ...(input.sourceTaskId === undefined ? {} : { sourceTaskId: input.sourceTaskId }),
              ...(input.projectRootId === undefined ? {} : { projectRootId: input.projectRootId }),
              relativePath: relative,
              registeredRootIdentity: binding.rootIdentityDigest,
            }),
        ).value;
      },
    );
    this.handleMutation(
      IPC_CHANNELS.projectsReferencesUpdate,
      projectReferenceUpdateInputSchema,
      projectReferenceSchema,
      (input, event, envelope) =>
        this.runMutation(
          event,
          envelope,
          `reference:${input.referenceId}`,
          IPC_CHANNELS.projectsReferencesUpdate,
          () => this.persistence.updateProjectReference(input),
        ).value,
    );
    this.handleMutation(
      IPC_CHANNELS.projectsReferencesRemove,
      projectReferenceRemoveInputSchema,
      z.undefined(),
      (input, event, envelope) =>
        this.runMutation(
          event,
          envelope,
          `reference:${input.referenceId}`,
          IPC_CHANNELS.projectsReferencesRemove,
          () => this.persistence.removeProjectReference(input.referenceId, input.expectedRevision),
        ).value,
    );
    this.handle(
      IPC_CHANNELS.projectsMemoriesList,
      projectMemoriesListInputSchema,
      z.array(projectMemorySchema),
      (input) => this.persistence.listProjectMemories(input.projectId),
    );
    this.handleMutation(
      IPC_CHANNELS.projectsMemoriesCreate,
      projectMemoryCreateInputSchema,
      projectMemorySchema,
      (input, event, envelope) =>
        this.runMutation(
          event,
          envelope,
          `project:${input.projectId}`,
          IPC_CHANNELS.projectsMemoriesCreate,
          () => this.persistence.createProjectMemoryFromTurn(input),
        ).value,
    );
    this.handleMutation(
      IPC_CHANNELS.projectsMemoriesUpdate,
      projectMemoryUpdateInputSchema,
      projectMemorySchema,
      (input, event, envelope) =>
        this.runMutation(
          event,
          envelope,
          `memory:${input.memoryId}`,
          IPC_CHANNELS.projectsMemoriesUpdate,
          () => this.persistence.updateProjectMemory(input),
        ).value,
    );
    this.handleMutation(
      IPC_CHANNELS.projectsCreate,
      projectCreateInputSchema,
      projectSummarySchema,
      async (input, event, envelope) => {
        const folders =
          input.folders === undefined
            ? undefined
            : await canonicalProjectFolderBindings(input.folders);
        await confirmHomeDirectoryAccess(
          this.window,
          folders?.map(({ canonicalPath }) => canonicalPath) ?? [],
        );
        return this.runMutation(event, envelope, 'projects', IPC_CHANNELS.projectsCreate, () =>
          this.persistence.createProject(
            folders === undefined ? { name: input.name } : { name: input.name, folders },
          ),
        ).value;
      },
    );
    this.handleMutation(
      IPC_CHANNELS.projectsUpdate,
      projectUpdateInputSchema,
      projectSummarySchema,
      (input, event, envelope) =>
        this.runMutation(
          event,
          envelope,
          `project:${input.projectId}`,
          IPC_CHANNELS.projectsUpdate,
          () => this.persistence.updateProject(input),
        ).value,
    );
    this.handleMutation(
      IPC_CHANNELS.projectsAssignTask,
      projectAssignTaskInputSchema,
      taskSummarySchema,
      (input, event, envelope) =>
        this.runMutation(event, envelope, input.taskId, IPC_CHANNELS.projectsAssignTask, () =>
          this.persistence.assignTaskToProject(input),
        ).value,
    );
    this.handleMutation(
      IPC_CHANNELS.projectsUnassignTask,
      projectUnassignTaskInputSchema,
      taskSummarySchema,
      (input, event, envelope) =>
        this.runMutation(event, envelope, input.taskId, IPC_CHANNELS.projectsUnassignTask, () =>
          this.persistence.unassignTaskFromProject(input),
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
    this.handleMutation(
      IPC_CHANNELS.teamsUpdatePolicy,
      teamPolicyUpdateInputSchema,
      teamDetailSchema,
      (input) => this.teamCoordinator.updatePolicy(input),
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
      IPC_CHANNELS.teamsResumeMission,
      teamResumeMissionInputSchema,
      teamMissionSummarySchema,
      (input) => this.teamCoordinator.resumeMission(input.taskId, input.missionId),
    );
    this.handleMutation(
      IPC_CHANNELS.teamsResumeExecutionIntegration,
      teamResumeExecutionIntegrationInputSchema,
      teamDetailSchema,
      (input) => this.teamCoordinator.resumeExecutionIntegration(input.taskId, input.executionId),
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
    this.handle(
      IPC_CHANNELS.workspaceGetEffective,
      taskIdPayloadSchema,
      effectiveWorkspaceSetSchema,
      async (input) => {
        const effective = this.persistence.getEffectiveWorkspaceSet(input.taskId);
        const identities = this.persistence.getEffectiveWorkspaceRootIdentities(input.taskId);
        return {
          ...effective,
          roots: await Promise.all(
            effective.roots.map(async (root) => ({
              ...root,
              status: await projectFolderHealth(root.path, identities.get(root.rootId)),
            })),
          ),
        };
      },
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
      async (input, event, envelope) => {
        const skills = await this.skillSettings
          .resolveSelections(input.skills)
          .catch((error) => Promise.reject(skillSettingsPublicError(error)));
        let started: StartedTurn | undefined;
        const result = this.runMutation(
          event,
          envelope,
          input.taskId,
          IPC_CHANNELS.turnsStart,
          () => {
            started = this.persistence.startTurn(
              input.taskId,
              input.text,
              skills,
              shouldSealBuiltinTeamSkill(input.text, skills),
            );
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
      async (input, event, envelope) => {
        const skills = await this.skillSettings
          .resolveSelections(input.skills)
          .catch((error) => Promise.reject(skillSettingsPublicError(error)));
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
              skills,
              shouldSealBuiltinTeamSkill(input.text, skills),
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
        if (
          activeRuntimeKind === 'codex' ||
          activeRuntimeKind === 'claude' ||
          activeRuntimeKind === 'provider'
        )
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
        const skills = await this.skillSettings
          .resolveSelections(input.skills)
          .catch((error) => Promise.reject(skillSettingsPublicError(error)));
        const principal = principalFor(event);
        const hash = requestHash(envelope.payload);
        const cached = this.persistence.getOperationResult<void>(
          principal,
          input.taskId,
          IPC_CHANNELS.turnsStopAndSend,
          envelope.operationId,
          hash,
        );
        const pendingKey = `${principal}\u0000${input.taskId}\u0000${envelope.operationId}`;
        if (cached.found) {
          const pending = this.pendingStopAndSendByOperation.get(pendingKey);
          if (pending !== undefined) await this.finishStopAndSend(pendingKey, pending);
          return cached.value;
        }
        const activeTurnId = this.persistence.getActiveTurnId(input.taskId);
        let transition: StopAndSendTransition | undefined;
        const result = this.runMutation(
          event,
          envelope,
          input.taskId,
          IPC_CHANNELS.turnsStopAndSend,
          () => {
            transition = this.persistence.replaceActiveTurn(
              input.taskId,
              activeTurnId,
              input.text,
              skills,
              shouldSealBuiltinTeamSkill(input.text, skills),
            );
          },
        );
        if (result.executed && transition !== undefined) {
          const pending = {
            taskId: input.taskId,
            canceledTurnId: activeTurnId,
            transition,
            logicalEndNotified: false,
          };
          this.pendingStopAndSendByOperation.set(pendingKey, pending);
          await this.finishStopAndSend(pendingKey, pending);
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
    await this.teamMcpBridge.ensureStarted();
    try {
      const skillHome = process.env['SPRINT_CODER_SKILL_HOME'] ?? app.getPath('home');
      const store = await SkillStore.open({
        rootPath: join(skillHome, '.sprintcoder', 'skills'),
      });
      await Promise.all([
        store.installBuiltin(
          BUILTIN_TEAM_SKILL_ID,
          BUILTIN_TEAM_SKILL_CONTENT,
          BUILTIN_TEAM_SKILL_DIGEST,
        ),
        store.installBuiltin(
          BUILTIN_SKILL_CREATOR_ID,
          BUILTIN_SKILL_CREATOR_CONTENT,
          BUILTIN_SKILL_CREATOR_DIGEST,
        ),
      ]);
      this.teamSkillReady = true;
    } catch {
      this.teamSkillReady = false;
    }
    await this.adoptInstalledRuntime();
  }

  /**
   * Picks an installed CLI the first time the app runs, instead of leaving Mock in place (issue #50).
   *
   * Mock is the fallback for a machine with nothing installed, not the default for one with
   * everything installed. Left as the default it produces plausible-looking code instantly, which
   * reads as the app working rather than as a stand-in — the failure mode that prompted this.
   *
   * Only when the user has never chosen. An explicit choice of Mock is a choice and is left alone,
   * which is why this needs `getStoredRuntime()` rather than `getRuntime()`.
   *
   * Best-effort: a probe failure or a write failure must not stop the app from starting.
   */
  private async adoptInstalledRuntime(): Promise<void> {
    try {
      // Opt-out for launches that must stay deterministic. The E2E harness sets it, because every
      // spec asserts against the mock's fixed output — without this, a machine with a CLI installed
      // would run the whole suite against a real model, slowly and at real cost.
      if (process.env['SPRINT_CODER_RUNTIME_ADOPT'] === '0') return;
      if (this.persistence.getStoredRuntime() !== null) return;
      const [codex, claude] = await Promise.all([
        this.codexRuntime.probe(),
        this.claudeRuntime.probe(),
      ]);
      // Codex first only because it is the historical default of this app's settings key; neither is
      // "better", and the user changes it in one click either way.
      const installed: RuntimeKind | null =
        codex.readiness === 'ready' ? 'codex' : claude.readiness === 'ready' ? 'claude' : null;
      if (installed === null) return;
      this.persistence.setRuntime(installed);
    } catch {
      // Nothing to recover: the stored value stays absent and the app runs on Mock, exactly as
      // before this existed.
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.taskTitleProviderAborts.abortAll();
    for (const channel of new Set(Object.values(IPC_CHANNELS))) ipcMain.removeHandler(channel);
    this.closeAllPorts();
    this.teamSubscriptions.clear();
    this.approvalCoordinator.dispose();
    await this.providerWorkspaceTools.dispose();
    // A watch outlives its Turn only if the app is torn down mid-write; close them here so the
    // process can actually exit (issue #39).
    for (const watchers of this.workspaceWatchByTurn.values())
      for (const watcher of watchers) watcher.stop();
    this.workspaceWatchByTurn.clear();
    await this.mockRuntime.dispose();
    for (const [executionId, job] of this.cliTaskTitleJobs) {
      clearTimeout(job.timer);
      job.resolve(null);
      void this.taskTitleRuntimeFor(job.kind)
        .cancel(job.taskId, executionId)
        .catch(() => undefined);
    }
    this.cliTaskTitleJobs.clear();
    this.pendingTaskTitles.clear();
    this.taskTitleRuntimes.dispose();
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

  private finishAndAdvance(
    taskId: string,
    turnId: string,
    state: 'completed' | 'failed',
    finalText?: string,
  ): void {
    const pendingTaskTitle = this.pendingTaskTitles.get(turnId);
    this.pendingTaskTitles.delete(turnId);
    const kind = this.turnRuntimes.get(turnId);
    this.turnRuntimes.delete(turnId);
    // Flush the tail and stop the timer before the turn is finalised, so the last thought is not
    // lost to the 120ms window and no timer outlives the turn.
    this.reasoningByTurn.get(turnId)?.dispose();
    this.reasoningByTurn.delete(turnId);
    this.reasoningRedactorByTurn.delete(turnId);
    for (const watcher of this.workspaceWatchByTurn.get(turnId) ?? []) watcher.stop();
    this.workspaceWatchByTurn.delete(turnId);
    this.turnWorkspaceByTurn.delete(turnId);
    this.baselinesByTurn.delete(turnId);
    // A turn that ends mid-write leaves its redaction state behind otherwise (issue #39).
    for (const key of this.fileEditByKey.keys())
      if (key.startsWith(`${turnId}\u0000`)) this.fileEditByKey.delete(key);
    // Back to idle on a clean finish. A failure already pushed its own `failed` status with the
    // reason attached (see handleRuntimeFailure), and must not be overwritten by an idle here.
    if (kind !== undefined && kind !== 'provider' && state === 'completed')
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
    this.teamRequiredTurns.delete(turnId);
    this.teamSkillExpectedTurns.delete(turnId);
    this.teamSkillResolutionByTurn.delete(turnId);
    const resolvedModel = this.resolvedModelByTurn.get(turnId);
    const resolvedProvider = this.resolvedProviderByTurn.get(turnId);
    this.resolvedModelByTurn.delete(turnId);
    this.resolvedProviderByTurn.delete(turnId);
    if (resolvedModel !== undefined)
      this.persistence.recordTurnResolution(taskId, turnId, {
        // CLI Runtimes do not report a canonical provider. Official API Runtimes do.
        resolvedProvider: resolvedProvider ?? null,
        resolvedModel,
      });
    const event = this.persistence.completeTurn(taskId, turnId, state, finalText);
    if (state === 'completed') this.commitProjectMemoryCandidates(turnId);
    else this.pendingProjectMemoriesByTurn.delete(turnId);
    this.publish(
      event.type === 'turn.completed' && resolvedModel !== undefined
        ? { ...event, resolvedModel }
        : event,
    );
    this.approvalCoordinator.turnEnded(taskId, turnId, 'finished');
    this.dispatchQueueTransition(this.persistence.startNextQueued(taskId));
    if (state === 'completed' && pendingTaskTitle !== undefined)
      void this.generateAndApplyTaskTitle(pendingTaskTitle);
  }

  private async evaluateToolPermission(request: ToolAuthorizationRequest, capability: Capability) {
    const facts = approvalFactsForTool(request, capability);
    const commandRunner = request.entry.implementationKind === 'command-runner';
    // Provider-issued processes are never covered by a preset-wide silent grant. Even Full must
    // show the exact sealed executable + argv for an explicit allow-once/task decision: an argv can
    // encode deletion, network access, or an interpreter program that a name allowlist cannot see.
    if (commandRunner)
      return {
        decision: 'approval_required' as const,
        reason: 'provider_command_requires_explicit_approval',
      };
    const sandboxProfile =
      capability === 'workspace.write' || capability === 'filesystem.external.write'
        ? ('workspace-write' as const)
        : ('read-only' as const);
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
      turnId: request.context.turnId,
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
    const pathGuard = workspaceToolAuthorizationGuard(
      request.input,
      facts.operation === 'read' || facts.operation === 'write' ? facts.operation : undefined,
    );
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
    this.rememberTaskTitleRequest(started);
    this.publish(started.event);
    for (const event of started.contextUsageEvents) this.publish(event);
    void this.startSelectedRuntime(started);
  }

  private dispatchQueueTransition(transition: QueueTransition): void {
    if (transition === null) return;
    this.rememberTaskTitleRequest(transition.started);
    this.publish(transition.started.event);
    for (const event of transition.started.contextUsageEvents) this.publish(event);
    this.publish(transition.queueEvent);
    void this.startSelectedRuntime(transition.started);
  }

  private async startSelectedRuntime(started: StartedTurn): Promise<void> {
    const taskId = started.event.taskId;
    if (started.runtimeKind !== 'mock') {
      try {
        await this.assertTurnWorkspaceHealthy(started);
      } catch {
        const kind = started.runtimeKind === 'claude' ? 'claude' : 'codex';
        this.turnRuntimes.set(started.turnId, kind);
        this.handleRuntimeFailure(kind, taskId, started.turnId, {
          code: 'RUNTIME_FAILED',
          userMessage:
            'Projectのフォルダが見つからないか、読取不能、または別のフォルダへ変更されています。再リンクしてから再試行してください。',
          retryable: false,
        });
        return;
      }
    }
    const externalConnectionId =
      builtinRuntimeForModelSelection(started.modelSelection) === null
        ? started.modelSelection.connectionId
        : null;
    if (externalConnectionId !== null) {
      this.turnRuntimes.set(started.turnId, 'provider');
      this.turnWorkspaceByTurn.set(started.turnId, started.workspaceSet);
      void this.startProviderTurn(started, externalConnectionId, started.teamTurn);
      return;
    }
    this.pushRuntimeStatus({
      kind: started.runtimeKind,
      state: 'running',
      taskId,
      errorCode: null,
      userMessage: null,
    });
    let kind = started.runtimeKind;
    // Leader MCP is enabled by default: a real Codex/Claude Leader drives team_* tools itself
    // over the MCP bridge instead of the deterministic mock scenario. Team tools are offered on
    // every real-runtime turn so the model itself senses
    // when a request warrants a team (the guidance says to hire only when genuinely beneficial);
    // hiring auto-promotes the task and the renderer auto-opens the canvas, so "the AI decided a
    // team is needed" becomes visible without any keyword or button.
    const teamTurn = started.teamTurn;
    const skillCreatorTurn = started.skills.some(
      ({ selection }) =>
        selection.ref.source === 'builtin' && selection.ref.skillId === 'skill-creator',
    );
    const memoryTurn = this.persistence.getTask(taskId).projectId !== null;
    const wantsLeaderMcp =
      process.env['SPRINT_CODER_LEADER_MCP'] !== '0' &&
      kind !== 'mock' &&
      (teamTurn || skillCreatorTurn || memoryTurn);
    if (teamTurn && wantsLeaderMcp && !this.teamSkillReady) {
      this.handleRuntimeFailure(kind === 'claude' ? 'claude' : 'codex', taskId, started.turnId, {
        code: 'RUNTIME_FAILED',
        userMessage: '組み込みTeam Skillを検証できないためTeamを開始できません。',
        retryable: true,
      });
      return;
    }
    let teamMcp: RuntimeTeamMcpOption | undefined;
    if (wantsLeaderMcp) {
      teamMcp = this.registerLeaderMcp(started.turnId, taskId, {
        teamTurn,
        skillCreatorTurn,
        memoryTurn,
      });
      if (teamMcp === undefined && (teamTurn || skillCreatorTurn)) {
        this.handleRuntimeFailure(kind === 'claude' ? 'claude' : 'codex', taskId, started.turnId, {
          code: 'RUNTIME_FAILED',
          userMessage: 'Team MCPへ接続できないためTeamを開始できません。',
          retryable: true,
        });
        return;
      }
      if (teamTurn) this.teamRequiredTurns.add(started.turnId);
    } else if (kind !== 'mock' && teamTurn) {
      // Team intent without Leader MCP always runs the leader orchestration
      // (hire→dispatch→reports→synthesis): the production adapters are no-tools by default, so a
      // real-runtime leader cannot drive a team — the deterministic leader orchestrates while
      // Workers execute on the real runtime.
      kind = 'mock';
    }
    this.turnRuntimes.set(started.turnId, kind);
    this.turnWorkspaceByTurn.set(started.turnId, started.workspaceSet);
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
    const turnWorkspace = primaryWorkspacePath(started.workspaceSet);
    if (
      turnWorkspace !== null &&
      resolveWriteScope(this.persistence.getPermissionPolicy(taskId).preset, turnWorkspace) !==
        'read-only'
    ) {
      this.startWorkspaceWatch(taskId, started.turnId, started.workspaceSet);
      // Baselines are per Turn: "the file as this Turn found it" is only meaningful inside one
      // (issue #41). Created here so `git status` is read once, at the moment the Turn starts,
      // rather than after the Runtime has already begun changing things.
      this.baselinesByTurn.set(
        started.turnId,
        new Map(
          started.workspaceSet.roots.map((root) => [root.rootId, createEditBaselines(root.path)]),
        ),
      );
    }
    if (kind === 'mock') {
      this.mockRuntime.start(taskId, started.turnId, started.text);
      return;
    }
    const workspacePath = turnWorkspace;
    const workspaceId =
      started.workspaceSet.roots.length === 0 ? null : started.workspaceSet.digest;
    const context = this.prepareContext(taskId, started.turnId, teamTurn && wantsLeaderMcp);
    // What this Turn may write (issue #37). Both inputs matter: the Access preset is the user's
    // choice, and the Workspace is what makes a write meaningful at all — without one the Runtime's
    // cwd is a throwaway temp directory, so an edit would land somewhere the user can never see.
    const writeScope = resolveWriteScope(
      this.persistence.getPermissionPolicy(taskId).preset,
      workspacePath,
    );
    const dispatchEgress =
      kind === 'claude' ? dispatchAfterClaudeProviderEgress : dispatchAfterCodexProviderEgress;
    const runtimeSkills = started.skills.map((skill) => ({
      name: skill.selection.ref.skillId,
      path: skill.packagePath,
    }));
    const serializedPayload = serializeCliExecutionPayload({
      kind,
      request: started.text,
      contextFragments: context.fragments.map(toRuntimeContextFragment),
      projectItems: context.projectItems,
      ...(teamMcp === undefined ? {} : { teamGuidance: teamMcp.guidance }),
      skills: runtimeSkills,
    });
    const gatePayload = Buffer.from(serializedPayload.bytes);
    const dispatchPayload = Object.freeze({
      text: Buffer.from(serializedPayload.bytes).toString('utf8'),
      bytes: Buffer.from(serializedPayload.bytes),
      digest: serializedPayload.digest,
    });
    const egress = dispatchEgress(
      {
        broker: this.permissionBroker,
        task: this.persistence.getTask(taskId),
        turnId: started.turnId,
        prompt: gatePayload.toString('utf8'),
        context,
        now: new Date().toISOString(),
        payloadDigest: serializedPayload.digest,
        adapterVersion: 'runtime-protocol-v7',
        connectionId: kind === 'claude' ? 'builtin:claude-cli' : 'builtin:codex-cli',
        modelId: started.model,
        endpointTrust: 'trusted-remote',
        round: 1,
        toolCatalogDigest: createEmptyToolCatalogSnapshot(kind, workspaceId).digest,
      },
      () =>
        this.runtimeFor(kind).start(
          taskId,
          started.turnId,
          started.text,
          toRuntimeWorkspaceSet(started.workspaceSet),
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
          runtimeSkills,
          dispatchPayload,
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

  private async assertTurnWorkspaceHealthy(started: StartedTurn): Promise<void> {
    const expected = this.persistence.getTurnWorkspaceRootIdentities(started.turnId);
    await verifyTurnWorkspaceIdentities(started.workspaceSet, expected);
  }

  /** Starts the bridge's socket if needed and mints a fresh bearer token bound to this one turn.
   * Returns undefined when the bridge is unavailable (never blocks the turn on it — see the
   * fallback in startSelectedRuntime). */
  private registerLeaderMcp(
    turnId: string,
    taskId: string,
    options: { teamTurn: boolean; skillCreatorTurn: boolean; memoryTurn: boolean },
  ): RuntimeTeamMcpOption | undefined {
    const socketPath = this.teamMcpBridge.socketPath;
    if (socketPath === null) return undefined;
    const token = TeamMcpBridge.generateToken();
    const requireModelResearch = this.persistence.getTeamModelResearchBeforeHiring();
    this.teamMcpBridge.register(turnId, {
      taskId,
      token,
      contextOwner: { type: 'turn', id: turnId },
      requireModelResearch,
      ...(options.skillCreatorTurn ? { allowSkillDrafts: true } : {}),
      ...(options.memoryTurn ? { allowProjectMemory: true } : {}),
      allowTeamTools: options.teamTurn,
    });
    const guidance = [
      options.teamTurn ? teamGuidance(LEADER_MCP_SYSTEM_PROMPT, requireModelResearch) : null,
      options.skillCreatorTurn
        ? 'skill-creatorが選択されています。skill_draft_createで確認待ちDraftだけを作成し、インストールは行わないでください。team_*ツールは使用しません。'
        : null,
      options.memoryTurn ? PROJECT_MEMORY_MCP_GUIDANCE : null,
    ]
      .filter((item): item is string => item !== null)
      .join('\n\n');
    return {
      socketPath,
      token,
      guidance,
      enableWebSearch: options.teamTurn && requireModelResearch,
    };
  }

  private async queueProjectMemoryCandidate(
    input: unknown,
    context: { taskId: string; turnId: string },
  ): Promise<{ queued: true }> {
    const content = parseProjectMemoryCandidate(input);
    const manifest = this.persistence.getContextSealManifest('turn', context.turnId);
    if (manifest.taskId !== context.taskId || manifest.projectId === null)
      throw new Error('Projectに所属しないTurnではProject Memoryを利用できません');
    const pending = appendProjectMemoryCandidate(
      this.pendingProjectMemoriesByTurn.get(context.turnId) ?? [],
      { projectId: manifest.projectId, content },
    );
    this.pendingProjectMemoriesByTurn.set(context.turnId, pending);
    return { queued: true };
  }

  private commitProjectMemoryCandidates(turnId: string): void {
    const candidates = this.pendingProjectMemoriesByTurn.get(turnId) ?? [];
    this.pendingProjectMemoriesByTurn.delete(turnId);
    for (const candidate of candidates) {
      try {
        const duplicate = this.persistence
          .listProjectMemories(candidate.projectId)
          .some(({ content, status }) => status === 'active' && content === candidate.content);
        if (duplicate) continue;
        this.persistence.createAgentProjectMemoryFromTurn({
          projectId: candidate.projectId,
          sourceTurnId: turnId,
          content: candidate.content,
        });
      } catch (error) {
        secureLogger.error('Project Memory candidate commit failed', { turnId, error });
      }
    }
  }

  private registerManagerMcp(
    turnId: string,
    taskId: string,
    requesterAgentId: string,
    executionId?: string,
  ): RuntimeTeamMcpOption | undefined {
    const socketPath = this.teamMcpBridge.socketPath;
    if (socketPath === null) return undefined;
    const token = TeamMcpBridge.generateToken();
    const requireModelResearch = this.persistence.getTeamModelResearchBeforeHiring();
    this.teamMcpBridge.register(turnId, {
      taskId,
      token,
      requesterAgentId,
      accessCeiling:
        executionId === undefined
          ? 'read-only'
          : this.persistence.getTeamExecution(executionId).accessMode,
      ...(executionId === undefined
        ? {}
        : { contextOwner: { type: 'team_execution' as const, id: executionId } }),
      requireModelResearch,
    });
    return {
      socketPath,
      token,
      guidance: teamGuidance(MANAGER_MCP_SYSTEM_PROMPT, requireModelResearch),
      enableWebSearch: requireModelResearch,
    };
  }

  private registerWorkerMcp(
    turnId: string,
    taskId: string,
    requesterAgentId: string,
    executionId?: string,
  ): RuntimeTeamMcpOption | undefined {
    const socketPath = this.teamMcpBridge.socketPath;
    if (socketPath === null) return undefined;
    const token = TeamMcpBridge.generateToken();
    this.teamMcpBridge.register(turnId, {
      taskId,
      token,
      requesterAgentId,
      ...(executionId === undefined
        ? {}
        : { contextOwner: { type: 'team_execution' as const, id: executionId } }),
    });
    return { socketPath, token, guidance: WORKER_MCP_SYSTEM_PROMPT };
  }

  private async refreshModelCatalog(): Promise<void> {
    const [codexCapability, claudeCapability] = await Promise.all([
      this.codexRuntime.probe(),
      this.claudeRuntime.probe(),
    ]);
    const checkedAt = new Date().toISOString();
    const externalResults = await Promise.allSettled(
      this.providerConnections
        .list()
        .filter(
          (connection) =>
            connection.enabled &&
            connection.runtimeKind !== 'builtin_cli' &&
            connection.secretReference !== null,
        )
        .map(async (connection) => {
          const verified = await this.providerVerification.requireVerifiedForExecution(
            connection.id,
          );
          const models = await this.providerRegistry
            .resolve(verified)
            .listModels(verified, new AbortController().signal);
          return models.map((model) => ({
            ...model,
            connectionDisplayName: connection.displayName,
          }));
        }),
    );
    const externalModels = externalResults.flatMap((result) =>
      result.status === 'fulfilled' ? [...result.value] : [],
    );
    this.modelCatalog.replaceCatalog(
      [
        ...providerModelsForBuiltin(
          'builtin:codex-cli',
          'Codex CLI',
          'openai',
          codexCapability.models,
          codexCapability.readiness === 'ready',
          checkedAt,
        ),
        ...providerModelsForBuiltin(
          'builtin:claude-cli',
          'Claude Code',
          'anthropic',
          claudeCapability.models,
          claudeCapability.readiness === 'ready',
          checkedAt,
        ),
        ...externalModels,
      ],
      new Set(['builtin:codex-cli', 'builtin:claude-cli']),
    );
  }

  private async listTeamModelCandidates(
    input: Parameters<NonNullable<ExecuteTeamToolOptions['listModelCandidates']>>[0],
  ): Promise<unknown> {
    await this.refreshModelCatalog();
    const result = this.modelCatalog.query(
      {
        taskId: input.taskId,
        text: input.text,
        connectionIds: [...input.connectionIds],
        providerIds: [...input.providerIds],
        accessTypes: [],
        capabilities: [...input.capabilities],
        availableOnly: true,
        cursor: input.cursor,
        limit: input.limit,
      },
      this.teamModelAllowedKeys(),
    );
    return process.env['SPRINT_CODER_TEAM_CODEX_ONLY'] === '1'
      ? {
          ...result,
          items: result.items.filter(
            ({ connectionId, providerId }) =>
              connectionId === BUILTIN_CODEX_CONNECTION_ID && providerId === 'openai',
          ),
        }
      : result;
  }

  private async validateTeamModelSelection(
    selection: ModelSelection,
    taskId: string,
  ): Promise<void> {
    if (
      selection.connectionId === null ||
      selection.requestedProvider === null ||
      selection.requestedModel === null
    )
      throw new Error('Team Worker model selection must identify a Connection and model');
    if (
      process.env['SPRINT_CODER_TEAM_CODEX_ONLY'] === '1' &&
      (selection.connectionId !== BUILTIN_CODEX_CONNECTION_ID ||
        selection.requestedProvider !== 'openai')
    )
      throw new Error('This Team durability run permits only Codex CLI OpenAI models');
    await this.refreshModelCatalog();
    if (!this.isTeamModelAllowed(selection))
      throw new Error('Selected Team Worker model is not permitted by Team model settings');
    const result = this.modelCatalog.query(
      {
        taskId,
        text: selection.requestedModel,
        connectionIds: [selection.connectionId],
        providerIds: [selection.requestedProvider],
        accessTypes: [],
        capabilities: [],
        availableOnly: true,
        cursor: null,
        limit: 100,
      },
      this.teamModelAllowedKeys(),
    );
    if (
      !result.items.some(
        (model) =>
          model.connectionId === selection.connectionId &&
          model.providerId === selection.requestedProvider &&
          model.modelId === selection.requestedModel,
      )
    )
      throw new Error('Selected Team Worker model is not available on the requested Connection');
  }

  private teamModelAllowedKeys(): ReadonlySet<string> | undefined {
    const restriction = this.persistence.getTeamModelRestriction();
    return restriction.mode === 'all'
      ? undefined
      : new Set(restriction.allowedModels.map(teamModelIdentityKey));
  }

  private isTeamModelAllowed(selection: ModelSelection): boolean {
    const allowed = this.teamModelAllowedKeys();
    if (allowed === undefined) return true;
    if (
      selection.connectionId === null ||
      selection.requestedProvider === null ||
      selection.requestedModel === null
    )
      return false;
    return allowed.has(
      teamModelIdentityKey({
        connectionId: selection.connectionId,
        providerId: selection.requestedProvider,
        modelId: selection.requestedModel,
      }),
    );
  }

  private prepareContext(taskId: string, turnId: string, teamSkill = false): PreparedContext {
    const prepared = this.persistence.prepareContext(taskId, turnId);
    for (const event of prepared.usageEvents) this.publish(event);
    if (teamSkill) {
      this.teamSkillExpectedTurns.add(turnId);
      this.teamSkillResolutionByTurn.set(turnId, BUILTIN_TEAM_SKILL_AUDIT);
    }
    return prepared;
  }

  private acknowledgeRuntimeContext(
    taskId: string,
    turnId: string,
    acceptedFragmentIds: readonly string[],
    acceptedProjectItemIds: readonly string[] = [],
    acceptedProjectSnapshotDigest: string | null = null,
  ): void {
    const sealed = this.persistence.prepareContext(taskId, turnId);
    if (
      sealed.projectSnapshotDigest !== acceptedProjectSnapshotDigest ||
      sealed.projectItems.length !== acceptedProjectItemIds.length ||
      sealed.projectItems.some((item, index) => item.id !== acceptedProjectItemIds[index])
    )
      throw new Error('Runtime Project context acknowledgement mismatch');
    const expectedTeamSkill = this.teamSkillExpectedTurns.delete(turnId);
    if (!verifyBuiltinTeamSkillAcceptance(expectedTeamSkill, acceptedFragmentIds)) {
      this.teamSkillResolutionByTurn.delete(turnId);
      const runtime = this.turnRuntimes.get(turnId);
      this.handleRuntimeFailure(runtime === 'claude' ? 'claude' : 'codex', taskId, turnId, {
        code: 'RUNTIME_PROTOCOL_ERROR',
        userMessage: 'Runtimeが組み込みTeam Skillを受理しませんでした。',
        retryable: false,
      });
      return;
    }
    if (expectedTeamSkill && !acceptedFragmentIds.includes(BUILTIN_TEAM_SKILL_FRAGMENT_ID)) return;
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

  private taskTitleRuntimeFor(kind: 'codex' | 'claude'): RuntimeHostClient {
    return this.taskTitleRuntimes.get(kind);
  }

  private rememberTaskTitleRequest(started: StartedTurn): void {
    if (started.renamedTask === undefined) return;
    this.pendingTaskTitles.set(started.turnId, {
      taskId: started.event.taskId,
      text: started.text,
      runtimeKind: started.runtimeKind,
      model: started.model,
      modelSelection: started.modelSelection,
    });
  }

  /**
   * Generates a better title only after the first response completed. The local title produced in
   * persistence remains visible throughout this work and is also the permanent fallback if any
   * policy, Runtime, provider, timeout, or parsing step fails.
   */
  private async generateAndApplyTaskTitle(request: TaskTitleRequest): Promise<void> {
    try {
      const builtin = builtinRuntimeForModelSelection(request.modelSelection);
      let generated: string | null;
      if (builtin !== null)
        generated = await this.generateCliTaskTitle(request, builtin.runtimeKind, builtin.model);
      else if (request.modelSelection.connectionId !== null)
        generated = await this.generateProviderTaskTitle(
          request,
          request.modelSelection.connectionId,
        );
      else if (request.runtimeKind === 'codex' || request.runtimeKind === 'claude')
        generated = await this.generateCliTaskTitle(request, request.runtimeKind, request.model);
      else generated = null;
      if (generated === null || this.disposed) return;

      const updated = this.persistence.applyGeneratedTaskTitle(request.taskId, generated);
      if (updated !== null) this.pushTaskUpdated(updated);
    } catch {
      // Title quality is never allowed to change chat reliability. The immediate local fallback
      // remains readable and no failure is projected into the completed Turn.
    }
  }

  private async generateCliTaskTitle(
    request: TaskTitleRequest,
    kind: 'codex' | 'claude',
    model: string,
  ): Promise<string | null> {
    if (this.disposed) return null;
    const executionId = randomUUID();
    const context = createTaskTitleContext(request.taskId, request.text);
    const catalog = createEmptyToolCatalogSnapshot(kind, null);
    const serializedPayload = serializeCliExecutionPayload({
      kind,
      request: TASK_TITLE_PROMPT,
      contextFragments: context.fragments.map(toRuntimeContextFragment),
      projectItems: context.projectItems,
      skills: [],
    });
    const authorize =
      kind === 'claude' ? authorizeClaudeProviderEgress : authorizeCodexProviderEgress;
    const egress = authorize({
      broker: this.permissionBroker,
      task: this.persistence.getTask(request.taskId),
      turnId: executionId,
      prompt: Buffer.from(serializedPayload.bytes).toString('utf8'),
      context,
      now: new Date().toISOString(),
      payloadDigest: serializedPayload.digest,
      adapterVersion: 'runtime-protocol-v7:title-v1',
      connectionId: kind === 'claude' ? 'builtin:claude-cli' : 'builtin:codex-cli',
      modelId: model,
      endpointTrust: 'trusted-remote',
      round: 1,
      toolCatalogDigest: catalog.digest,
    });
    if (!egress.allowed) return null;

    let effort: string | undefined;
    if (kind === 'claude') effort = this.persistence.getEffort();
    else {
      const capability = await this.codexRuntime.probe();
      if (this.disposed) return null;
      effort =
        clampCodexEffort(this.persistence.getCodexEffort(), capability.models, model) || undefined;
    }

    return await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        const job = this.cliTaskTitleJobs.get(executionId);
        if (job === undefined) return;
        this.cliTaskTitleJobs.delete(executionId);
        job.resolve(null);
        void this.taskTitleRuntimeFor(kind)
          .cancel(request.taskId, executionId)
          .catch(() => undefined);
      }, MODEL_TASK_TITLE_TIMEOUT_MS);
      this.cliTaskTitleJobs.set(executionId, {
        taskId: request.taskId,
        kind,
        output: '',
        timer,
        resolve,
      });
      this.taskTitleRuntimeFor(kind).start(
        request.taskId,
        executionId,
        TASK_TITLE_PROMPT,
        null,
        model,
        catalog,
        context,
        undefined,
        effort,
        'read-only',
        [],
        serializedPayload,
      );
    });
  }

  private async generateProviderTaskTitle(
    request: TaskTitleRequest,
    connectionId: string,
  ): Promise<string | null> {
    if (this.disposed) return null;
    const controller = new AbortController();
    const releaseController = this.taskTitleProviderAborts.track(controller);
    const timer = setTimeout(() => controller.abort(), MODEL_TASK_TITLE_TIMEOUT_MS);
    const executionId = randomUUID();
    try {
      const connection = await this.providerVerification.requireVerifiedForExecution(
        connectionId,
        controller.signal,
      );
      const modelId = request.modelSelection.requestedModel;
      if (modelId === null || connection.providerId !== request.modelSelection.requestedProvider)
        return null;
      const context = createTaskTitleContext(request.taskId, request.text);
      const messages: ProviderExecutionRequest['messages'] = [
        { role: 'system', content: TASK_TITLE_PROMPT },
        { role: 'user', content: request.text },
      ];
      const payload = JSON.stringify({ messages });
      const trust = this.providerEgressTrustForConnection(connection);
      const egress = authorizeOfficialApiProviderEgress(
        {
          broker: this.permissionBroker,
          task: this.persistence.getTask(request.taskId),
          turnId: executionId,
          prompt: payload,
          context,
          now: new Date().toISOString(),
          payloadDigest: digestCanonical(payload),
          adapterVersion: 'provider-registry-v1:title-v1',
          connectionId,
          modelId,
          endpointTrust: trust,
          round: 1,
          toolCatalogDigest: digestCanonical([]),
        },
        connection.providerId,
        trust,
      );
      if (!egress.allowed) return null;

      const runtime = this.providerRegistry.resolve(connection);
      let output = '';
      for await (const event of runtime.execute(
        connection,
        { executionId, connectionId, modelId, messages },
        controller.signal,
      )) {
        if (event.type === 'output_delta' && output.length < 8_192)
          output += event.text.slice(0, 8_192 - output.length);
        else if (event.type === 'error' || event.type === 'tool_call') return null;
        else if (event.type === 'completed') break;
      }
      return sanitizeGeneratedTaskTitle(output);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      releaseController();
      if (controller.signal.aborted) {
        try {
          const connection = this.persistence.getProviderConnection(connectionId);
          await this.providerRegistry.resolve(connection).cancel(executionId);
        } catch {
          // The fallback title remains; cancellation is best-effort during timeout/teardown.
        }
      }
    }
  }

  private routeCliTaskTitleEvent(
    kind: 'codex' | 'claude',
    _taskId: string,
    turnId: string,
    event: RuntimeCanonicalEvent,
  ): void {
    const job = this.cliTaskTitleJobs.get(turnId);
    if (job === undefined || job.kind !== kind) return;
    if (event.type === 'delta' && job.output.length < 8_192)
      job.output += event.delta.slice(0, 8_192 - job.output.length);
    if (event.type !== 'completed') return;
    clearTimeout(job.timer);
    this.cliTaskTitleJobs.delete(turnId);
    const finalOutput =
      event.finalText?.trim() === '' ? job.output : (event.finalText ?? job.output);
    job.resolve(sanitizeGeneratedTaskTitle(finalOutput));
  }

  private routeCliTaskTitleFailure(
    kind: 'codex' | 'claude',
    _taskId: string,
    turnId: string,
    _error: PublicError,
  ): void {
    const job = this.cliTaskTitleJobs.get(turnId);
    if (job === undefined || job.kind !== kind) return;
    clearTimeout(job.timer);
    this.cliTaskTitleJobs.delete(turnId);
    job.resolve(null);
  }

  private pushTaskUpdated(task: ReturnType<PersistenceClient['getTask']>): void {
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) return;
    this.window.webContents.send(IPC_CHANNELS.tasksUpdated, taskSummarySchema.parse(task));
  }

  private async cancelRuntime(taskId: string, turnId: string): Promise<void> {
    await this.runtimeCancelActions.run(turnId, () => {
      this.pendingTaskTitles.delete(turnId);
      const kind = this.turnRuntimes.get(turnId);
      let cancelAction: () => Promise<void>;
      if (kind === 'codex' || kind === 'claude')
        cancelAction = async () => {
          await this.runtimeFor(kind).cancel(taskId, turnId);
        };
      else if (kind === 'provider') {
        const controller = this.providerAbortByTurn.get(turnId);
        const identity = this.persistence.getTurnModelIdentity(taskId, turnId);
        const provider =
          identity.selection.connectionId === null
            ? null
            : this.providerRegistry.resolve(
                this.persistence.getProviderConnection(identity.selection.connectionId),
              );
        cancelAction = async () => {
          controller?.abort();
          if (provider !== null) await provider.cancel(turnId);
        };
      } else
        cancelAction = async () => {
          await this.mockRuntime.cancel(turnId);
        };
      this.turnRuntimes.delete(turnId);
      this.teamMcpBridge.unregister(turnId);
      this.teamRequiredTurns.delete(turnId);
      this.teamSkillExpectedTurns.delete(turnId);
      this.teamSkillResolutionByTurn.delete(turnId);
      this.pendingProjectMemoriesByTurn.delete(turnId);
      this.providerAbortByTurn.delete(turnId);
      return cancelAction;
    });
  }

  private async finishStopAndSend(
    operationKey: string,
    pending: {
      taskId: string;
      canceledTurnId: string | null;
      transition: StopAndSendTransition;
      logicalEndNotified: boolean;
    },
  ): Promise<void> {
    if (pending.canceledTurnId !== null) {
      if (!pending.logicalEndNotified) {
        this.approvalCoordinator.turnEnded(pending.taskId, pending.canceledTurnId, 'canceled');
        pending.logicalEndNotified = true;
      }
      await this.cancelRuntime(pending.taskId, pending.canceledTurnId);
    }
    if (pending.transition.canceledEvent !== null) this.publish(pending.transition.canceledEvent);
    this.dispatchStarted(pending.transition.started);
    this.pendingStopAndSendByOperation.delete(operationKey);
  }

  private async startProviderTurn(
    started: StartedTurn,
    connectionId: string,
    teamTurn = false,
  ): Promise<void> {
    const taskId = started.event.taskId;
    const memoryTurn = this.persistence.getTask(taskId).projectId !== null;
    const controller = new AbortController();
    this.providerAbortByTurn.set(started.turnId, controller);
    let synthesizing = false;
    const messageId = randomUUID();
    let reportCursorValue = 0;
    let modelCatalogQueried = false;
    const reportCursor = {
      read: () => reportCursorValue,
      advance: (seq: number) => {
        reportCursorValue = Math.max(reportCursorValue, seq);
      },
    };
    const modelCatalogAudit = {
      wasQueried: () => modelCatalogQueried,
      markQueried: () => {
        modelCatalogQueried = true;
      },
    };
    let workspaceToolSnapshot: ToolCatalogSnapshot | undefined;
    try {
      const connection = await this.providerVerification.requireVerifiedForExecution(
        connectionId,
        controller.signal,
      );
      const modelId = started.modelSelection.requestedModel;
      if (modelId === null || connection.providerId !== started.modelSelection.requestedProvider)
        throw new Error('Provider Turn model selection is invalid');
      const context = this.prepareContext(taskId, started.turnId, teamTurn);
      if (teamTurn)
        this.acknowledgeRuntimeContext(
          taskId,
          started.turnId,
          context.fragments.map((fragment) => fragment.id),
          context.projectItems.map((item) => item.id),
          context.projectSnapshotDigest,
        );
      await this.mailbox.run(taskId, () => {
        if (this.turnRuntimes.get(started.turnId) !== 'provider') return;
        this.publish(this.persistence.changeStage(taskId, started.turnId, 'understanding'));
        this.publish(this.persistence.changeStage(taskId, started.turnId, 'planning'));
        this.publish(this.persistence.changeStage(taskId, started.turnId, 'executing'));
      });
      const runtime = this.providerRegistry.resolve(connection);
      const messages: ProviderExecutionRequest['messages'] = context.fragments.map((fragment) => ({
        role: fragment.trust,
        content: fragment.content,
      }));
      messages.unshift(...projectContextProviderMessages(context.projectItems));
      if (memoryTurn) messages.unshift({ role: 'system', content: PROJECT_MEMORY_MCP_GUIDANCE });
      const selectedModel = this.modelCatalog.find(connectionId, modelId);
      const workspaceToolsEligible = providerWorkspaceToolsEligible(
        teamTurn,
        started.workspaceSet.roots.length,
        selectedModel?.toolCalling.value,
      );
      workspaceToolSnapshot = workspaceToolsEligible
        ? this.providerWorkspaceTools.startTurn(
            {
              taskId,
              turnId: started.turnId,
              workspaceId: started.workspaceSet.digest,
              policyEpoch: this.persistence.getPermissionPolicy(taskId).policyEpoch,
            },
            connection.providerId,
          )
        : undefined;
      if (!teamTurn)
        messages.unshift({
          role: 'system',
          content: workspaceToolsEligible
            ? PROVIDER_WORKSPACE_GUIDANCE
            : PROVIDER_NO_TOOL_GUIDANCE,
        });
      let roundTools = assertUniqueProviderTools([
        ...(teamTurn ? LEADER_PROVIDER_TOOLS : []),
        ...(memoryTurn ? [PROJECT_MEMORY_PROVIDER_TOOL] : []),
        ...(workspaceToolSnapshot === undefined
          ? []
          : providerToolsFromSnapshot(workspaceToolSnapshot)),
      ]);
      const seenProviderToolCallIds = new Set<string>();
      let aggregateUsage: NormalizedProviderUsage | undefined;
      let finished = false;
      for (let ordinal = 1; ordinal <= MAX_PROVIDER_LEADER_ROUNDS; ordinal += 1) {
        const roundPayloadBytes = Buffer.from(
          JSON.stringify({ messages, tools: roundTools }),
          'utf8',
        );
        const roundPayloadDigest = createHash('sha256').update(roundPayloadBytes).digest('hex');
        const dispatchRound = JSON.parse(Buffer.from(roundPayloadBytes).toString('utf8')) as {
          messages: ProviderExecutionRequest['messages'];
          tools: ProviderExecutionRequest['tools'];
        };
        const egress = authorizeOfficialApiProviderEgress(
          {
            broker: this.permissionBroker,
            task: this.persistence.getTask(taskId),
            turnId: started.turnId,
            prompt: Buffer.from(roundPayloadBytes).toString('utf8'),
            context,
            now: new Date().toISOString(),
            payloadDigest: roundPayloadDigest,
            adapterVersion: 'provider-registry-v1',
            connectionId,
            modelId,
            endpointTrust: this.providerEgressTrustForConnection(connection),
            round: ordinal,
            toolCatalogDigest: digestCanonical(roundTools),
          },
          connection.providerId,
          this.providerEgressTrustForConnection(connection),
        );
        if (!egress.allowed) throw new Error('Provider egress was denied by policy');
        const roundToolCalls: ProviderMessageToolCall[] = [];
        const roundOutput: string[] = [];
        let roundError: Extract<CanonicalProviderEvent, { type: 'error' }>['error'] | undefined;
        let roundCompleted = false;
        for await (const providerEvent of runtime.execute(
          connection,
          {
            executionId: providerTurnCallId(started.turnId, ordinal),
            connectionId,
            modelId,
            messages: dispatchRound.messages,
            ...(dispatchRound.tools === undefined || dispatchRound.tools.length === 0
              ? {}
              : { tools: dispatchRound.tools }),
          },
          controller.signal,
        )) {
          if (this.turnRuntimes.get(started.turnId) !== 'provider') return;
          if (providerEvent.type === 'tool_call') {
            const knownTeamTool =
              teamTurn && LEADER_PROVIDER_TOOLS.some((tool) => tool.name === providerEvent.name);
            const knownMemoryTool =
              memoryTurn && providerEvent.name === PROJECT_MEMORY_PROVIDER_TOOL.name;
            const knownWorkspaceTool = workspaceToolSnapshot?.entries.some(
              (tool) => tool.providerName === providerEvent.name,
            );
            if (!knownTeamTool && !knownMemoryTool && !knownWorkspaceTool)
              throw new Error(`Provider Leader requested unknown tool: ${providerEvent.name}`);
            if (seenProviderToolCallIds.has(providerEvent.callId))
              throw new Error(`Provider Leader repeated tool call ID: ${providerEvent.callId}`);
            seenProviderToolCallIds.add(providerEvent.callId);
            roundToolCalls.push({
              callId: providerEvent.callId,
              name: providerEvent.name,
              input: providerEvent.input,
              ...(providerEvent.providerMetadata === undefined
                ? {}
                : { providerMetadata: providerEvent.providerMetadata }),
            });
            continue;
          }
          if (providerEvent.type === 'usage')
            aggregateUsage = mergeProviderTurnUsage(aggregateUsage, providerEvent.usage);
          if (providerEvent.type === 'error') {
            roundError = providerEvent.error;
            continue;
          }
          await this.mailbox.run(taskId, () => {
            if (this.turnRuntimes.get(started.turnId) !== 'provider') return;
            if (providerEvent.type === 'reasoning_delta') {
              this.pushReasoning(taskId, started.turnId, providerEvent.text);
              return;
            }
            if (providerEvent.type === 'output_delta') {
              roundOutput.push(providerEvent.text);
              if (!synthesizing) {
                synthesizing = true;
                this.publish(this.persistence.changeStage(taskId, started.turnId, 'synthesizing'));
              }
              this.publish(
                this.persistence.appendDelta(taskId, started.turnId, messageId, providerEvent.text),
              );
              return;
            }
            if (providerEvent.type !== 'usage')
              this.applyProviderTurnEvent(taskId, started.turnId, providerEvent);
            if (providerEvent.type === 'completed') roundCompleted = true;
          });
        }
        if (roundError !== undefined) {
          const canRetryWithoutWorkspaceTools = shouldRetryProviderWithoutTools({
            ordinal,
            workspaceToolsBound: workspaceToolSnapshot !== undefined,
            toolCalling: selectedModel?.toolCalling.value,
            errorCategory: roundError.category,
            toolCallCount: roundToolCalls.length,
            outputLength: roundOutput.join('').length,
          });
          if (canRetryWithoutWorkspaceTools) {
            roundTools = Object.freeze([]);
            const guidanceIndex = messages.findIndex(
              ({ role, content }) => role === 'system' && content === PROVIDER_WORKSPACE_GUIDANCE,
            );
            if (guidanceIndex >= 0)
              messages[guidanceIndex] = { role: 'system', content: PROVIDER_NO_TOOL_GUIDANCE };
            else messages.unshift({ role: 'system', content: PROVIDER_NO_TOOL_GUIDANCE });
            for (let index = messages.length - 1; index >= 0; index -= 1)
              if (messages[index]?.content === PROJECT_MEMORY_MCP_GUIDANCE)
                messages.splice(index, 1);
            continue;
          }
          throw new Error('Provider execution failed');
        }
        if (!roundCompleted) throw new Error('Provider stream ended without a completion event');
        if (
          roundToolCalls.length === 0 &&
          shouldBlockProviderLeaderCompletion(
            teamTurn,
            this.teamCoordinator.hasUnfinishedTeamWork(taskId),
          )
        ) {
          messages.push({ role: 'assistant', content: roundOutput.join('') });
          messages.push({
            role: 'system',
            content:
              'Teamには未終端のWorkerまたはexecutionがあります。最終回答へ進まず、team_get_statusとteam_wait_reportsを使って終端状態を確認し、未割当Workerは正式に割り当てるか停止してください。',
          });
          continue;
        }
        if (roundToolCalls.length === 0) {
          finished = true;
          break;
        }
        messages.push({
          role: 'assistant',
          content: roundOutput.join(''),
          toolCalls: roundToolCalls,
        });
        const invalidToolCall = roundToolCalls.find((toolCall) => {
          const definition = roundTools.find(({ name }) => name === toolCall.name);
          return (
            definition === undefined ||
            !toolValueMatchesSchema(definition.inputSchema as never, toolCall.input)
          );
        });
        if (invalidToolCall !== undefined) {
          for (const toolCall of roundToolCalls)
            messages.push({
              role: 'tool',
              content: providerToolErrorContent(
                'INVALID_TOOL_INPUT',
                `Tool input validation failed for ${invalidToolCall.name}`,
              ),
              toolCallId: toolCall.callId,
              toolName: toolCall.name,
            });
          continue;
        }
        for (const toolCall of roundToolCalls) {
          const workspaceTool = workspaceToolSnapshot?.entries.some(
            ({ providerName }) => providerName === toolCall.name,
          );
          let content: string;
          if (workspaceTool) {
            try {
              const result = await this.providerWorkspaceTools.broker.dispatch({
                taskId,
                turnId: started.turnId,
                callId: toolCall.callId,
                providerName: toolCall.name,
                input: toolCall.input,
                signal: controller.signal,
              });
              if (isCommittedProviderWorkspaceMutation(result)) {
                const root = started.workspaceSet.roots.find(
                  ({ rootId }) => rootId === result.rootId,
                );
                if (root !== undefined)
                  this.recordFileChanges(taskId, started.turnId, [
                    { path: resolvePath(root.path, result.path), kind: result.kind },
                  ]);
              }
              content = redactSecrets(JSON.stringify({ ok: true, result }));
            } catch (error) {
              if (controller.signal.aborted) throw error;
              content = providerWorkspaceToolFailure(error);
            }
          } else {
            const result =
              toolCall.name === PROJECT_MEMORY_PROVIDER_TOOL.name
                ? await this.queueProjectMemoryCandidate(toolCall.input, {
                    taskId,
                    turnId: started.turnId,
                  })
                : await executeTeamTool(
                    this.teamCoordinator,
                    taskId,
                    toolCall.name,
                    toolCall.input,
                    {
                      contextOwner: { type: 'turn', id: started.turnId },
                      longPoll:
                        toolCall.name === 'team_wait_reports' ||
                        toolCall.name === 'team_wait_events',
                      waitReportsCursor: reportCursor,
                      listModelCandidates: (query) => this.listTeamModelCandidates(query),
                      modelCatalogAudit,
                    },
                  );
            content = redactSecrets(JSON.stringify(result ?? null));
          }
          messages.push({
            role: 'tool',
            content,
            toolCallId: toolCall.callId,
            toolName: toolCall.name,
          });
        }
      }
      if (!finished)
        throw new Error(`Provider Leader exceeded ${MAX_PROVIDER_LEADER_ROUNDS} provider rounds`);
      if (aggregateUsage !== undefined)
        this.persistence.recordTurnProviderUsage(taskId, started.turnId, aggregateUsage);
      await this.mailbox.run(taskId, () => {
        if (this.turnRuntimes.get(started.turnId) === 'provider')
          this.finishAndAdvance(taskId, started.turnId, 'completed');
      });
    } catch {
      if (controller.signal.aborted || this.turnRuntimes.get(started.turnId) !== 'provider') return;
      await this.mailbox.run(taskId, () => {
        if (this.turnRuntimes.get(started.turnId) !== 'provider') return;
        this.finishAndAdvance(taskId, started.turnId, 'failed');
      });
    } finally {
      if (workspaceToolSnapshot !== undefined)
        this.providerWorkspaceTools.finishTurn(taskId, started.turnId);
      if (this.providerAbortByTurn.get(started.turnId) === controller)
        this.providerAbortByTurn.delete(started.turnId);
    }
  }

  private applyProviderTurnEvent(
    taskId: string,
    turnId: string,
    event: CanonicalProviderEvent,
  ): void {
    if (event.type === 'resolution') {
      if (event.resolution.resolvedProvider !== null)
        this.resolvedProviderByTurn.set(turnId, event.resolution.resolvedProvider);
      if (event.resolution.resolvedModel !== null)
        this.resolvedModelByTurn.set(turnId, event.resolution.resolvedModel);
      return;
    }
    if (event.type === 'usage') {
      this.persistence.recordTurnProviderUsage(taskId, turnId, event.usage);
      return;
    }
    if (event.type === 'tool_call')
      throw new Error('Provider requested a tool that is not available for this Turn');
    if (event.type === 'error') throw new Error(event.error.message);
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
        if (runtimeEvent.type === 'heartbeat') return;
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
        else if (runtimeEvent.type === 'operation') return;
        else {
          if (
            shouldFailRequiredTeamTurn(
              this.teamRequiredTurns.has(turnId),
              this.teamCoordinator.get(taskId)?.workers.filter(({ kind }) => kind === 'worker')
                .length ?? 0,
            )
          ) {
            this.handleRuntimeFailure(kind, taskId, turnId, {
              code: 'RUNTIME_PROTOCOL_ERROR',
              userMessage:
                'Team MCP Workerが1名も作成されませんでした。外部のsubagent機能へfallbackせず終了します。',
              retryable: true,
            });
            return;
          }
          if (runtimeEvent.resolvedModel !== undefined)
            this.resolvedModelByTurn.set(turnId, runtimeEvent.resolvedModel);
          this.finishAndAdvance(taskId, turnId, 'completed', runtimeEvent.finalText);
        }
      })
      .catch((error: unknown) => {
        secureLogger.error('Runtime event handling failed', {
          kind,
          taskId,
          turnId,
          eventType: runtimeEvent.type,
          error,
        });
        this.handleRuntimeFailure(kind, taskId, turnId, runtimeProtocolError());
      });
  }

  /**
   * Follows the Workspace for the life of a Turn, pushing each changed file's contents (issue #39).
   *
   * Deliberately not filtered against what the Runtime reported: the point is to catch the writes it
   * does not report. The path is still checked against the Workspace root by `pushFileEdit`, and the
   * read itself refuses symlinks and binaries (see workspace-file.ts), so "anything that changed" is
   * a safe net to cast here.
   */
  private startWorkspaceWatch(
    taskId: string,
    turnId: string,
    workspace: EffectiveWorkspaceSet,
  ): void {
    for (const watcher of this.workspaceWatchByTurn.get(turnId) ?? []) watcher.stop();
    const watchers = workspace.roots.flatMap((root) => {
      const watcher = watchWorkspace(root.path, (relativePath) => {
        // Turn already finished: a late filesystem event must not reopen a closed Turn's view.
        if (!this.workspaceWatchByTurn.has(turnId)) return;
        const body = readWorkspaceTextFile(root.path, relativePath);
        if (body === null) return;
        this.pushFileEdit(taskId, turnId, resolvePath(root.path, relativePath), body, {
          // Never "complete": on disk there is no such thing as finished, only current. The Turn
          // ending is what stops the view following.
          complete: false,
          source: 'disk',
        });
      });
      return watcher === null ? [] : [watcher];
    });
    if (watchers.length > 0) this.workspaceWatchByTurn.set(turnId, watchers);
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
    const workspace = this.turnWorkspaceByTurn.get(turnId);
    if (workspace === undefined) return;
    const rooted = resolveTurnRootedPath(workspace, absolutePath);
    if (rooted === null) return;
    const { root, path } = rooted;
    const key = `${turnId}\u0000${root.rootId}\u0000${path}`;
    let state = this.fileEditByKey.get(key);
    if (state === undefined) {
      if (this.fileEditByKey.size >= 16) return;
      state = { redactor: createStreamingSecretRedactor(), safe: '', consumed: 0 };
      this.fileEditByKey.set(key, state);
      // First time this Turn has mentioned this path — the last moment the file might still hold
      // its "before" content (issue #41). For a streamed write that is genuinely before the write;
      // for a watcher event it is already too late, which `note` handles by falling back to git.
      this.baselinesByTurn.get(turnId)?.get(root.rootId)?.note(path);
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
    this.sendFileEditFrame(taskId, turnId, root.rootId, root.label, path, safeText, options, null);
    // The baseline can require a git call, so it is never waited for: the text goes out now and the
    // frame that carries the diff follows when there is one. Frames are cumulative, so the view
    // simply gains its diff. Only for a settled body — a diff recomputed against a half-written file
    // would show every unfinished line as a change.
    if (!options.complete) return;
    const baselines = this.baselinesByTurn.get(turnId)?.get(root.rootId);
    if (baselines === undefined) return;
    void baselines
      .get(path)
      .then((baseline) => {
        // Nothing to compare against, or the file is unchanged: no second frame, no wasted repaint.
        if (baseline === null || baseline === safeText) return;
        this.sendFileEditFrame(
          taskId,
          turnId,
          root.rootId,
          root.label,
          path,
          safeText,
          options,
          baseline,
        );
      })
      .catch(() => undefined);
  }

  private sendFileEditFrame(
    taskId: string,
    turnId: string,
    rootId: string,
    rootLabel: string,
    path: string,
    text: string,
    options: { complete: boolean; source: 'stream' | 'disk' },
    baseline: string | null,
  ): void {
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) return;
    this.window.webContents.send(
      IPC_CHANNELS.fileEditEvent,
      fileEditFrameSchema.parse({
        taskId,
        turnId,
        rootId,
        rootLabel,
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
    const workspace = this.turnWorkspaceByTurn.get(turnId);
    if (workspace === undefined) return;
    const inside: Array<FileChange & { rootPath: string }> = [];
    for (const change of changes) {
      const rooted = resolveTurnRootedPath(workspace, change.path);
      if (rooted !== null)
        inside.push({
          path: rooted.path,
          kind: change.kind,
          rootId: rooted.root.rootId,
          rootLabel: rooted.root.label,
          rootPath: rooted.root.path,
        });
    }
    if (inside.length === 0) return;
    const event = this.persistence.recordFileChanges({
      taskId,
      turnId,
      changes: inside.map(({ rootId, rootLabel, path, kind }) => ({
        rootId,
        rootLabel,
        path,
        kind,
      })),
    });
    if (event !== null) this.publish(event);
    // Codex reports no body at all while it writes (verified on 0.144.4: `file_change` carries only
    // path and kind, and apply_patch writes to a temp file and renames, so there is nothing to tail
    // either). Reading the result back is the only way to show its content — clearly marked
    // `source: 'disk'` so the UI does not present it as live typing. Claude streams instead, and its
    // frames have already arrived by now, so re-reading would only overwrite the live body with the
    // same bytes.
    for (const change of inside) {
      if (change.kind === 'delete') continue;
      if (this.fileEditByKey.has(`${turnId}\u0000${change.rootId}\u0000${change.path}`)) continue;
      const body = readWorkspaceTextFile(change.rootPath, change.path);
      if (body !== null)
        this.pushFileEdit(taskId, turnId, resolvePath(change.rootPath, change.path), body, {
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
        if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) return;
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
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) return;
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

function providerTurnCallId(turnId: string, ordinal: number): string {
  const suffix = `:provider-call:${ordinal}`;
  return `${turnId.slice(0, 256 - suffix.length)}${suffix}`;
}

function mergeProviderTurnUsage(
  current: NormalizedProviderUsage | undefined,
  next: NormalizedProviderUsage,
): NormalizedProviderUsage {
  if (current === undefined) return next;
  const add = (left: number | null, right: number | null): number | null =>
    left === null && right === null ? null : (left ?? 0) + (right ?? 0);
  return {
    inputTokens: add(current.inputTokens, next.inputTokens),
    outputTokens: add(current.outputTokens, next.outputTokens),
    cacheReadTokens: add(current.cacheReadTokens, next.cacheReadTokens),
    cacheWriteTokens: add(current.cacheWriteTokens, next.cacheWriteTokens),
    reasoningTokens: add(current.reasoningTokens, next.reasoningTokens),
    providerCost:
      current.providerCost !== null &&
      next.providerCost !== null &&
      current.providerCost.currency === next.providerCost.currency
        ? {
            amount: current.providerCost.amount + next.providerCost.amount,
            currency: current.providerCost.currency,
          }
        : (current.providerCost ?? next.providerCost),
    source:
      current.source === 'unknown'
        ? next.source
        : next.source === 'unknown' || current.source === next.source
          ? current.source
          : 'runtime_observed',
  };
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
  constructor(readonly kind: 'codex' | 'claude' | 'provider' = 'codex') {
    super();
  }
}

export function invalidModelUserMessage(kind: 'codex' | 'claude' | 'provider'): string {
  if (kind === 'claude') return '選択したモデルは現在のClaude CLIで利用できません。';
  if (kind === 'provider') return '選択したモデルは現在のProvider Connectionで利用できません。';
  return '選択したモデルは現在のCodex CLIで利用できません。';
}

export function shouldBlockProviderLeaderCompletion(
  teamTurn: boolean,
  hasUnfinishedTeamWork: boolean,
): boolean {
  return teamTurn && hasUnfinishedTeamWork;
}

export function shouldFailRequiredTeamTurn(teamRequired: boolean, workerCount: number): boolean {
  return teamRequired && workerCount === 0;
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

function providerModelsForBuiltin(
  connectionId: string,
  connectionDisplayName: string,
  providerId: string,
  models: readonly CodexModelOption[],
  available: boolean,
  checkedAt: string,
): ProviderModel[] {
  const unknown = { value: null, source: 'unknown' as const };
  return models.map((model) => ({
    connectionId,
    connectionDisplayName,
    providerId,
    modelId: model.id,
    displayName: model.displayName,
    available,
    availabilityCheckedAt: checkedAt,
    contextWindow: unknown,
    maxOutputTokens: unknown,
    toolCalling: unknown,
    structuredOutput: unknown,
    multimodalInput: unknown,
    reasoning: unknown,
  }));
}

function assertUniqueProviderTools<T extends { name: string }>(tools: readonly T[]): readonly T[] {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new Error(`Provider tool name collision: ${tool.name}`);
    names.add(tool.name);
  }
  return Object.freeze([...tools]);
}

export function providerWorkspaceToolsEligible(
  teamTurn: boolean,
  workspaceRootCount: number,
  toolCalling: boolean | null | undefined,
): boolean {
  return !teamTurn && workspaceRootCount > 0 && toolCalling !== false;
}

export function shouldRetryProviderWithoutTools(input: {
  ordinal: number;
  workspaceToolsBound: boolean;
  toolCalling: boolean | null | undefined;
  errorCategory: NormalizedProviderError['category'];
  toolCallCount: number;
  outputLength: number;
}): boolean {
  return (
    input.ordinal === 1 &&
    input.workspaceToolsBound &&
    input.toolCalling == null &&
    input.errorCategory === 'invalid_request' &&
    input.toolCallCount === 0 &&
    input.outputLength === 0
  );
}

function providerWorkspaceToolFailure(error: unknown): string {
  if (error instanceof ToolAuthorizationDeniedError)
    return providerToolErrorContent('PERMISSION_DENIED', error.authorization.reason);
  if (error instanceof WorkspaceToolRejection)
    return providerToolErrorContent(error.code, error.message);
  secureLogger.error('Provider workspace tool execution failed', { error });
  return providerToolErrorContent('TOOL_EXECUTION_FAILED', 'Workspace tool execution failed');
}

function providerToolErrorContent(code: string, message: string): string {
  return redactSecrets(JSON.stringify({ ok: false, error: { code, message } }));
}

function isCommittedProviderWorkspaceMutation(
  result: unknown,
): result is Readonly<{
  rootId: string;
  path: string;
  kind: 'add' | 'update';
  state: 'committed';
}> {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return false;
  const record = result as Record<string, unknown>;
  return (
    record['state'] === 'committed' &&
    (record['kind'] === 'add' || record['kind'] === 'update') &&
    typeof record['rootId'] === 'string' &&
    typeof record['path'] === 'string'
  );
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

function primaryWorkspacePath(workspace: EffectiveWorkspaceSet): string | null {
  return workspace.roots.find(({ rootId }) => rootId === workspace.primaryRootId)?.path ?? null;
}

export function resolveEffectiveWorkspaceRoot(
  workspace: EffectiveWorkspaceSet,
  requestedRootId: string,
): EffectiveWorkspaceSet['roots'][number] | null {
  const rootId = requestedRootId === 'legacy-primary' ? workspace.primaryRootId : requestedRootId;
  if (rootId === null) return null;
  return workspace.roots.find((root) => root.rootId === rootId) ?? null;
}

function toRuntimeWorkspaceSet(workspace: EffectiveWorkspaceSet): RuntimeWorkspaceSet {
  return {
    primaryRootId: workspace.primaryRootId,
    roots: workspace.roots.map(({ rootId, path, label, role }) => ({
      rootId,
      path,
      label,
      role,
    })),
    digest: workspace.digest,
  };
}

function resolveTurnRootedPath(
  workspace: EffectiveWorkspaceSet,
  absolutePath: string,
): { root: EffectiveWorkspaceSet['roots'][number]; path: string } | null {
  for (const root of workspace.roots) {
    const path = relativizeWorkspacePath(root.path, absolutePath, resolvePath, relativePath);
    if (path !== null) return { root, path };
  }
  return null;
}

export async function verifyTurnWorkspaceIdentities(
  workspace: EffectiveWorkspaceSet,
  expected: ReadonlyMap<string, string>,
  resolveIdentity: (
    path: string,
  ) => Promise<{ rootIdentityDigest: string }> = workspaceMutationBinding,
): Promise<void> {
  if (expected.size !== workspace.roots.length)
    throw new Error('Turn Workspace snapshot identity set is incomplete');
  for (const root of workspace.roots) {
    const binding = await resolveIdentity(root.path);
    if (binding.rootIdentityDigest !== expected.get(root.rootId))
      throw new Error('Turn Workspace root identity changed');
  }
}

async function canonicalProjectFolderBindings(
  folders: readonly ProjectFolderInput[],
): Promise<ProjectFolderBinding[]> {
  if (folders.length > 16) throw new InvalidProjectError('Project folder limit reached');
  return Promise.all(
    folders.map(async (folder) => {
      const binding = await workspaceMutationBinding(folder.path);
      return {
        id: folder.id,
        path: binding.canonicalPath,
        canonicalPath: binding.canonicalPath,
        label: folder.label?.trim() || basename(binding.canonicalPath) || binding.canonicalPath,
        role: folder.role,
        workspaceKey: binding.workspaceKey,
        rootIdentityDigest: binding.rootIdentityDigest,
      };
    }),
  );
}

async function confirmHomeDirectoryAccess(
  window: BrowserWindow,
  canonicalPaths: readonly string[],
): Promise<void> {
  if (canonicalPaths.length === 0) return;
  const canonicalHome = (await workspaceMutationBinding(homedir())).canonicalPath;
  if (!canonicalPaths.some((path) => requiresHomeDirectoryConfirmation(path, canonicalHome)))
    return;
  const confirmation = await dialog.showMessageBox(window, {
    type: 'warning',
    buttons: ['許可する', 'キャンセル'],
    defaultId: 1,
    cancelId: 1,
    title: 'ホームフォルダへのアクセス',
    message: 'ホームフォルダ全体をProjectに追加しますか？',
    detail: '広い範囲のファイルが読み書き対象になります。',
  });
  if (confirmation.response !== 0)
    throw new InvalidProjectError('Home directory access was canceled');
}

export function requiresHomeDirectoryConfirmation(
  canonicalSelectedPath: string,
  canonicalHomePath: string,
): boolean {
  const relative = relativePath(canonicalSelectedPath, canonicalHomePath);
  return (
    relative === '' ||
    (!relative.startsWith(`..${sep}`) && relative !== '..' && !isAbsolute(relative))
  );
}

async function projectFolderHealth(
  path: string,
  expectedIdentity: string | undefined,
): Promise<ProjectFolder['status']> {
  try {
    const binding = await workspaceMutationBinding(path);
    return expectedIdentity === undefined || binding.rootIdentityDigest !== expectedIdentity
      ? 'identity_changed'
      : 'available';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    return 'unreadable';
  }
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
  if (error instanceof ProjectConflictError)
    return {
      code: 'OPERATION_CONFLICT',
      userMessage: 'Projectが別の操作で更新されました。最新状態を読み直してください。',
      retryable: true,
    };
  if (error instanceof ProjectFolderMutationBlockedError)
    return {
      code: 'OPERATION_CONFLICT',
      userMessage: '実行中または復旧中の作業があるため、Projectのフォルダを変更できません。',
      retryable: true,
    };
  if (error instanceof ProjectArchivedError)
    return {
      code: 'INVALID_REQUEST',
      userMessage: 'アーカイブ済みProjectにはTaskを追加できません。',
      retryable: false,
    };
  if (error instanceof TaskAssignmentBlockedError)
    return {
      code: 'INVALID_REQUEST',
      userMessage: 'Teamの実行またはMissionが進行中のため、Taskを移動できません。',
      retryable: false,
    };
  if (error instanceof ReferenceInUseError)
    return {
      code: 'REFERENCE_IN_USE',
      userMessage: 'このTaskの参照ファイルをProjectから削除してから移動してください。',
      retryable: false,
    };
  if (error instanceof InvalidProjectError)
    return {
      code: 'INVALID_REQUEST',
      userMessage: 'Projectの入力内容を確認してください。',
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
  if (error instanceof ProviderSecretStorageUnavailableError)
    return {
      code: 'RUNTIME_UNAVAILABLE',
      userMessage:
        'OSの安全な保管領域を利用できません。macOSのログインキーチェーンを確認してから再試行してください。',
      retryable: true,
    };
  if (error instanceof InvalidModelError)
    return {
      code: 'INVALID_REQUEST',
      userMessage: invalidModelUserMessage(error.kind),
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
      code: 'USER_CANCELED',
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
  if (error instanceof SkillSettingsError)
    return {
      code:
        error.code === 'PREVIEW_EXPIRED'
          ? 'OPERATION_CONFLICT'
          : error.code === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : 'INVALID_REQUEST',
      userMessage: error.message,
      retryable: error.code === 'PREVIEW_EXPIRED' || error.code === 'SOURCE_CHANGED',
    };
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

function shouldSealBuiltinTeamSkill(text: string, skills: readonly PersistedTurnSkill[]): boolean {
  return isTeamScenarioInput(text) || skills.some(({ selection }) => selection.kind === 'team');
}

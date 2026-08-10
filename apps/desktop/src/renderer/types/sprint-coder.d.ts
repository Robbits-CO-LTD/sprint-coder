// Contract shared with Main/Preload (owned by backend team). Renderer only consumes this shape.
// Keep in sync with docs/PRODUCT_AND_TECHNICAL_DESIGN.md and the preload implementation.
//
// v2: adds Task pin/archive/goal, workspace binding, per-task draft persistence, and the
// Queue/Steer/Stop&Send input-queue surface (FR-RUN-12/13, FR-COMP-05, FR-SET-03).
// The backend may still only implement the v1 subset of this contract at runtime; renderer
// code must runtime-check `typeof window.sprintCoder?.x?.y === 'function'` before calling any v2-only
// method and degrade gracefully when it is absent (see store/appStore.ts).

export type GoalSummary = {
  objective: string;
  status: 'active' | 'paused' | 'completed' | 'blocked';
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  startedAt: string;
  updatedAt: string;
};

export type TaskSummary = {
  id: string;
  projectId: string | null;
  title: string;
  pinned: boolean;
  archived: boolean;
  goal: string | null;
  goalState: GoalSummary | null;
  workspacePath: string | null;
  localOnly: boolean;
  hasConversation?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProjectSummary = {
  id: string;
  name: string;
  archived: boolean;
  revision: number;
  taskCount: number;
  folderCount?: number;
  primaryFolder?: { id: string; path: string; label: string } | null;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectFolder = {
  id: string;
  projectId: string;
  path: string;
  label: string;
  role: 'primary' | 'secondary';
  ordinal: number;
  status: 'available' | 'missing' | 'unreadable' | 'identity_changed';
};

export type ProjectFolderInput = {
  id?: string;
  path: string;
  label?: string;
  role: 'primary' | 'secondary';
};

export type EffectiveWorkspaceSet = {
  source: 'project' | 'task' | 'none';
  projectId: string | null;
  primaryRootId: string | null;
  roots: Array<{
    rootId: string;
    path: string;
    label: string;
    role: 'primary' | 'secondary';
    status: 'available' | 'missing' | 'unreadable' | 'identity_changed';
  }>;
  digest: string;
};

export type ProjectReference = {
  id: string;
  projectId: string;
  sourceTaskId: string | null;
  projectRootId: string | null;
  relativePath: string;
  enabled: boolean;
  revision: number;
  lastSealedDigest: string | null;
  status:
    | 'healthy'
    | 'changed'
    | 'missing'
    | 'unreadable'
    | 'workspace_changed'
    | 'too_large'
    | 'non_text';
  currentDigest: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectMemory = {
  id: string;
  projectId: string;
  sourceTaskId: string;
  sourceTurnId: string;
  content: string;
  createdBy: 'user' | 'assistant';
  status: 'active' | 'disabled';
  revision: number;
  localOnly: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ChatMessage = {
  id: string;
  taskId: string;
  turnId: string | null;
  author: 'user' | 'assistant' | 'system';
  content: string;
  workContent?: string | null;
  createdAt: string;
};

export type TurnStage =
  'understanding' | 'planning' | 'executing' | 'waiting_approval' | 'synthesizing';

export type ApprovalDecision = 'allow_once' | 'allow_task' | 'deny';
export type Capability =
  | 'workspace.read'
  | 'workspace.write'
  | 'filesystem.external.read'
  | 'filesystem.external.write'
  | 'shell.execute'
  | 'network.fetch'
  | 'external.open'
  | 'secret.use'
  | 'provider.egress';
export type ApprovalSummary = {
  id: string;
  taskId: string;
  turnId: string;
  callId: string;
  state: 'pending' | 'resolved' | 'canceled' | 'stale' | 'expired';
  decision: ApprovalDecision | null;
  revision: number;
  policyEpoch: number;
  toolName: string;
  reason: string;
  target: string;
  impact: string;
  execution: string;
  risk: 'low' | 'medium' | 'high';
  capability: Capability;
  challenge: string;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
};

export type AutoPermissionDecision = {
  id: string;
  taskId: string;
  turnId: string;
  callId: string;
  reviewRequestId: string;
  capability: Capability;
  source: 'policy' | 'narrow_allow' | 'reviewer';
  decision: 'allow' | 'allow_once' | 'deny';
  outcome: string;
  reason: string;
  risk: 'low' | 'medium' | 'high';
  model: string;
  templateVersion: string;
  requestFingerprint: string;
  executionSpecDigest: string;
  inputDigest: string;
  policyEpoch: number;
  createdAt: string;
};

export type QueuedInput = { ordinal: number; text: string };

export type CommandSummary = {
  id: string;
  taskId: string;
  turnId: string;
  callId: string;
  specDigest: string;
  executable: string;
  argv: string[];
  cwd: string;
  envDelta: Record<string, string>;
  purpose: string;
  risk: 'low' | 'medium' | 'high';
  state: 'prepared' | 'starting' | 'running' | 'exited' | 'canceled' | 'failed' | 'interrupted';
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  outputBytes: number;
  truncated: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type CommandOutputRecord = {
  seq: number;
  stream: 'stdout' | 'stderr';
  text: string;
  byteLength: number;
};

export type CommandOutputPage = {
  commandId: string;
  items: CommandOutputRecord[];
  nextAfterSeq: number;
  eof: boolean;
  pageBytes: number;
};

/** Context-window usage breakdown (FR-CTX). Backend may not have wired this yet — renderer
 * must treat both `TurnSnapshot.contextUsage` and the `context.usage` event as optional/absent
 * and degrade to a "context —" display until real data arrives (see store/appStore.ts). */
export type ContextUsage = {
  usedTokens: number;
  hardCapTokens: number;
  projectTokens: number;
  fragments: {
    source: 'system' | 'history' | 'goal' | 'compaction' | 'background' | 'skill';
    tokens: number;
  }[];
};

export type ProjectInstruction = {
  instruction: string;
  revision: number;
  contextEpoch: number;
};

export type ProjectContextManifestSummary = {
  turnId: string;
  projectId: string | null;
  projectContextEpoch: number | null;
  candidateSnapshotDigest: string;
  sealedDigest: string;
  createdAt: string;
};

export type ProjectContextManifest = ProjectContextManifestSummary & {
  sealId: string;
  taskId: string;
  projectRevision: number | null;
  compacted: boolean;
  items: {
    itemId: string;
    kind: 'instruction' | 'memory' | 'reference';
    sourceTaskId: string | null;
    sourceTurnId: string | null;
    sourceReferenceId: string | null;
    candidateDigest: string;
    sealedDigest: string | null;
    included: boolean;
    exclusionReason: string | null;
    authority: 'user' | 'none';
    localOnly: boolean;
    content: string | null;
    capturedAt: string;
  }[];
};

export type TurnDiffEntry = {
  ordinal: number;
  kind: 'add' | 'update' | 'delete' | 'rename';
  path: string;
  destination: string | null;
  preHash: string | null;
  postHash: string | null;
  provenance: 'agent_edit';
  status: 'applied' | 'external_drift';
  actualHash: string | null;
};

export type TurnDiff = { turnId: string; entries: TurnDiffEntry[] };

/** An image a Runtime generated, after Main took custody of it (issue #11). Bytes are fetched
 * separately via `images.read` so a Turn snapshot never carries base64. */
export type GeneratedImage = {
  id: string;
  taskId: string;
  turnId: string;
  mimeType: 'image/png';
  byteLength: number;
  createdAt: string;
};

/** One file a Runtime changed during a Turn (issue #37). Workspace-relative — Main drops anything
 * that resolves outside the Workspace root rather than passing it here. */
export type FileChange = {
  rootId: string;
  rootLabel: string;
  path: string;
  kind: 'add' | 'update' | 'delete';
};
export type FileChangeRecord = { seq: number; turnId: string; changes: FileChange[] };
/** A file read in full for editing, or a refusal with its reason (issue #43). */
export type FileOpenResult = {
  rootId: string;
  path: string;
  text: string;
  digest: string;
  editable: boolean;
  reason: 'too_large' | 'binary' | 'not_a_file' | 'outside_workspace' | 'recovery_required' | null;
};
export type FileSaveResult = {
  outcome: 'saved' | 'conflict' | 'refused';
  digest: string | null;
  reason: 'too_large' | 'binary' | 'not_a_file' | 'outside_workspace' | 'io_error' | null;
  conflictPath: string | null;
};
/** A file's body as a Runtime writes it (issue #39). Pushed, never persisted — see contracts'
 * fileEditFrameSchema. `text` is the whole body so far, already secret-redacted by Main. */
export type FileEditFrame = {
  taskId: string;
  turnId: string;
  rootId: string;
  rootLabel: string;
  path: string;
  text: string;
  complete: boolean;
  /** `stream` is the model's text as it types (Claude only); `disk` is the file's contents re-read
   * when a watcher saw it change (Codex, and any write a CLI does not report). */
  source: 'stream' | 'disk';
  /** The file as this Turn found it (issue #41). Null when no honest comparison exists — see
   * contracts' fileEditFrameSchema. */
  baseline: string | null;
};

export type TurnEvent =
  | { type: 'turn.accepted'; taskId: string; turnId: string; seq: number; userMessage: ChatMessage }
  | { type: 'stage.changed'; taskId: string; turnId: string; seq: number; stage: TurnStage }
  | {
      type: 'message.delta';
      taskId: string;
      turnId: string;
      seq: number;
      messageId: string;
      delta: string;
    }
  | {
      type: 'turn.completed';
      taskId: string;
      turnId: string;
      seq: number;
      state: 'completed' | 'canceled' | 'failed' | 'interrupted';
      message?: ChatMessage;
      diff: TurnDiffEntry[];
      /** The concrete model id the Claude CLI actually resolved for this turn (e.g.
       * "claude-sonnet-5"), when the runtime reported one. Absent for Codex/mock turns. */
      resolvedModel?: string;
    }
  | {
      type: 'approval.requested' | 'approval.canceled' | 'approval.stale' | 'approval.expired';
      taskId: string;
      turnId: string;
      seq: number;
      approvalId: string;
      approval: ApprovalSummary;
    }
  | {
      type: 'approval.resolved';
      taskId: string;
      turnId: string;
      seq: number;
      approvalId: string;
      decision: ApprovalDecision;
      approval: ApprovalSummary;
    }
  | {
      type: 'command.started';
      taskId: string;
      turnId: string;
      seq: number;
      command: CommandSummary;
    }
  | {
      type: 'command.output';
      taskId: string;
      turnId: string;
      seq: number;
      commandId: string;
      outputSeq: number;
      stream: 'stdout' | 'stderr';
      text: string;
      byteLength: number;
    }
  | {
      type: 'command.completed';
      taskId: string;
      turnId: string;
      seq: number;
      command: CommandSummary;
    }
  | {
      type: 'permission.auto_decided';
      taskId: string;
      turnId: string;
      seq: number;
      autoDecision: AutoPermissionDecision;
    }
  | {
      type: 'delivery.acknowledged';
      taskId: string;
      turnId: string;
      seq: number;
      deliveryId: string;
      completionId: string;
      fragmentId: string;
    }
  | {
      type: 'skill.draft.created';
      taskId: string;
      turnId: string;
      seq: number;
      draft: import('@sprint-coder/contracts').SkillDraft;
    }
  | { type: 'queue.changed'; taskId: string; seq: number; queued: QueuedInput[] }
  | { type: 'context.usage'; taskId: string; seq: number; usage: ContextUsage }
  | {
      type: 'image.generated';
      taskId: string;
      turnId: string;
      seq: number;
      image: GeneratedImage;
    }
  | {
      type: 'file.saved';
      taskId: string;
      seq: number;
      rootId: string;
      rootLabel: string;
      path: string;
      byteLength: number;
    }
  | {
      type: 'files.changed';
      taskId: string;
      turnId: string;
      seq: number;
      changes: FileChange[];
    };

export type TurnSnapshot = {
  lastSeq: number;
  activeTurn: {
    turnId: string;
    stage: TurnStage;
    startedAtEpochMs: number;
    streamedText: string;
    messageId: string | null;
  } | null;
  queued: QueuedInput[];
  /** Absent until the backend implements context-usage tracking (graceful degrade). */
  contextUsage?: ContextUsage;
  pendingApprovals: ApprovalSummary[];
  latestTurnDiff: TurnDiff | null;
};

/** err.code values the IPC layer may attach to a rejected SprintCoderApi promise. */
export type SprintCoderErrorCode =
  'TURN_ACTIVE' | 'STEER_STALE' | 'RUNTIME_UNAVAILABLE' | 'STEER_UNSUPPORTED' | string;

export type RuntimeKind = 'mock' | 'codex' | 'claude';
/** A batch of the model's reasoning text (issue #17). Pushed, never persisted — see contracts'
 * reasoningBatchSchema for why. Already secret-redacted and batched by Main. */
export type ReasoningBatch = {
  taskId: string;
  turnId: string;
  text: string;
  truncated: boolean;
};
/** Outcome of this launch's database recovery pass (issue #9). */
export type DatabaseRecovery = {
  corruptionDetected: boolean;
  restoredFromBackup: boolean;
  freshStart: boolean;
  interruptedTurns: number;
};
export type RuntimeConnectionState = 'idle' | 'running' | 'failed';
/** Runtime process liveness. Pushed, never persisted — see contracts' runtimeStatusSchema. */
export type RuntimeStatus = {
  kind: RuntimeKind;
  state: RuntimeConnectionState;
  taskId: string | null;
  errorCode: string | null;
  userMessage: string | null;
};
export type EffortOption = { id: string; description: string };
export type CodexModelOption = {
  id: string;
  displayName: string;
  description: string;
  /** Reasoning levels this model advertises (Codex only; see contracts' effortOptionSchema). */
  efforts?: EffortOption[];
  defaultEffort?: string;
};
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode';
export type AccessPreset = 'ask' | 'auto' | 'full';
export type PermissionSettings = { preset: AccessPreset; policyEpoch: number };
/** Team-wide execution limits (contracts' `teamPolicySchema`). One per Team, always present — not
 * to be confused with `ManagerPolicy`, which is the per-Manager-Worker delegation cap. */
export type TeamPolicy = {
  /** 1-4. How deep the hierarchy under the Leader may grow. */
  maxAgentDepth: number;
  /** 1-8. How many Workers the Team may run at once. */
  maxConcurrentExecutions: number;
  allowWorkerDirectMessages: boolean;
  budgetMode: 'bounded' | 'unlimited';
};
export type TeamSummary = {
  id: string;
  taskId: string;
  state: 'draft' | 'forming' | 'active' | 'paused' | 'winding_down' | 'completed' | 'failed';
  leaderAgentId: string;
  budget: Record<string, unknown>;
  policy: TeamPolicy;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
export type TeamUsageTotals = {
  costCents: number;
  tokens: number;
  timeMs: number;
  toolCalls: number;
};
/** Delegation limits recorded for a Manager Worker (contracts' `managerPolicySchema`). Null on a
 * plain Worker — see `WorkerSummary.managerPolicy`. */
export type ManagerPolicy = {
  /** How many direct children this Manager may hire, or null for "no explicit cap". */
  maxDirectChildren: number | null;
  /** 1-4, matching the Team policy's own `maxAgentDepth` range. */
  maxDelegationDepth: number;
  allowManagerChildren: boolean;
};
export type WorkerSummary = {
  id: string;
  teamId: string;
  threadId: string;
  taskId: string;
  kind: 'leader' | 'worker';
  role: string;
  state: 'invited' | 'spawning' | 'ready' | 'busy' | 'waiting' | 'done' | 'failed' | 'stopped';
  objective: string | null;
  writeCapable: boolean;
  currentActivity: string | null;
  engine: 'mock' | 'codex' | 'claude';
  /** Provider Connection the Worker was hired against, or null when the backend recorded none. */
  connectionId: string | null;
  /** Provider id exactly as the backend persisted it — never derived from `engine` or the model. */
  requestedProvider: string | null;
  /** Model id the Worker was hired with, or null when the backend recorded none. */
  requestedModel: string | null;
  /** The agent that hired this Worker — the Leader's agent id, or a Manager Worker's id. Null when
   * the backend recorded none (pre-hierarchy rows); display and layout then treat the Leader as
   * the parent, since it is the only possible root. Never inferred from engine/provider/model. */
  parentAgentId: string | null;
  /** Distance from the Leader: 0 is the Leader itself, Workers are 1-4 (contracts clamp at 4). */
  depth: number;
  /** Whether this Worker may hire/delegate to children of its own — i.e. it is a Manager. */
  canDelegate: boolean;
  /** Delegation limits for a Manager, or null for a plain Worker. */
  managerPolicy: ManagerPolicy | null;
  liveOutput: string;
  reasoningActive: boolean;
  usage: TeamUsageTotals;
  createdAt: string;
  updatedAt: string;
};
export type TeamMessageSummary = {
  id: string;
  teamId: string;
  sourceAgentId: string;
  targetAgentId: string;
  sourceKind: 'leader' | 'worker';
  targetKind: 'leader' | 'worker';
  seq: number;
  state: 'created' | 'persisted' | 'dispatching' | 'delivered' | 'acknowledged';
  content: string;
  executionId: string | null;
  attemptId: string | null;
  deliveryState: 'persisted' | 'dispatched' | 'acked' | 'timedOut' | 'failed' | null;
  attempt: number;
  createdAt: string;
  updatedAt: string;
};
export type TeamExecutionSummary = {
  id: string;
  teamId: string;
  assigneeAgentId: string;
  createdByAgentId: string;
  accessMode: 'read-only' | 'workspace-write';
  state:
    | 'assigned'
    | 'queued'
    | 'waiting_verification'
    | 'waiting_rate_limit'
    | 'running'
    | 'waiting_resume'
    | 'completed'
    | 'failed'
    | 'canceled';
  instructionPreview: string;
  instructionRevision: number;
  queueOrdinal: number | null;
  queueReason:
    | 'global_concurrency'
    | 'connection_concurrency'
    | 'verification'
    | 'rate_limit'
    | 'budget'
    | 'recovery'
    | 'automatic_retry'
    | null;
  connectionId: string | null;
  requestedModel: string | null;
  attemptStartReason:
    'initial' | 'automatic_retry' | 'manual_resume' | 'steer' | 'app_restart' | null;
  lastProgressAt: string | null;
  terminalReason: string | null;
  missionId: string | null;
  missionStepOrdinal: number | null;
  missionStepCount: number | null;
  worktree: TeamMissionWorktreeSummary | null;
  isolation: TeamExecutionIsolation | null;
  assignedAt: string;
  queuedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};
export type TeamActivitySummary = {
  id: string;
  teamId: string;
  seq: number;
  type:
    | 'worker_hired'
    | 'task_assigned'
    | 'execution_queued'
    | 'execution_waiting'
    | 'execution_started'
    | 'execution_finished'
    | 'steered'
    | 'attempt_started'
    | 'attempt_finished'
    | 'worker_reported'
    | 'worker_stopped';
  actorAgentId: string | null;
  actorRole: string | null;
  subjectAgentId: string | null;
  subjectRole: string | null;
  executionId: string | null;
  attemptId: string | null;
  status: string | null;
  queueReason:
    | 'global_concurrency'
    | 'connection_concurrency'
    | 'verification'
    | 'rate_limit'
    | 'budget'
    | 'recovery'
    | 'automatic_retry'
    | null;
  attemptOrdinal: number | null;
  terminalReason: string | null;
  connectionId: string | null;
  requestedProvider: string | null;
  requestedModel: string | null;
  /** Free text the backend recorded for why this model/Connection was chosen. Up to 2,000
   * characters, so display surfaces clamp it rather than rendering it whole. */
  modelSelectionReason: string | null;
  recordedAt: string;
};
export type TeamMissionCheckpoint = {
  summary: string;
  changedFiles: string[];
  gitHead: string | null;
  workspaceDigest: string | null;
  recordedAt: string;
};
export type TeamMissionWorktreeSummary = {
  path: string;
  baseHead: string;
  state: 'created' | 'active' | 'ready' | 'integrated' | 'cleaned' | 'quarantined';
  workerHead: string | null;
  integratedHead: string | null;
  changedFiles: string[];
  reason: string | null;
};
export type TeamExecutionIsolation = {
  phase:
    | 'preparing'
    | 'running'
    | 'finalizing'
    | 'integrating'
    | 'waiting_resume'
    | 'completed'
    | 'quarantined';
  resumeKind: 'worker' | 'integration' | null;
  repositories: Array<{
    ordinal: number;
    repoPath: string;
    worktreePath: string;
    baseHead: string;
    workerHead: string | null;
    integratedHead: string | null;
    state: 'active' | 'ready' | 'integrated' | 'cleaned' | 'quarantined';
    changedFiles: string[];
  }>;
  roots: Array<{
    rootId: string;
    rootLabel: string;
    role: 'primary' | 'secondary';
    repositoryOrdinal: number;
    sourcePath: string;
    isolatedPath: string;
    identity: string;
    mutationKey: string;
  }>;
  reason: string | null;
};
export type TeamMissionSummary = {
  id: string;
  teamId: string;
  createdByAgentId: string;
  state: 'queued' | 'running' | 'waiting_resume' | 'completed' | 'failed' | 'canceled';
  objective: string;
  doneCriteria: string[];
  currentStepOrdinal: number;
  steps: {
    ordinal: number;
    executionId: string;
    workerId: string;
    objective: string;
    doneCriteria: string[];
    access: 'read-only' | 'workspace-write';
    state: TeamExecutionSummary['state'];
    checkpoint: TeamMissionCheckpoint | null;
    worktree: TeamMissionWorktreeSummary | null;
  }[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};
export type TeamDetail = {
  team: TeamSummary;
  workers: WorkerSummary[];
  messages: TeamMessageSummary[];
  executions: TeamExecutionSummary[];
  missions: TeamMissionSummary[];
  activities: TeamActivitySummary[];
  budgets: {
    scope: 'global' | 'team' | 'worker';
    kind: 'costCents' | 'tokens' | 'timeMs' | 'toolCalls' | 'spawnSlots';
    cap: number;
    committed: number;
    reserved: number;
  }[];
};

export type CanvasCamera = { x: number; y: number; scale: number };
export type CanvasNodePosition = { x: number; y: number };
export type CanvasView = {
  taskId: string;
  camera: CanvasCamera;
  nodePositions: Record<string, CanvasNodePosition>;
  revision: number;
  updatedAt: string;
};
export type CanvasViewSaveInput = {
  taskId: string;
  camera: CanvasCamera;
  nodePositions: Record<string, CanvasNodePosition>;
  revision: number;
};
export type CanvasViewSaveResult = { revision: number };

export interface SprintCoderApi {
  app: {
    getInfo(): Promise<{
      version: string;
      platform: string;
      recovery: DatabaseRecovery;
      settingsWorkspaceV2?: boolean;
      projectMultiFolderUx?: boolean;
    }>;
  };
  windowControls: {
    platform: string;
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    isMaximized(): Promise<boolean>;
    onMaximizedChanged(listener: (maximized: boolean) => void): () => void;
  };
  runtime: {
    subscribeStatus(listener: (status: RuntimeStatus) => void): () => void;
  };
  tasks: {
    list(): Promise<TaskSummary[]>;
    subscribe(listener: (task: TaskSummary) => void): () => void;
    create(input?: {
      title?: string;
      localOnly?: boolean;
      projectId?: string;
    }): Promise<TaskSummary>;
    messages(taskId: string): Promise<ChatMessage[]>;
    rename(taskId: string, title: string): Promise<TaskSummary>;
    setPinned(taskId: string, pinned: boolean): Promise<TaskSummary>;
    setArchived(taskId: string, archived: boolean): Promise<TaskSummary>;
    setGoal(taskId: string, goal: string): Promise<TaskSummary>;
    getDraft(taskId: string): Promise<string>;
    setDraft(taskId: string, draft: string): Promise<void>;
  };
  goals: {
    start(input: {
      taskId: string;
      objective: string;
      skills?: readonly TurnSkillSelection[];
    }): Promise<{ task: TaskSummary; turnId: string }>;
    pause(taskId: string): Promise<TaskSummary>;
    resume(
      taskId: string,
      skills?: readonly TurnSkillSelection[],
    ): Promise<{ task: TaskSummary; turnId: string }>;
    clear(taskId: string): Promise<TaskSummary>;
  };
  projects: {
    list(): Promise<ProjectSummary[]>;
    pickFolders(): Promise<
      { canceled: true } | { canceled: false; folders: Array<{ path: string; label: string }> }
    >;
    folders: {
      list(input: { projectId: string }): Promise<ProjectFolder[]>;
      replace(input: {
        projectId: string;
        expectedRevision: number;
        folders: ProjectFolderInput[];
      }): Promise<ProjectSummary>;
    };
    get(input: { projectId: string }): Promise<ProjectInstruction>;
    setInstruction(input: {
      projectId: string;
      expectedRevision: number;
      instruction: string;
    }): Promise<ProjectInstruction>;
    listContextManifests(input: { taskId: string }): Promise<ProjectContextManifestSummary[]>;
    getContextManifest(input: { taskId: string; turnId: string }): Promise<ProjectContextManifest>;
    references: {
      list(input: { projectId: string }): Promise<ProjectReference[]>;
      pick(input: {
        projectId: string;
        sourceTaskId?: string;
        projectRootId?: string;
      }): Promise<ProjectReference | null>;
      add(input: {
        projectId: string;
        sourceTaskId?: string;
        projectRootId?: string;
        relativePath: string;
      }): Promise<ProjectReference>;
      update(input: {
        referenceId: string;
        expectedRevision: number;
        enabled: boolean;
      }): Promise<ProjectReference>;
      remove(input: { referenceId: string; expectedRevision: number }): Promise<void>;
    };
    memories: {
      list(input: { projectId: string }): Promise<ProjectMemory[]>;
      createFromTurn(input: {
        projectId: string;
        sourceTurnId: string;
        content: string;
      }): Promise<ProjectMemory>;
      update(input: {
        memoryId: string;
        expectedRevision: number;
        content?: string;
        status?: 'active' | 'disabled';
      }): Promise<ProjectMemory>;
    };
    create(input: { name: string; folders?: ProjectFolderInput[] }): Promise<ProjectSummary>;
    update(input: {
      projectId: string;
      expectedRevision: number;
      name?: string;
      archived?: boolean;
    }): Promise<ProjectSummary>;
    assignTask(input: {
      projectId: string;
      taskId: string;
      expectedProjectId: string | null;
    }): Promise<TaskSummary>;
    unassignTask(input: { taskId: string; expectedProjectId: string | null }): Promise<TaskSummary>;
  };
  teams: {
    promote(taskId: string): Promise<TeamSummary>;
    get(taskId: string): Promise<TeamDetail | null>;
    updatePolicy(input: {
      taskId: string;
      policy: TeamSummary['policy'];
      expectedRevision: number;
    }): Promise<TeamDetail>;
    hireWorker(input: {
      taskId: string;
      role: string;
      objective: string;
      contextInheritancePolicy: 'none' | 'summary' | 'selected_items' | 'full_fork';
      writeCapable: boolean;
    }): Promise<WorkerSummary>;
    resumeMission(input: { taskId: string; missionId: string }): Promise<TeamMissionSummary>;
    resumeExecutionIntegration(input: { taskId: string; executionId: string }): Promise<TeamDetail>;
    sendToWorker(input: {
      taskId: string;
      targetAgentId: string;
      content: string;
    }): Promise<TeamMessageSummary>;
    stopWorker(input: { taskId: string; agentId: string }): Promise<WorkerSummary>;
    stopAll(taskId: string): Promise<TeamDetail>;
    subscribe(
      taskId: string,
      listener: (
        event:
          | { type: 'snapshot'; seq: number; detail: TeamDetail | null }
          | { type: 'updated'; seq: number; detail: TeamDetail },
      ) => void,
    ): () => void;
    getCanvasView(taskId: string): Promise<CanvasView | null>;
    saveCanvasView(input: CanvasViewSaveInput): Promise<CanvasViewSaveResult>;
  };
  workspace: {
    get(taskId: string): Promise<{ path: string; name: string } | null>;
    getEffective(taskId: string): Promise<EffectiveWorkspaceSet>;
    select(taskId: string): Promise<{ path: string; name: string } | null>;
  };
  turns: {
    start(input: {
      taskId: string;
      text: string;
      skills?: import('@sprint-coder/contracts').TurnSkillSelection[];
    }): Promise<{ turnId: string; renamedTask?: TaskSummary | undefined }>;
    cancel(input: { taskId: string; turnId: string }): Promise<void>;
    queue(input: {
      taskId: string;
      text: string;
      skills?: import('@sprint-coder/contracts').TurnSkillSelection[];
    }): Promise<{ ordinal: number }>;
    steer(input: { taskId: string; text: string; expectedTurnId: string }): Promise<void>;
    stopAndSend(input: {
      taskId: string;
      text: string;
      skills?: import('@sprint-coder/contracts').TurnSkillSelection[];
    }): Promise<void>;
    snapshot(taskId: string): Promise<TurnSnapshot>;
    subscribe(
      taskId: string,
      cb: (ev: TurnEvent) => void,
      opts?: { afterSeq?: number },
    ): () => void; // returns unsubscribe
  };
  reasoning: {
    subscribe(listener: (batch: ReasoningBatch) => void): () => void;
  };
  fileEdits: {
    subscribe(listener: (frame: FileEditFrame) => void): () => void;
  };
  files: {
    list(taskId: string): Promise<FileChangeRecord[]>;
    pick(taskId: string): Promise<FileOpenResult | null>;
    open(taskId: string, rootId: string, path: string): Promise<FileOpenResult>;
    recover(taskId: string, rootId: string, path: string): Promise<FileOpenResult>;
    save(input: {
      taskId: string;
      rootId: string;
      path: string;
      text: string;
      baseDigest: string;
    }): Promise<FileSaveResult>;
  };
  images: {
    list(taskId: string): Promise<GeneratedImage[]>;
    read(imageId: string): Promise<{ id: string; mimeType: 'image/png'; base64: string }>;
  };
  /** Runtime switch (Mock/Codex). Backend may not have wired this yet; renderer must
   * runtime-check `typeof window.sprintCoder?.settings?.getRuntime === 'function'` before use. */
  settings: {
    getRuntime(taskId?: string): Promise<{
      kind: RuntimeKind;
      codexAvailable: boolean;
      codexReadiness: 'ready' | 'authentication_required' | 'unavailable';
      claudeAvailable: boolean;
      claudeReadiness: 'ready' | 'authentication_required' | 'unavailable';
      model: string;
      models: CodexModelOption[];
      effort: ClaudeEffort;
      /** Codex reasoning level, already clamped by Main to the selected model's advertised set.
       * '' means no override (the `auto` model sentinel, or a model publishing no set). */
      codexEffort: string;
    }>;
    setRuntime(kind: RuntimeKind, taskId?: string): Promise<void>;
    setModel(model: string, taskId?: string): Promise<void>;
    setEffort(effort: ClaudeEffort): Promise<void>;
    setCodexEffort(effort: string): Promise<void>;
    getTeamModelResearch(): Promise<{ researchBeforeHiring: boolean }>;
    setTeamModelResearch(input: { researchBeforeHiring: boolean }): Promise<void>;
    getTeamModelSelectionGuidance(): Promise<
      import('@sprint-coder/contracts').TeamModelSelectionGuidance
    >;
    setTeamModelSelectionGuidance(
      input: import('@sprint-coder/contracts').TeamModelSelectionGuidance,
    ): Promise<void>;
    getTeamModelSettings(): Promise<import('@sprint-coder/contracts').TeamModelSettings>;
    setTeamModelRestriction(
      input: import('@sprint-coder/contracts').TeamModelRestriction,
    ): Promise<void>;
    getDefaultTeamPolicy(): Promise<import('@sprint-coder/contracts').TeamPolicy>;
    setDefaultTeamPolicy(policy: import('@sprint-coder/contracts').TeamPolicy): Promise<void>;
    scanSkills(): Promise<import('@sprint-coder/contracts').SkillScanResult>;
    previewSkill(
      provider: import('@sprint-coder/contracts').SkillProvider,
      skillId: string,
    ): Promise<import('@sprint-coder/contracts').SkillPreviewResult>;
    importSkill(previewId: string): Promise<import('@sprint-coder/contracts').SkillImportResult>;
    updateSkill(previewId: string): Promise<import('@sprint-coder/contracts').SkillImportResult>;
    setSkillEnabled(
      provider: import('@sprint-coder/contracts').SkillProvider,
      skillId: string,
      enabled: boolean,
    ): Promise<void>;
    removeSkill(
      provider: import('@sprint-coder/contracts').SkillProvider,
      skillId: string,
    ): Promise<void>;
  };
  skills: {
    list(): Promise<import('@sprint-coder/contracts').SkillCatalog>;
    getDraftSelection(
      taskId: string,
    ): Promise<import('@sprint-coder/contracts').TurnSkillSelection[]>;
    setDraftSelection(
      taskId: string,
      skills: import('@sprint-coder/contracts').TurnSkillSelection[],
    ): Promise<void>;
    listDrafts(): Promise<import('@sprint-coder/contracts').SkillDraft[]>;
    createDraft(
      input: import('@sprint-coder/contracts').SkillDraftCreateInput,
    ): Promise<import('@sprint-coder/contracts').SkillDraft>;
    installDraft(
      draftId: string,
      expectedDigest: string,
      confirmed: true,
    ): Promise<import('@sprint-coder/contracts').SkillCatalogItem>;
    discardDraft(draftId: string): Promise<void>;
    removeCreated(skillId: string, digest: string): Promise<void>;
    setCreatedEnabled(skillId: string, digest: string, enabled: boolean): Promise<void>;
    exportCreated(skillId: string, digest: string): Promise<string | null>;
  };
  models: {
    query(
      input: import('@sprint-coder/contracts').ModelCatalogQueryInput,
    ): Promise<import('@sprint-coder/contracts').ModelCatalogQueryResult>;
    setSelection(
      taskId: string,
      selection: import('@sprint-coder/contracts').ModelSelection,
    ): Promise<import('@sprint-coder/contracts').ModelSelection>;
  };
  providers: {
    listConnections(): Promise<import('@sprint-coder/contracts').ProviderConnection[]>;
    listProfiles(): Promise<import('@sprint-coder/contracts').ProviderProfile[]>;
    createOpenAIConnection(
      input: import('@sprint-coder/contracts').OpenAIConnectionCreateInput,
    ): Promise<import('@sprint-coder/contracts').ProviderConnection>;
    createOpenRouterConnection(
      input: import('@sprint-coder/contracts').OpenRouterConnectionCreateInput,
    ): Promise<import('@sprint-coder/contracts').ProviderConnection>;
    createAnthropicConnection(
      input: import('@sprint-coder/contracts').AnthropicConnectionCreateInput,
    ): Promise<import('@sprint-coder/contracts').ProviderConnection>;
    createGeminiConnection(
      input: import('@sprint-coder/contracts').GeminiConnectionCreateInput,
    ): Promise<import('@sprint-coder/contracts').ProviderConnection>;
    createXAIConnection(
      input: import('@sprint-coder/contracts').XAIConnectionCreateInput,
    ): Promise<import('@sprint-coder/contracts').ProviderConnection>;
    createProfileConnection(
      input: import('@sprint-coder/contracts').ProviderProfileConnectionCreateInput,
    ): Promise<import('@sprint-coder/contracts').ProviderConnection>;
    verifyConnection(
      connectionId: string,
    ): Promise<import('@sprint-coder/contracts').ProviderConnection>;
    lowerRateLimits(
      input: import('@sprint-coder/contracts').ProviderConnectionRateLimitLowerInput,
    ): Promise<import('@sprint-coder/contracts').ProviderConnection>;
  };
  permissions: {
    get(taskId: string): Promise<PermissionSettings>;
    listAutoDecisions(taskId: string): Promise<AutoPermissionDecision[]>;
    set(
      taskId: string,
      preset: AccessPreset,
      expectedPolicyEpoch: number,
    ): Promise<PermissionSettings>;
  };
  approvals: {
    listPending(taskId: string): Promise<ApprovalSummary[]>;
    listRecent(taskId: string): Promise<ApprovalSummary[]>;
    resolve(input: {
      taskId: string;
      approvalId: string;
      decision: ApprovalDecision;
      expectedRevision: number;
      expectedPolicyEpoch: number;
      challenge: string;
    }): Promise<ApprovalSummary>;
  };
  commands: {
    list(taskId: string): Promise<CommandSummary[]>;
    outputPage(input: {
      taskId: string;
      commandId: string;
      afterSeq: number;
      limit: number;
      maxBytes: number;
    }): Promise<CommandOutputPage>;
    outputTail(input: {
      taskId: string;
      commandId: string;
      maxBytes: number;
    }): Promise<CommandOutputPage>;
  };
}

declare global {
  interface Window {
    sprintCoder?: SprintCoderApi;
  }
}

export {};

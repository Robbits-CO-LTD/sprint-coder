// Contract shared with Main/Preload (owned by backend team). Renderer only consumes this shape.
// Keep in sync with docs/PRODUCT_AND_TECHNICAL_DESIGN.md and the preload implementation.
//
// v2: adds Task pin/archive/goal, workspace binding, per-task draft persistence, and the
// Queue/Steer/Stop&Send input-queue surface (FR-RUN-12/13, FR-COMP-05, FR-SET-03).
// The backend may still only implement the v1 subset of this contract at runtime; renderer
// code must runtime-check `typeof window.vibe?.x?.y === 'function'` before calling any v2-only
// method and degrade gracefully when it is absent (see store/appStore.ts).

export type TaskSummary = {
  id: string;
  title: string;
  pinned: boolean;
  archived: boolean;
  goal: string | null;
  workspacePath: string | null;
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
  fragments: {
    source: 'system' | 'history' | 'goal' | 'compaction' | 'background';
    tokens: number;
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
  | { type: 'queue.changed'; taskId: string; seq: number; queued: QueuedInput[] }
  | { type: 'context.usage'; taskId: string; seq: number; usage: ContextUsage };

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

/** err.code values the IPC layer may attach to a rejected VibeApi promise. */
export type VibeErrorCode =
  'TURN_ACTIVE' | 'STEER_STALE' | 'RUNTIME_UNAVAILABLE' | 'STEER_UNSUPPORTED' | string;

export type RuntimeKind = 'mock' | 'codex';
export type CodexModelOption = { id: string; displayName: string; description: string };
export type AccessPreset = 'ask' | 'auto' | 'full';
export type PermissionSettings = { preset: AccessPreset; policyEpoch: number };
export type TeamSummary = {
  id: string;
  taskId: string;
  state: 'draft' | 'forming' | 'active' | 'paused' | 'winding_down' | 'completed' | 'failed';
  leaderAgentId: string;
  budget: Record<string, unknown>;
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
  deliveryState: 'persisted' | 'dispatched' | 'acked' | 'timedOut' | 'failed' | null;
  attempt: number;
  createdAt: string;
  updatedAt: string;
};
export type TeamDetail = {
  team: TeamSummary;
  workers: WorkerSummary[];
  messages: TeamMessageSummary[];
  budgets: {
    scope: 'global' | 'team' | 'worker';
    kind: 'costCents' | 'tokens' | 'timeMs' | 'toolCalls' | 'spawnSlots';
    cap: number;
    committed: number;
    reserved: number;
  }[];
};

export interface VibeApi {
  app: { getInfo(): Promise<{ version: string; platform: string }> };
  tasks: {
    list(): Promise<TaskSummary[]>;
    create(input?: { title?: string; localOnly?: boolean }): Promise<TaskSummary>;
    messages(taskId: string): Promise<ChatMessage[]>;
    rename(taskId: string, title: string): Promise<TaskSummary>;
    setPinned(taskId: string, pinned: boolean): Promise<TaskSummary>;
    setArchived(taskId: string, archived: boolean): Promise<TaskSummary>;
    setGoal(taskId: string, goal: string): Promise<TaskSummary>;
    getDraft(taskId: string): Promise<string>;
    setDraft(taskId: string, draft: string): Promise<void>;
  };
  teams: {
    promote(taskId: string): Promise<TeamSummary>;
    get(taskId: string): Promise<TeamDetail | null>;
    hireWorker(input: {
      taskId: string;
      role: string;
      objective: string;
      contextInheritancePolicy: 'none' | 'summary' | 'selected_items' | 'full_fork';
      writeCapable: boolean;
    }): Promise<WorkerSummary>;
    sendToWorker(input: {
      taskId: string;
      targetAgentId: string;
      content: string;
    }): Promise<TeamMessageSummary>;
    stopWorker(input: { taskId: string; agentId: string }): Promise<WorkerSummary>;
    stopAll(taskId: string): Promise<TeamDetail>;
    subscribe(
      taskId: string,
      listener: (event: { type: 'updated'; detail: TeamDetail }) => void,
    ): () => void;
  };
  workspace: {
    get(taskId: string): Promise<{ path: string; name: string } | null>;
    select(taskId: string): Promise<{ path: string; name: string } | null>;
  };
  turns: {
    start(input: { taskId: string; text: string }): Promise<{ turnId: string }>;
    cancel(input: { taskId: string; turnId: string }): Promise<void>;
    queue(input: { taskId: string; text: string }): Promise<{ ordinal: number }>;
    steer(input: { taskId: string; text: string; expectedTurnId: string }): Promise<void>;
    stopAndSend(input: { taskId: string; text: string }): Promise<void>;
    snapshot(taskId: string): Promise<TurnSnapshot>;
    subscribe(
      taskId: string,
      cb: (ev: TurnEvent) => void,
      opts?: { afterSeq?: number },
    ): () => void; // returns unsubscribe
  };
  /** Runtime switch (Mock/Codex). Backend may not have wired this yet; renderer must
   * runtime-check `typeof window.vibe?.settings?.getRuntime === 'function'` before use. */
  settings: {
    getRuntime(): Promise<{
      kind: RuntimeKind;
      codexAvailable: boolean;
      model: string;
      models: CodexModelOption[];
    }>;
    setRuntime(kind: RuntimeKind): Promise<void>;
    setModel(model: string): Promise<void>;
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
    vibe?: VibeApi;
  }
}

export {};

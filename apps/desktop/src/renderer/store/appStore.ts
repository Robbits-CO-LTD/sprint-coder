import { create } from 'zustand';
import type {
  AccessPreset,
  AutoPermissionDecision,
  ApprovalDecision,
  ApprovalSummary,
  ChatMessage,
  ClaudeEffort,
  ContextUsage,
  CodexModelOption,
  CommandSummary,
  CommandOutputRecord,
  FileChange,
  GeneratedImage,
  QueuedInput,
  PermissionSettings,
  DatabaseRecovery,
  RuntimeKind,
  RuntimeStatus,
  TaskSummary,
  TeamDetail,
  TurnDiff,
  TurnEvent,
  TurnStage,
} from '../types/sprint-coder';
import { STAGE_LABEL } from '../lib/stages';
import { advanceStageIndex } from '../lib/turn-progress';
import { appendReasoning, pruneReasoning } from '../lib/reasoning-buffer';
import {
  appendCommandOutput,
  projectCommandTail,
  type CommandTailProjection,
} from './command-projection';

export type TurnStatus =
  'running' | 'canceling' | 'completed' | 'canceled' | 'failed' | 'interrupted';

export type TurnRuntimeState = {
  turnId: string;
  stage: TurnStage;
  /** Highest stage index reached, clamped so it never decreases (issue #16). `stage` alone is not
   * enough: `waiting_approval` sits between `executing` and `synthesizing` in STAGE_ORDER, so a turn
   * that returns to `executing` for a later tool would make a stage-derived gauge walk backwards. */
  reachedStageIndex: number;
  status: TurnStatus;
  startedAt: number;
  streamingMessageId: string | null;
  streamingContent: string;
};

export type WorkspaceInfo = { path: string; name: string };

export type RuntimeState = {
  kind: RuntimeKind;
  codexAvailable: boolean;
  claudeAvailable: boolean;
  model: string;
  models: CodexModelOption[];
  effort: ClaudeEffort;
  /** Codex reasoning level, already clamped by Main to the selected model's advertised set (issue
   * #6). '' means no override — the `auto` model sentinel resolves its model inside the CLI, so
   * there is no advertised set to pick from and the CLI's own per-model default applies. Kept
   * separate from `effort` because the two providers do not share a value space. */
  codexEffort: string;
  /** The concrete model id the Claude CLI actually resolved on the most recently completed Claude
   * turn (e.g. "claude-sonnet-5"), surfaced in the model chip's tooltip. Not per-task — mirrors
   * the rest of `RuntimeState`'s global-only design — and cleared back to undefined only by a
   * fresh `loadRuntime()` never repopulating it (it simply persists until the next Claude turn
   * completes with a resolved model). */
  resolvedModel?: string;
};

export type CommandCardState = Readonly<{
  command: CommandSummary;
  tail: CommandTailProjection;
}>;

// Re-exported so existing importers keep working; the definitions moved to lib/stages.ts to break
// the cycle with lib/turn-progress.ts (issue #16).
export { STAGE_LABEL, STAGE_ORDER } from '../lib/stages';

function finalStateLabel(status: TurnStatus): string {
  switch (status) {
    case 'completed':
      return '完了しました';
    case 'canceled':
      return '中止しました';
    case 'failed':
      return '失敗しました';
    case 'interrupted':
      return '中断されました（再起動時に復元されました）';
    default:
      return '';
  }
}

type AppState = {
  sprintCoderAvailable: boolean;
  initialized: boolean;
  loadingTasks: boolean;
  loadingMessages: boolean;
  error: string | null;

  tasks: TaskSummary[];
  selectedTaskId: string | null;
  messagesByTask: Record<string, ChatMessage[]>;
  turnByTask: Record<string, TurnRuntimeState | undefined>;
  queuedByTask: Record<string, QueuedInput[]>;
  /** Context-window usage breakdown per task (FR-CTX). Absent while the backend hasn't sent a
   * `TurnSnapshot.contextUsage` or `context.usage` event yet — the ContextBar degrades to a
   * "context —" placeholder in that case. */
  contextUsageByTask: Record<string, ContextUsage | undefined>;
  lastSeqByTask: Record<string, number>;
  sendingByTask: Record<string, boolean>;
  draftByTask: Record<string, string>;
  workspaceByTask: Record<string, WorkspaceInfo | null | undefined>;
  permissionByTask: Record<string, PermissionSettings | undefined>;
  approvalsByTask: Record<string, ApprovalSummary[]>;
  approvalHistoryByTask: Record<string, ApprovalSummary[]>;
  autoDecisionsByTask: Record<string, AutoPermissionDecision[]>;
  commandsByTask: Record<string, CommandCardState[]>;
  turnDiffByTask: Record<string, TurnDiff | undefined>;
  /** Images generated per task, oldest first (issue #11). Metadata only — bytes are fetched by the
   * card that displays them, so switching tasks never drags base64 through the store. */
  imagesByTask: Record<string, GeneratedImage[]>;
  /** Files each Turn changed, newest last (issue #37). Keyed by task and kept in arrival order,
   * which is the order the edits actually happened — the Inspector reads the tail of this and the
   * timeline renders one entry per tool call. */
  fileChangesByTask: Record<string, { seq: number; turnId: string; changes: FileChange[] }[]>;
  resolvingApprovalIds: Record<string, boolean | undefined>;
  pendingOptimisticIdByTask: Record<string, string | undefined>;
  teamByTask: Record<string, TeamDetail | null | undefined>;
  teamViewOpen: boolean;
  teamBusy: boolean;

  /** Runtime (Mock/Codex) selection surfaced by the Composer runtime chip (FR-SET-03).
   * Defaults to Mock/unavailable until `settings.getRuntime` resolves (or forever if the
   * backend hasn't wired the `settings` API yet — see `loadRuntime`). */
  runtime: RuntimeState;

  /** Whether any reasoning has arrived for a turn (issue #17). Only a boolean and a truncation flag
   * live in the store — the text itself stays in lib/reasoning-buffer.ts, because putting it here
   * would make every fragment a store update and every update a re-render of every subscriber. */
  reasoningSeenByTurn: Record<string, { seen: boolean; truncated: boolean } | undefined>;
  /** What this launch's database recovery pass did, once `app.getInfo()` resolves (issue #9).
   * Absent until then, and absent forever if the backend predates the field. */
  recovery: DatabaseRecovery | null;
  /** Whether the recovery notice has been dismissed. A launch-scoped fact, so acknowledging it
   * should not require persistence — it simply stops being shown for this session. */
  recoveryAcknowledged: boolean;
  /** Latest Runtime process liveness, pushed by main. Null until the first transition. */
  runtimeStatus: RuntimeStatus | null;

  /** Latest stage/turn-completion announcement text for the aria-live region (NFR-A11Y-03). */
  stageAnnouncement: string;
  /** Ephemeral toast for non-fatal notices (e.g. STEER_STALE). */
  toast: { id: number; message: string } | null;

  init(): Promise<void>;
  loadRuntime(): Promise<void>;
  acknowledgeRecovery(): void;
  setRuntime(kind: RuntimeKind): Promise<void>;
  setModel(model: string): Promise<void>;
  setEffort(effort: ClaudeEffort): Promise<void>;
  setCodexEffort(effort: string): Promise<void>;
  setAccessPreset(taskId: string, preset: AccessPreset): Promise<void>;
  resolveApproval(taskId: string, approvalId: string, decision: ApprovalDecision): Promise<void>;
  selectTask(taskId: string): Promise<void>;
  createTask(): Promise<void>;
  renameTask(taskId: string, title: string): Promise<void>;
  setPinned(taskId: string, pinned: boolean): Promise<void>;
  setArchived(taskId: string, archived: boolean): Promise<void>;
  setGoal(taskId: string, goal: string): Promise<void>;
  selectWorkspace(taskId: string): Promise<void>;
  toggleTeamView(taskId: string): Promise<void>;
  // No hireTeamWorker/sendTeamMessage actions here: the Leader hires and dispatches Workers on
  // its own during its Turn (FR-TEAM-06/13, main/team-tools.ts) — the user only ever converses
  // with the Leader through the normal Turn actions below. `window.sprintCoder.teams.hireWorker`/
  // `sendToWorker` IPC still exist (main/ipc.ts keeps them wired), they're just never called from
  // the renderer anymore. `stopTeamWorker`/`stopAllTeamWorkers` stay: FR-TEAM-13 keeps stop as a
  // user override.
  stopTeamWorker(taskId: string, agentId: string): Promise<void>;
  stopAllTeamWorkers(taskId: string): Promise<void>;
  setDraft(taskId: string, text: string): void;
  startTurn(taskId: string, text: string): Promise<void>;
  queueMessage(taskId: string, text: string): Promise<void>;
  steerMessage(taskId: string, text: string, expectedTurnId: string): Promise<void>;
  stopAndSend(taskId: string, text: string): Promise<void>;
  cancelActiveTurn(taskId: string): Promise<void>;
  showToast(message: string): void;
  dismissToast(): void;
};

// Reasoning is subscribed once for the window's lifetime, guarded like the other subscriptions
// above. Without the guard, `init()` — called from an effect with `[]` deps — registers a second
// listener under StrictMode's deliberate double-invocation in dev, and every fragment is appended
// twice. Caught by looking at the rendered panel: every paragraph was duplicated.
let reasoningUnsubscribe: (() => void) | null = null;
let currentUnsubscribe: (() => void) | null = null;
let currentTeamUnsubscribe: (() => void) | null = null;
let currentSubscribedTaskId: string | null = null;
const draftSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function persistDraftDebounced(taskId: string, text: string) {
  if (!window.sprintCoder || typeof window.sprintCoder.tasks.setDraft !== 'function') return;
  const existing = draftSaveTimers.get(taskId);
  if (existing !== undefined) clearTimeout(existing);
  draftSaveTimers.set(
    taskId,
    setTimeout(() => {
      draftSaveTimers.delete(taskId);
      void window.sprintCoder?.tasks.setDraft(taskId, text).catch(() => undefined);
    }, 400),
  );
}

/** Restores a task's draft from the backend (FR-COMP, §12.3) unless the in-memory draft has
 * already been touched this session — the local value always wins over a backend refetch. */
async function restoreDraft(
  taskId: string,
  apply: (fn: (state: AppState) => Partial<AppState>) => void,
  get: () => AppState,
) {
  if (!window.sprintCoder || typeof window.sprintCoder.tasks.getDraft !== 'function') return;
  if (get().draftByTask[taskId] !== undefined) return;
  try {
    const draft = await window.sprintCoder.tasks.getDraft(taskId);
    if (get().selectedTaskId === taskId && get().draftByTask[taskId] === undefined) {
      apply((state) => ({ draftByTask: { ...state.draftByTask, [taskId]: draft } }));
    }
  } catch {
    // Non-fatal: leave the draft empty rather than blocking task selection.
  }
}

/** Resolves a display-ready workspace chip value for a task, preferring the dedicated
 * `workspace.get` API and falling back to `TaskSummary.workspacePath` when the backend hasn't
 * wired the dedicated endpoint yet. */
async function loadWorkspace(
  taskId: string,
  apply: (fn: (state: AppState) => Partial<AppState>) => void,
  get: () => AppState,
) {
  if (!window.sprintCoder) return;
  if (typeof window.sprintCoder.workspace?.get === 'function') {
    try {
      const workspace = await window.sprintCoder.workspace.get(taskId);
      if (get().selectedTaskId !== taskId) return;
      apply((state) => ({ workspaceByTask: { ...state.workspaceByTask, [taskId]: workspace } }));
      return;
    } catch {
      // Fall through to the TaskSummary-derived fallback below.
    }
  }
  const task = get().tasks.find((t) => t.id === taskId);
  const workspacePath = task?.workspacePath ?? null;
  if (workspacePath) {
    const name = workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? workspacePath;
    apply((state) => ({
      workspaceByTask: { ...state.workspaceByTask, [taskId]: { path: workspacePath, name } },
    }));
  } else {
    apply((state) => ({ workspaceByTask: { ...state.workspaceByTask, [taskId]: null } }));
  }
}

async function loadPermission(
  taskId: string,
  apply: (fn: (state: AppState) => Partial<AppState>) => void,
  get: () => AppState,
) {
  if (!window.sprintCoder || typeof window.sprintCoder.permissions?.get !== 'function') return;
  try {
    const permission = await window.sprintCoder.permissions.get(taskId);
    if (get().selectedTaskId !== taskId) return;
    apply((state) => ({
      permissionByTask: { ...state.permissionByTask, [taskId]: permission },
    }));
  } catch {
    // Non-fatal: keep the deny-by-default Ask preset while task data remains usable.
  }
}

function subscribeToTask(
  taskId: string,
  apply: (fn: (state: AppState) => Partial<AppState>) => void,
  get: () => AppState,
  afterSeq?: number,
) {
  if (currentUnsubscribe) {
    currentUnsubscribe();
    currentUnsubscribe = null;
  }
  currentSubscribedTaskId = taskId;
  if (!window.sprintCoder) return;
  const listener = (ev: TurnEvent) => {
    // Ignore stray events if the user has since switched tasks and this callback
    // has not been torn down yet (defensive; unsubscribe should prevent this).
    if (currentSubscribedTaskId !== taskId) return;
    const lastSeq = get().lastSeqByTask[taskId] ?? 0;
    if (ev.seq <= lastSeq) return;
    if (ev.seq > lastSeq + 1) {
      void get().selectTask(taskId);
      return;
    }
    handleTurnEvent(taskId, ev, apply);
  };
  currentUnsubscribe =
    afterSeq !== undefined
      ? window.sprintCoder.turns.subscribe(taskId, listener, { afterSeq })
      : window.sprintCoder.turns.subscribe(taskId, listener);
}

function upsertCommand(
  cards: readonly CommandCardState[],
  command: CommandSummary,
): CommandCardState[] {
  const existing = cards.find((card) => card.command.id === command.id);
  const next: CommandCardState = {
    command,
    tail: existing?.tail ?? { lines: Object.freeze([]), lastOutputSeq: 0 },
  };
  return [...cards.filter((card) => card.command.id !== command.id), next].sort((left, right) =>
    left.command.createdAt.localeCompare(right.command.createdAt),
  );
}

function mergeRestoredCommands(
  restored: readonly CommandCardState[],
  live: readonly CommandCardState[],
): CommandCardState[] {
  const merged = new Map(restored.map((card) => [card.command.id, card]));
  for (const card of live) {
    const persisted = merged.get(card.command.id);
    if (persisted === undefined || card.tail.lastOutputSeq > persisted.tail.lastOutputSeq)
      merged.set(card.command.id, card);
  }
  return [...merged.values()].sort((left, right) =>
    left.command.createdAt.localeCompare(right.command.createdAt),
  );
}

function upsertApprovalHistory(
  approvals: readonly ApprovalSummary[],
  approval: ApprovalSummary,
): ApprovalSummary[] {
  return [...approvals.filter(({ id }) => id !== approval.id), approval].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function upsertAutoDecision(
  decisions: readonly AutoPermissionDecision[],
  decision: AutoPermissionDecision,
): AutoPermissionDecision[] {
  return [...decisions.filter(({ id }) => id !== decision.id), decision].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function handleTurnEvent(
  taskId: string,
  ev: TurnEvent,
  apply: (fn: (state: AppState) => Partial<AppState>) => void,
) {
  apply((state) => ({ lastSeqByTask: { ...state.lastSeqByTask, [taskId]: ev.seq } }));

  switch (ev.type) {
    case 'turn.accepted': {
      // Reasoning is not persisted, so this buffer is the only thing keeping old turns' text alive.
      // Pruned on each new turn rather than on every append: it must not grow for the lifetime of the
      // window, but the current turn's text has to survive the turn it belongs to.
      pruneReasoning([ev.turnId]);
      apply((state) => {
        const existing = state.messagesByTask[taskId] ?? [];
        const pendingId = state.pendingOptimisticIdByTask[taskId];
        const withoutOptimistic = pendingId ? existing.filter((m) => m.id !== pendingId) : existing;
        const withoutDup = withoutOptimistic.filter((m) => m.id !== ev.userMessage.id);
        return {
          messagesByTask: {
            ...state.messagesByTask,
            [taskId]: [...withoutDup, ev.userMessage],
          },
          pendingOptimisticIdByTask: { ...state.pendingOptimisticIdByTask, [taskId]: undefined },
          sendingByTask: { ...state.sendingByTask, [taskId]: false },
          turnByTask: {
            ...state.turnByTask,
            [taskId]: {
              turnId: ev.turnId,
              stage: 'understanding',
              reachedStageIndex: 0,
              status: 'running',
              startedAt: Date.now(),
              streamingMessageId: null,
              streamingContent: '',
            },
          },
          stageAnnouncement: STAGE_LABEL.understanding,
        };
      });
      break;
    }
    case 'stage.changed': {
      apply((state) => {
        const turn = state.turnByTask[taskId];
        if (!turn || turn.turnId !== ev.turnId) return {};
        return {
          turnByTask: {
            ...state.turnByTask,
            [taskId]: {
              ...turn,
              stage: ev.stage,
              reachedStageIndex: advanceStageIndex(turn.reachedStageIndex, ev.stage),
            },
          },
          stageAnnouncement: STAGE_LABEL[ev.stage],
        };
      });
      break;
    }
    case 'approval.requested': {
      apply((state) => ({
        approvalsByTask: {
          ...state.approvalsByTask,
          [taskId]: [
            ...(state.approvalsByTask[taskId] ?? []).filter(({ id }) => id !== ev.approvalId),
            ev.approval,
          ],
        },
        turnByTask: state.turnByTask[taskId]
          ? {
              ...state.turnByTask,
              [taskId]: { ...state.turnByTask[taskId]!, stage: 'waiting_approval' },
            }
          : state.turnByTask,
        stageAnnouncement: STAGE_LABEL.waiting_approval,
      }));
      break;
    }
    case 'approval.resolved':
    case 'approval.canceled':
    case 'approval.stale':
    case 'approval.expired': {
      apply((state) => ({
        approvalsByTask: {
          ...state.approvalsByTask,
          [taskId]: (state.approvalsByTask[taskId] ?? []).filter(({ id }) => id !== ev.approvalId),
        },
        approvalHistoryByTask:
          ev.type === 'approval.resolved'
            ? {
                ...state.approvalHistoryByTask,
                [taskId]: upsertApprovalHistory(
                  state.approvalHistoryByTask[taskId] ?? [],
                  ev.approval,
                ),
              }
            : state.approvalHistoryByTask,
      }));
      break;
    }
    case 'command.started': {
      apply((state) => ({
        commandsByTask: {
          ...state.commandsByTask,
          [taskId]: upsertCommand(state.commandsByTask[taskId] ?? [], ev.command),
        },
      }));
      break;
    }
    case 'command.output': {
      apply((state) => ({
        commandsByTask: {
          ...state.commandsByTask,
          [taskId]: (state.commandsByTask[taskId] ?? []).map((card) =>
            card.command.id === ev.commandId
              ? {
                  ...card,
                  tail: appendCommandOutput(card.tail, {
                    seq: ev.outputSeq,
                    stream: ev.stream,
                    text: ev.text,
                    byteLength: ev.byteLength,
                  }),
                }
              : card,
          ),
        },
      }));
      break;
    }
    case 'command.completed': {
      apply((state) => ({
        commandsByTask: {
          ...state.commandsByTask,
          [taskId]: upsertCommand(state.commandsByTask[taskId] ?? [], ev.command),
        },
      }));
      break;
    }
    case 'permission.auto_decided': {
      apply((state) => ({
        autoDecisionsByTask: {
          ...state.autoDecisionsByTask,
          [taskId]: upsertAutoDecision(state.autoDecisionsByTask[taskId] ?? [], ev.autoDecision),
        },
      }));
      break;
    }
    case 'message.delta': {
      apply((state) => {
        const turn = state.turnByTask[taskId];
        if (!turn || turn.turnId !== ev.turnId) return {};
        return {
          turnByTask: {
            ...state.turnByTask,
            [taskId]: {
              ...turn,
              streamingMessageId: turn.streamingMessageId ?? ev.messageId,
              streamingContent: turn.streamingContent + ev.delta,
            },
          },
        };
      });
      break;
    }
    case 'turn.completed': {
      apply((state) => {
        const turn = state.turnByTask[taskId];
        if (!turn || turn.turnId !== ev.turnId) return {};
        const existing = state.messagesByTask[taskId] ?? [];
        let nextMessages = existing;
        if (ev.message) {
          const finalMessage = ev.message;
          nextMessages = [...existing.filter((m) => m.id !== finalMessage.id), finalMessage];
        } else if (turn.streamingContent.trim().length > 0) {
          const partial: ChatMessage = {
            id: turn.streamingMessageId ?? `partial-${ev.turnId}`,
            taskId,
            turnId: ev.turnId,
            author: 'assistant',
            content: turn.streamingContent,
            createdAt: new Date().toISOString(),
          };
          nextMessages = [...existing.filter((m) => m.id !== partial.id), partial];
        }
        return {
          messagesByTask: { ...state.messagesByTask, [taskId]: nextMessages },
          turnByTask: { ...state.turnByTask, [taskId]: { ...turn, status: ev.state } },
          turnDiffByTask: {
            ...state.turnDiffByTask,
            [taskId]: { turnId: ev.turnId, entries: ev.diff },
          },
          stageAnnouncement: finalStateLabel(ev.state),
          // Smallest-surface exposure of "which model actually ran" (FR clarity ask): the model
          // chip's tooltip reads this after a Claude turn completes with a resolved model id.
          ...(ev.resolvedModel !== undefined
            ? { runtime: { ...state.runtime, resolvedModel: ev.resolvedModel } }
            : {}),
        };
      });
      break;
    }
    case 'queue.changed': {
      apply((state) => ({
        queuedByTask: { ...state.queuedByTask, [taskId]: ev.queued },
      }));
      break;
    }
    case 'context.usage': {
      apply((state) => ({
        contextUsageByTask: { ...state.contextUsageByTask, [taskId]: ev.usage },
      }));
      break;
    }
    case 'files.changed': {
      apply((state) => {
        const existing = state.fileChangesByTask[taskId] ?? [];
        // Replay-safe like image.generated: this event is persisted, so re-subscribing delivers it
        // again. There is no content digest to key on here, so the guard is the event's own seq —
        // the same seq arriving twice is a replay, never two separate edits.
        if (existing.some((entry) => entry.seq === ev.seq)) return {};
        return {
          fileChangesByTask: {
            ...state.fileChangesByTask,
            [taskId]: [...existing, { seq: ev.seq, turnId: ev.turnId, changes: ev.changes }],
          },
        };
      });
      break;
    }
    case 'image.generated': {
      apply((state) => {
        const existing = state.imagesByTask[taskId] ?? [];
        // Replay-safe: this event is persisted, so re-subscribing delivers it again. The id is a
        // content digest, so de-duplicating on it also collapses the same image generated twice.
        if (existing.some((image) => image.id === ev.image.id)) return {};
        return { imagesByTask: { ...state.imagesByTask, [taskId]: [...existing, ev.image] } };
      });
      break;
    }
    default:
      break;
  }
}

export const useAppStore = create<AppState>((set, get) => {
  const apply = (fn: (state: AppState) => Partial<AppState>) => set(fn);

  return {
    sprintCoderAvailable: typeof window !== 'undefined' && !!window.sprintCoder,
    initialized: false,
    loadingTasks: false,
    loadingMessages: false,
    error: null,

    tasks: [],
    selectedTaskId: null,
    messagesByTask: {},
    turnByTask: {},
    queuedByTask: {},
    contextUsageByTask: {},
    lastSeqByTask: {},
    sendingByTask: {},
    draftByTask: {},
    workspaceByTask: {},
    permissionByTask: {},
    approvalsByTask: {},
    approvalHistoryByTask: {},
    autoDecisionsByTask: {},
    commandsByTask: {},
    turnDiffByTask: {},
    imagesByTask: {},
    fileChangesByTask: {},
    resolvingApprovalIds: {},
    pendingOptimisticIdByTask: {},
    teamByTask: {},
    teamViewOpen: false,
    teamBusy: false,
    runtime: {
      kind: 'mock',
      codexAvailable: false,
      claudeAvailable: false,
      model: 'auto',
      models: [{ id: 'auto', displayName: 'Auto', description: 'Codexの既定モデルを使用' }],
      effort: 'medium',
      codexEffort: '',
    },
    reasoningSeenByTurn: {},
    recovery: null,
    recoveryAcknowledged: false,
    runtimeStatus: null,
    stageAnnouncement: '',
    toast: null,

    async init() {
      if (!window.sprintCoder) {
        set({ sprintCoderAvailable: false, initialized: true });
        return;
      }
      set({ sprintCoderAvailable: true, loadingTasks: true, error: null });
      void get().loadRuntime();
      // Reasoning is a transient push stream, subscribed once for the window's lifetime (issue #17).
      // The batch carries its own turnId, so there is nothing per-task to re-subscribe.
      if (reasoningUnsubscribe !== null) {
        reasoningUnsubscribe();
        reasoningUnsubscribe = null;
      }
      if (typeof window.sprintCoder.reasoning?.subscribe === 'function')
        reasoningUnsubscribe = window.sprintCoder.reasoning.subscribe(
          ({ turnId, text, truncated }) => {
            appendReasoning(turnId, text, truncated);
            set((state) => {
              const previous = state.reasoningSeenByTurn[turnId];
              const seen = previous?.seen === true || text !== '';
              const nextTruncated = previous?.truncated === true || truncated;
              // Returns the same state when nothing changed, so the high-frequency case costs no
              // re-render at all — the text lives outside the store precisely so this can be cheap.
              if (previous?.seen === seen && previous?.truncated === nextTruncated) return {};
              return {
                reasoningSeenByTurn: {
                  ...state.reasoningSeenByTurn,
                  [turnId]: { seen, truncated: nextTruncated },
                },
              };
            });
          },
        );
      // Startup recovery outcome and Runtime liveness both feed the SurfaceFooter (issue #9).
      // Both are best-effort: an older backend simply leaves the footer's quiet default in place.
      if (typeof window.sprintCoder.app?.getInfo === 'function')
        void window.sprintCoder.app
          .getInfo()
          .then((info) => {
            if (info.recovery !== undefined) set({ recovery: info.recovery });
          })
          .catch(() => undefined);
      if (typeof window.sprintCoder.runtime?.subscribeStatus === 'function')
        window.sprintCoder.runtime.subscribeStatus((runtimeStatus) => set({ runtimeStatus }));
      try {
        const tasks = await window.sprintCoder.tasks.list();
        set({ tasks, loadingTasks: false, initialized: true });
        const firstSelectable = tasks.find((t) => !t.archived) ?? tasks[0];
        if (firstSelectable) {
          await get().selectTask(firstSelectable.id);
        }
      } catch (err) {
        set({ loadingTasks: false, initialized: true, error: describeError(err) });
      }
    },

    acknowledgeRecovery() {
      set({ recoveryAcknowledged: true });
    },

    async loadRuntime() {
      if (!window.sprintCoder || typeof window.sprintCoder.settings?.getRuntime !== 'function')
        return;
      try {
        const runtime = await window.sprintCoder.settings.getRuntime();
        set({ runtime });
      } catch {
        // Non-fatal: keep the last-known (or default) runtime state.
      }
    },

    async setRuntime(kind: RuntimeKind) {
      if (!window.sprintCoder || typeof window.sprintCoder.settings?.setRuntime !== 'function')
        return;
      const previous = get().runtime;
      if (previous.kind === kind) return;
      set({ runtime: { ...previous, kind } });
      try {
        await window.sprintCoder.settings.setRuntime(kind);
        await get().loadRuntime();
      } catch (err) {
        set({ runtime: previous });
        const code = errorCode(err);
        if (code === 'RUNTIME_UNAVAILABLE') {
          get().showToast(
            kind === 'claude'
              ? 'Claude CLIが見つからないため切り替えできません'
              : 'Codex CLIが見つからないため切り替えできません',
          );
        } else {
          set({ error: describeError(err) });
        }
      }
    },

    async setModel(model: string) {
      if (!window.sprintCoder || typeof window.sprintCoder.settings?.setModel !== 'function')
        return;
      const previous = get().runtime;
      if (previous.model === model || !previous.models.some(({ id }) => id === model)) return;
      set({ runtime: { ...previous, model } });
      try {
        await window.sprintCoder.settings.setModel(model);
        await get().loadRuntime();
      } catch (err) {
        set({ runtime: previous });
        set({ error: describeError(err) });
      }
    },

    async setEffort(effort: ClaudeEffort) {
      if (!window.sprintCoder || typeof window.sprintCoder.settings?.setEffort !== 'function')
        return;
      const previous = get().runtime;
      if (previous.effort === effort) return;
      set({ runtime: { ...previous, effort } });
      try {
        await window.sprintCoder.settings.setEffort(effort);
        await get().loadRuntime();
      } catch (err) {
        set({ runtime: previous });
        set({ error: describeError(err) });
      }
    },

    async setCodexEffort(effort: string) {
      if (!window.sprintCoder || typeof window.sprintCoder.settings?.setCodexEffort !== 'function')
        return;
      const previous = get().runtime;
      if (previous.codexEffort === effort) return;
      set({ runtime: { ...previous, codexEffort: effort } });
      try {
        await window.sprintCoder.settings.setCodexEffort(effort);
        await get().loadRuntime();
      } catch (err) {
        // Main rejects a level the selected model does not advertise, so the optimistic update has
        // to be rolled back — unlike Claude, a bad Codex level would fail the turn outright.
        set({ runtime: previous });
        set({ error: describeError(err) });
      }
    },

    async setAccessPreset(taskId: string, preset: AccessPreset) {
      if (!window.sprintCoder || typeof window.sprintCoder.permissions?.set !== 'function') return;
      const previous = get().permissionByTask[taskId] ?? { preset: 'ask', policyEpoch: 0 };
      if (previous.preset === preset) return;
      set((state) => ({
        permissionByTask: {
          ...state.permissionByTask,
          [taskId]: { ...previous, preset },
        },
      }));
      try {
        const permission = await window.sprintCoder.permissions.set(
          taskId,
          preset,
          previous.policyEpoch,
        );
        set((state) => ({
          permissionByTask:
            state.permissionByTask[taskId]?.preset === preset &&
            state.permissionByTask[taskId]?.policyEpoch === previous.policyEpoch
              ? { ...state.permissionByTask, [taskId]: permission }
              : state.permissionByTask,
        }));
      } catch (err) {
        let restored = previous;
        try {
          restored = await window.sprintCoder.permissions.get(taskId);
        } catch {
          // Keep the last confirmed local value when refresh is unavailable.
        }
        set((state) => ({
          permissionByTask:
            state.permissionByTask[taskId]?.preset === preset &&
            state.permissionByTask[taskId]?.policyEpoch === previous.policyEpoch
              ? { ...state.permissionByTask, [taskId]: restored }
              : state.permissionByTask,
          error: describeError(err),
        }));
      }
    },

    async resolveApproval(taskId: string, approvalId: string, decision: ApprovalDecision) {
      if (!window.sprintCoder || typeof window.sprintCoder.approvals?.resolve !== 'function')
        return;
      const approval = (get().approvalsByTask[taskId] ?? []).find(({ id }) => id === approvalId);
      if (approval === undefined || get().resolvingApprovalIds[approvalId]) return;
      set((state) => ({
        resolvingApprovalIds: { ...state.resolvingApprovalIds, [approvalId]: true },
      }));
      try {
        const resolved = await window.sprintCoder.approvals.resolve({
          taskId,
          approvalId,
          decision,
          expectedRevision: approval.revision,
          expectedPolicyEpoch: approval.policyEpoch,
          challenge: approval.challenge,
        });
        set((state) => ({
          approvalsByTask: {
            ...state.approvalsByTask,
            [taskId]: (state.approvalsByTask[taskId] ?? []).filter(({ id }) => id !== approvalId),
          },
          approvalHistoryByTask: {
            ...state.approvalHistoryByTask,
            [taskId]: upsertApprovalHistory(state.approvalHistoryByTask[taskId] ?? [], resolved),
          },
        }));
      } catch (err) {
        set({ error: describeError(err) });
      } finally {
        set((state) => ({
          resolvingApprovalIds: { ...state.resolvingApprovalIds, [approvalId]: undefined },
        }));
      }
    },

    async selectTask(taskId: string) {
      set({ selectedTaskId: taskId, loadingMessages: true, error: null });
      if (currentUnsubscribe) {
        currentUnsubscribe();
        currentUnsubscribe = null;
        currentSubscribedTaskId = null;
      }
      if (currentTeamUnsubscribe) {
        currentTeamUnsubscribe();
        currentTeamUnsubscribe = null;
      }
      set({ teamViewOpen: false });
      void restoreDraft(taskId, apply, get);
      void loadWorkspace(taskId, apply, get);
      void loadPermission(taskId, apply, get);
      // Fetched alongside the other per-task reads rather than reconstructed from replayed events:
      // metadata only, so this stays cheap even for a Task with many images (issue #11).
      // Read rather than replayed: the event port only carries events newer than the snapshot's
      // lastSeq, so reopening a Task would otherwise show an empty edit history (issue #37).
      if (typeof window.sprintCoder?.files?.list === 'function')
        void window.sprintCoder.files
          .list(taskId)
          .then((records) =>
            apply((state) => ({
              fileChangesByTask: { ...state.fileChangesByTask, [taskId]: records },
            })),
          )
          .catch(() => undefined);

      if (typeof window.sprintCoder?.images?.list === 'function')
        void window.sprintCoder.images
          .list(taskId)
          .then((images) =>
            apply((state) => ({ imagesByTask: { ...state.imagesByTask, [taskId]: images } })),
          )
          .catch(() => undefined);

      if (!window.sprintCoder) {
        set({ loadingMessages: false });
        return;
      }
      const sprintCoder = window.sprintCoder;

      const [messagesResult, snapshot, commandsResult, approvalHistoryResult, autoDecisionsResult] =
        await Promise.all([
          sprintCoder.tasks
            .messages(taskId)
            .then((v) => ({ ok: true as const, v }))
            .catch((err: unknown) => ({ ok: false as const, err })),
          typeof sprintCoder.turns.snapshot === 'function'
            ? sprintCoder.turns.snapshot(taskId).catch(() => null)
            : Promise.resolve(null),
          typeof sprintCoder.commands?.list === 'function'
            ? sprintCoder.commands
                .list(taskId)
                .then(async (commands) => {
                  const cards = await Promise.all(
                    commands.map(async (command): Promise<CommandCardState> => {
                      const output = await sprintCoder.commands
                        .outputTail({ taskId, commandId: command.id, maxBytes: 131_072 })
                        .catch(() => ({ items: [] as CommandOutputRecord[] }));
                      return { command, tail: projectCommandTail(output.items) };
                    }),
                  );
                  return { ok: true as const, cards };
                })
                .catch((err: unknown) => ({ ok: false as const, err }))
            : Promise.resolve({ ok: true as const, cards: [] as CommandCardState[] }),
          typeof sprintCoder.approvals?.listRecent === 'function'
            ? sprintCoder.approvals
                .listRecent(taskId)
                .then((approvals) => ({ ok: true as const, approvals }))
                .catch((err: unknown) => ({ ok: false as const, err }))
            : Promise.resolve({ ok: true as const, approvals: [] as ApprovalSummary[] }),
          typeof sprintCoder.permissions?.listAutoDecisions === 'function'
            ? sprintCoder.permissions
                .listAutoDecisions(taskId)
                .then((decisions) => ({ ok: true as const, decisions }))
                .catch((err: unknown) => ({ ok: false as const, err }))
            : Promise.resolve({ ok: true as const, decisions: [] as AutoPermissionDecision[] }),
        ]);

      if (get().selectedTaskId !== taskId) return; // user switched away while these were in flight

      if (messagesResult.ok) {
        set((state) => ({
          messagesByTask: { ...state.messagesByTask, [taskId]: messagesResult.v },
          loadingMessages: false,
        }));
      } else {
        set({ loadingMessages: false, error: describeError(messagesResult.err) });
      }

      if (commandsResult.ok) {
        apply((state) => ({
          commandsByTask: {
            ...state.commandsByTask,
            [taskId]: mergeRestoredCommands(
              commandsResult.cards,
              state.commandsByTask[taskId] ?? [],
            ),
          },
        }));
      }

      if (approvalHistoryResult.ok) {
        apply((state) => ({
          approvalHistoryByTask: {
            ...state.approvalHistoryByTask,
            [taskId]: approvalHistoryResult.approvals.filter(
              (approval) => approval.state === 'resolved',
            ),
          },
        }));
      }

      if (autoDecisionsResult.ok) {
        apply((state) => ({
          autoDecisionsByTask: {
            ...state.autoDecisionsByTask,
            [taskId]: autoDecisionsResult.decisions,
          },
        }));
      }

      let afterSeq: number | undefined;
      if (snapshot) {
        afterSeq = snapshot.lastSeq;
        const activeTurn = snapshot.activeTurn;
        apply((state) => ({
          turnByTask: {
            ...state.turnByTask,
            [taskId]: activeTurn
              ? {
                  turnId: activeTurn.turnId,
                  stage: activeTurn.stage,
                  // Restored from the snapshot's stage, which is the furthest this turn is known to
                  // have reached — earlier stage events are not replayed for a resumed turn.
                  reachedStageIndex: advanceStageIndex(0, activeTurn.stage),
                  status: 'running',
                  startedAt: activeTurn.startedAtEpochMs,
                  streamingMessageId: activeTurn.messageId,
                  streamingContent: activeTurn.streamedText,
                }
              : undefined,
          },
          queuedByTask: { ...state.queuedByTask, [taskId]: snapshot.queued },
          lastSeqByTask: { ...state.lastSeqByTask, [taskId]: snapshot.lastSeq },
          contextUsageByTask: snapshot.contextUsage
            ? { ...state.contextUsageByTask, [taskId]: snapshot.contextUsage }
            : state.contextUsageByTask,
          approvalsByTask: {
            ...state.approvalsByTask,
            [taskId]: snapshot.pendingApprovals ?? [],
          },
          turnDiffByTask: {
            ...state.turnDiffByTask,
            [taskId]: snapshot.latestTurnDiff ?? undefined,
          },
        }));
      }

      if (get().selectedTaskId !== taskId) return;
      subscribeToTask(taskId, apply, get, afterSeq);
      if (typeof sprintCoder.teams?.get === 'function') {
        const team = await sprintCoder.teams.get(taskId).catch(() => null);
        if (get().selectedTaskId === taskId)
          set((state) => ({ teamByTask: { ...state.teamByTask, [taskId]: team } }));
        if (typeof sprintCoder.teams.subscribe === 'function')
          currentTeamUnsubscribe = sprintCoder.teams.subscribe(taskId, (event) => {
            if (event.type === 'updated')
              set((state) => {
                // First team appearance for the selected task (leader-driven auto-promotion)
                // pulls the user into the canvas; later updates never fight a manual close.
                const firstAppearance =
                  state.teamByTask[taskId] == null &&
                  state.selectedTaskId === taskId &&
                  !state.teamViewOpen;
                return {
                  teamByTask: { ...state.teamByTask, [taskId]: event.detail },
                  ...(firstAppearance ? { teamViewOpen: true } : {}),
                };
              });
          });
      }
    },

    async createTask() {
      if (!window.sprintCoder) return;
      set({ error: null });
      try {
        const task = await window.sprintCoder.tasks.create();
        set((state) => ({ tasks: [task, ...state.tasks] }));
        await get().selectTask(task.id);
      } catch (err) {
        set({ error: describeError(err) });
      }
    },

    async renameTask(taskId: string, title: string) {
      if (!window.sprintCoder) return;
      const trimmed = title.trim();
      if (!trimmed) return;
      try {
        const updated = await window.sprintCoder.tasks.rename(taskId, trimmed);
        set((state) => ({ tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)) }));
      } catch (err) {
        set({ error: describeError(err) });
      }
    },

    async setPinned(taskId: string, pinned: boolean) {
      if (!window.sprintCoder || typeof window.sprintCoder.tasks.setPinned !== 'function') return;
      try {
        const updated = await window.sprintCoder.tasks.setPinned(taskId, pinned);
        set((state) => ({ tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)) }));
      } catch (err) {
        set({ error: describeError(err) });
      }
    },

    async setArchived(taskId: string, archived: boolean) {
      if (!window.sprintCoder || typeof window.sprintCoder.tasks.setArchived !== 'function') return;
      try {
        const updated = await window.sprintCoder.tasks.setArchived(taskId, archived);
        set((state) => ({ tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)) }));
      } catch (err) {
        set({ error: describeError(err) });
      }
    },

    async setGoal(taskId: string, goal: string) {
      if (!window.sprintCoder || typeof window.sprintCoder.tasks.setGoal !== 'function') return;
      try {
        const updated = await window.sprintCoder.tasks.setGoal(taskId, goal);
        set((state) => ({ tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)) }));
      } catch (err) {
        set({ error: describeError(err) });
      }
    },

    async selectWorkspace(taskId: string) {
      if (!window.sprintCoder || typeof window.sprintCoder.workspace?.select !== 'function') return;
      try {
        const workspace = await window.sprintCoder.workspace.select(taskId);
        set((state) => ({ workspaceByTask: { ...state.workspaceByTask, [taskId]: workspace } }));
      } catch (err) {
        set({ error: describeError(err) });
      }
    },

    async toggleTeamView(taskId: string) {
      if (!window.sprintCoder?.teams) return;
      if (get().teamViewOpen) {
        set({ teamViewOpen: false });
        return;
      }
      set({ teamBusy: true, error: null });
      try {
        let detail = await window.sprintCoder.teams.get(taskId);
        if (detail === null) {
          await window.sprintCoder.teams.promote(taskId);
          detail = await window.sprintCoder.teams.get(taskId);
        }
        set((state) => ({
          teamByTask: { ...state.teamByTask, [taskId]: detail },
          teamViewOpen: true,
        }));
      } catch (err) {
        set({ error: describeError(err) });
      } finally {
        set({ teamBusy: false });
      }
    },

    async stopTeamWorker(taskId: string, agentId: string) {
      if (!window.sprintCoder?.teams || get().teamBusy) return;
      set({ teamBusy: true });
      try {
        await window.sprintCoder.teams.stopWorker({ taskId, agentId });
        const detail = await window.sprintCoder.teams.get(taskId);
        set((state) => ({ teamByTask: { ...state.teamByTask, [taskId]: detail } }));
      } catch (err) {
        set({ error: describeError(err) });
      } finally {
        set({ teamBusy: false });
      }
    },

    async stopAllTeamWorkers(taskId: string) {
      if (!window.sprintCoder?.teams || get().teamBusy) return;
      set({ teamBusy: true });
      try {
        const detail = await window.sprintCoder.teams.stopAll(taskId);
        set((state) => ({ teamByTask: { ...state.teamByTask, [taskId]: detail } }));
      } catch (err) {
        set({ error: describeError(err) });
      } finally {
        set({ teamBusy: false });
      }
    },

    setDraft(taskId: string, text: string) {
      set((state) => ({ draftByTask: { ...state.draftByTask, [taskId]: text } }));
      persistDraftDebounced(taskId, text);
    },

    async startTurn(taskId: string, text: string) {
      const trimmed = text.trim();
      if (!trimmed || !window.sprintCoder) return;
      const turn = get().turnByTask[taskId];
      if (turn && (turn.status === 'running' || turn.status === 'canceling')) return;

      const optimisticId = `pending-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const optimisticMessage: ChatMessage = {
        id: optimisticId,
        taskId,
        turnId: null,
        author: 'user',
        content: trimmed,
        createdAt: new Date().toISOString(),
      };
      set((state) => ({
        messagesByTask: {
          ...state.messagesByTask,
          [taskId]: [...(state.messagesByTask[taskId] ?? []), optimisticMessage],
        },
        pendingOptimisticIdByTask: { ...state.pendingOptimisticIdByTask, [taskId]: optimisticId },
        sendingByTask: { ...state.sendingByTask, [taskId]: true },
        draftByTask: { ...state.draftByTask, [taskId]: '' },
      }));
      persistDraftDebounced(taskId, '');

      try {
        const result = await window.sprintCoder.turns.start({ taskId, text: trimmed });
        // turn.accepted event (delivered via subscription) reconciles the optimistic message.
        // `renamedTask` is present only when this was the Task's first message and it was still
        // carrying the placeholder title (issue #4) — merge it so the sidebar updates immediately
        // instead of at the next full `tasks.list()`.
        const renamed = result?.renamedTask;
        if (renamed !== undefined)
          set((state) => ({ tasks: state.tasks.map((t) => (t.id === renamed.id ? renamed : t)) }));
      } catch (err) {
        const code = errorCode(err);
        set((state) => ({
          messagesByTask: {
            ...state.messagesByTask,
            [taskId]: (state.messagesByTask[taskId] ?? []).filter((m) => m.id !== optimisticId),
          },
          pendingOptimisticIdByTask: { ...state.pendingOptimisticIdByTask, [taskId]: undefined },
          sendingByTask: { ...state.sendingByTask, [taskId]: false },
          draftByTask: { ...state.draftByTask, [taskId]: trimmed },
          error: code === 'TURN_ACTIVE' ? null : describeError(err),
        }));
        if (code === 'TURN_ACTIVE') {
          get().showToast(
            'すでに実行中です。キューに追加するか、Steer/Stop & Sendを選んでください',
          );
        }
      }
    },

    async queueMessage(taskId: string, text: string) {
      const trimmed = text.trim();
      if (!trimmed || !window.sprintCoder || typeof window.sprintCoder.turns.queue !== 'function')
        return;
      set((state) => ({ draftByTask: { ...state.draftByTask, [taskId]: '' } }));
      persistDraftDebounced(taskId, '');
      try {
        await window.sprintCoder.turns.queue({ taskId, text: trimmed });
        // queue.changed (delivered via subscription) reconciles the compact queued list.
      } catch (err) {
        set((state) => ({
          draftByTask: { ...state.draftByTask, [taskId]: trimmed },
          error: describeError(err),
        }));
      }
    },

    async steerMessage(taskId: string, text: string, expectedTurnId: string) {
      const trimmed = text.trim();
      if (!trimmed || !window.sprintCoder || typeof window.sprintCoder.turns.steer !== 'function')
        return;
      set((state) => ({ draftByTask: { ...state.draftByTask, [taskId]: '' } }));
      persistDraftDebounced(taskId, '');
      try {
        await window.sprintCoder.turns.steer({ taskId, text: trimmed, expectedTurnId });
      } catch (err) {
        const code = errorCode(err);
        set((state) => ({
          draftByTask: { ...state.draftByTask, [taskId]: trimmed },
          error:
            code === 'STEER_STALE' || code === 'STEER_UNSUPPORTED'
              ? state.error
              : describeError(err),
        }));
        if (code === 'STEER_STALE') {
          get().showToast('Turnが切り替わったため送信し直してください');
        } else if (code === 'STEER_UNSUPPORTED') {
          get().showToast(
            '選択中のruntimeでは実行中の追加指示に対応していません。キュー追加を使ってください',
          );
        }
      }
    },

    async stopAndSend(taskId: string, text: string) {
      const trimmed = text.trim();
      if (
        !trimmed ||
        !window.sprintCoder ||
        typeof window.sprintCoder.turns.stopAndSend !== 'function'
      )
        return;
      set((state) => ({ draftByTask: { ...state.draftByTask, [taskId]: '' } }));
      persistDraftDebounced(taskId, '');
      try {
        await window.sprintCoder.turns.stopAndSend({ taskId, text: trimmed });
      } catch (err) {
        set((state) => ({
          draftByTask: { ...state.draftByTask, [taskId]: trimmed },
          error: describeError(err),
        }));
      }
    },

    async cancelActiveTurn(taskId: string) {
      const turn = get().turnByTask[taskId];
      if (!turn || turn.status !== 'running' || !window.sprintCoder) return;
      set((state) => ({
        turnByTask: { ...state.turnByTask, [taskId]: { ...turn, status: 'canceling' } },
      }));
      try {
        await window.sprintCoder.turns.cancel({ taskId, turnId: turn.turnId });
        // turn.completed(state:'canceled') will arrive via subscription and finalize.
      } catch (err) {
        set({ error: describeError(err) });
      }
    },

    showToast(message: string) {
      const id = Date.now();
      set({ toast: { id, message } });
      window.setTimeout(() => {
        if (get().toast?.id === id) set({ toast: null });
      }, 4000);
    },

    dismissToast() {
      set({ toast: null });
    },
  };
});

function errorCode(err: unknown): string | undefined {
  if (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    typeof (err as { code?: unknown }).code === 'string'
  ) {
    return (err as { code: string }).code;
  }
  return undefined;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

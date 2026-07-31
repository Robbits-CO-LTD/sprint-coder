import { create } from 'zustand';
import type {
  ModelSelection,
  SkillCatalogItem,
  SkillDraft,
  TurnSkillSelection,
} from '@sprint-coder/contracts';
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
  ProjectSummary,
  TaskSummary,
  TeamDetail,
  TurnDiff,
  TurnEvent,
  TurnStage,
} from '../types/sprint-coder';
import { STAGE_LABEL } from '../lib/stages';
import { advanceStageIndex } from '../lib/turn-progress';
import { appendReasoning, pruneReasoning } from '../lib/reasoning-buffer';
import { applyFileEditFrame, clearFileEdits } from '../lib/file-edit-buffer';
import {
  canApplyOptimisticSelection,
  rollbackModelPicker,
  shouldApplyModelPickerAnswer,
  type ModelPickerSnapshot,
} from '../lib/model-picker-parity';
import {
  appendCommandOutput,
  projectCommandTail,
  type CommandTailProjection,
} from './command-projection';
import { accessPresetForNewTask, rememberAccessPreset } from '../lib/access-preset-preference';

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
  /** Set when the terminal event arrives so completed-work duration freezes truthfully. Historical
   * snapshots do not currently carry this timestamp; restored turns omit it instead of guessing. */
  finishedAt?: number;
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

/** The Model Picker slice's shape (UI slice U1b). Declared in lib/model-picker-parity.ts alongside
 * the staleness rules that operate on it, so the picker and the store cannot disagree about what a
 * snapshot means; re-exported here because this is where callers already look for it. */
export type ModelPickerState = ModelPickerSnapshot;

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

/** The Team policy record, mirroring `teamPolicySchema` in packages/contracts (Team v2 Core C4b).
 *
 * Spelled out here rather than imported from the renderer's ambient `TeamSummary`, which does not
 * describe the field's shape — and declared in the store, not in the dialog that edits it, so the
 * component can import it as a type without the store ever depending on a component. */
export type TeamPolicyValues = {
  maxAgentDepth: number;
  maxConcurrentExecutions: number;
  allowWorkerDirectMessages: boolean;
  budgetMode: 'bounded' | 'unlimited';
};

export type ProjectLoadState =
  'loading' | 'ready' | 'refreshing' | 'stale' | 'error' | 'unavailable';

export function projectRefreshState(
  previous: ProjectLoadState,
  outcome: 'start' | 'success' | 'failure',
): ProjectLoadState {
  if (outcome === 'success') return 'ready';
  const hasSuccessfulResult =
    previous === 'ready' || previous === 'refreshing' || previous === 'stale';
  if (outcome === 'start') return hasSuccessfulResult ? 'refreshing' : 'loading';
  return hasSuccessfulResult ? 'stale' : 'error';
}

type AppState = {
  sprintCoderAvailable: boolean;
  initialized: boolean;
  loadingTasks: boolean;
  loadingMessages: boolean;
  error: string | null;

  tasks: TaskSummary[];
  projects: ProjectSummary[];
  projectLoadState: ProjectLoadState;
  projectLoadError: string | null;
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
  skillCatalog: SkillCatalogItem[];
  skillCatalogRevision: string | null;
  skillSelectionByTask: Record<string, TurnSkillSelection[] | undefined>;
  skillDraftsByTask: Record<string, { turnId: string; draft: SkillDraft }[]>;
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
   * which is the order the edits actually happened. */
  fileChangesByTask: Record<string, { seq: number; turnId: string; changes: FileChange[] }[]>;
  /** The Task whose live file bodies are currently buffered (issue #39). The bodies themselves live
   * in lib/file-edit-buffer.ts; this is only the signal that there is something to show. */
  liveEditTaskId: string | null;
  resolvingApprovalIds: Record<string, boolean | undefined>;
  pendingOptimisticIdByTask: Record<string, string | undefined>;
  teamByTask: Record<string, TeamDetail | null | undefined>;
  teamViewOpen: boolean;
  teamBusy: boolean;

  /** Runtime (Mock/Codex) selection surfaced by the Composer runtime chip (FR-SET-03).
   * Defaults to Mock/unavailable until `settings.getRuntime` resolves (or forever if the
   * backend hasn't wired the `settings` API yet — see `loadRuntime`). */
  runtime: RuntimeState;

  /** Flag + canonical selection for the multi-provider Model Picker (UI slice U1b). */
  modelPicker: ModelPickerState;

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
  settingsWorkspaceV2: boolean;
  /** Latest Runtime process liveness, pushed by main. Null until the first transition. */
  runtimeStatus: RuntimeStatus | null;

  /** Latest stage/turn-completion announcement text for the aria-live region (NFR-A11Y-03). */
  stageAnnouncement: string;
  /** Ephemeral toast for non-fatal notices (e.g. STEER_STALE). */
  toast: { id: number; message: string } | null;

  init(): Promise<void>;
  loadRuntime(): Promise<void>;
  loadModelPicker(taskId: string): Promise<void>;
  setModelSelection(taskId: string, selection: ModelSelection): Promise<void>;
  acknowledgeRecovery(): void;
  setRuntime(kind: RuntimeKind): Promise<void>;
  setModel(model: string): Promise<void>;
  setEffort(effort: ClaudeEffort): Promise<void>;
  setCodexEffort(effort: string): Promise<void>;
  setAccessPreset(taskId: string, preset: AccessPreset): Promise<void>;
  resolveApproval(taskId: string, approvalId: string, decision: ApprovalDecision): Promise<void>;
  selectTask(taskId: string): Promise<void>;
  createTask(projectId?: string): Promise<TaskSummary | null>;
  refreshProjects(): Promise<void>;
  createProject(name: string): Promise<ProjectSummary | null>;
  updateProject(
    projectId: string,
    expectedRevision: number,
    patch: { name?: string; archived?: boolean },
  ): Promise<ProjectSummary | null>;
  assignTaskToProject(taskId: string, projectId: string): Promise<TaskSummary | null>;
  unassignTaskFromProject(taskId: string): Promise<TaskSummary | null>;
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
  resumeTeamMission(taskId: string, missionId: string): Promise<void>;
  stopAllTeamWorkers(taskId: string): Promise<void>;
  /** Writes the whole policy under an optimistic-concurrency check (Team v2 Core C4b).
   *
   * Resolves rather than throws, and reports the failure to the CALLER instead of the global
   * `error` banner: the only caller is a modal form that has to stay open, keep the user's edits
   * and show the reason inline. A rejected save writes nothing to `teamByTask`. */
  updateTeamPolicy(
    taskId: string,
    policy: TeamPolicyValues,
    expectedRevision: number,
  ): Promise<{ ok: true } | { ok: false; message: string }>;
  setDraft(taskId: string, text: string): void;
  loadSkills(): Promise<void>;
  setSkillSelection(taskId: string, skills: TurnSkillSelection[]): Promise<void>;
  installSkillDraft(taskId: string, draft: SkillDraft): Promise<void>;
  discardSkillDraft(taskId: string, draftId: string): Promise<void>;
  startTurn(taskId: string, text: string, skills?: readonly TurnSkillSelection[]): Promise<void>;
  queueMessage(taskId: string, text: string, skills?: readonly TurnSkillSelection[]): Promise<void>;
  steerMessage(taskId: string, text: string, expectedTurnId: string): Promise<void>;
  stopAndSend(taskId: string, text: string, skills?: readonly TurnSkillSelection[]): Promise<void>;
  cancelActiveTurn(taskId: string): Promise<void>;
  showToast(message: string): void;
  dismissToast(): void;
};

// Reasoning is subscribed once for the window's lifetime, guarded like the other subscriptions
// above. Without the guard, `init()` — called from an effect with `[]` deps — registers a second
// listener under StrictMode's deliberate double-invocation in dev, and every fragment is appended
// twice. Caught by looking at the rendered panel: every paragraph was duplicated.
let reasoningUnsubscribe: (() => void) | null = null;
let fileEditUnsubscribe: (() => void) | null = null;
let currentUnsubscribe: (() => void) | null = null;
let currentTeamUnsubscribe: (() => void) | null = null;
let projectRefreshToken = 0;
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

async function restoreSkillSelection(
  taskId: string,
  apply: (fn: (state: AppState) => Partial<AppState>) => void,
  get: () => AppState,
) {
  if (
    !window.sprintCoder ||
    typeof window.sprintCoder.skills?.getDraftSelection !== 'function' ||
    get().skillSelectionByTask[taskId] !== undefined
  )
    return;
  try {
    const skills = await window.sprintCoder.skills.getDraftSelection(taskId);
    if (get().selectedTaskId === taskId && get().skillSelectionByTask[taskId] === undefined)
      apply((state) => ({
        skillSelectionByTask: { ...state.skillSelectionByTask, [taskId]: skills },
      }));
  } catch {
    // A missing optional API must not block the composer.
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

/** Hands out a start-order token to every canonical-selection read and write (UI slice U2).
 *
 * The `models` calls are plain promises with no ordering guarantee of their own, and three things
 * race for the same one-slot snapshot: the per-Task read on switch, the re-read after a legacy
 * Runtime/Model write, and the V2 picker's own write. Comparing the token an answer was issued
 * under against the newest one issued makes "an older intent must not land on a newer one"
 * decidable without the callers knowing about each other. */
let modelPickerToken = 0;

/** Re-reads the canonical selection after a *legacy* Runtime/Model write (UI slice U1b).
 *
 * Both surfaces can be on screen at once — the Settings dialog's native model select and the V2
 * picker in the Composer — and Main derives one from the other, so a legacy write silently moves
 * what the V2 picker should be showing as selected. No-ops before a Task is selected, because there
 * is no per-Task selection to re-read yet. */
async function refreshModelPicker(get: () => AppState): Promise<void> {
  const taskId = get().selectedTaskId;
  if (taskId === null) return;
  await get().loadModelPicker(taskId);
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
    case 'skill.draft.created': {
      apply((state) => ({
        skillDraftsByTask: {
          ...state.skillDraftsByTask,
          [taskId]: [
            ...(state.skillDraftsByTask[taskId] ?? []).filter(
              ({ draft }) => draft.id !== ev.draft.id,
            ),
            { turnId: ev.turnId, draft: ev.draft },
          ],
        },
      }));
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
          turnByTask: {
            ...state.turnByTask,
            [taskId]: { ...turn, status: ev.state, finishedAt: Date.now() },
          },
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
    case 'file.saved': {
      // The user's own save (issue #43). Deliberately NOT merged into fileChangesByTask: that list is
      // what the Runtime did. Nothing in the store needs the path today — the case exists so the
      // event is handled rather than silently dropped, and so a
      // future audit view has an obvious place to hook in.
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
    projects: [],
    projectLoadState:
      typeof window !== 'undefined' && typeof window.sprintCoder?.projects?.list === 'function'
        ? 'loading'
        : 'unavailable',
    projectLoadError: null,
    selectedTaskId: null,
    messagesByTask: {},
    turnByTask: {},
    queuedByTask: {},
    contextUsageByTask: {},
    lastSeqByTask: {},
    sendingByTask: {},
    draftByTask: {},
    skillCatalog: [],
    skillCatalogRevision: null,
    skillSelectionByTask: {},
    skillDraftsByTask: {},
    workspaceByTask: {},
    permissionByTask: {},
    approvalsByTask: {},
    approvalHistoryByTask: {},
    autoDecisionsByTask: {},
    commandsByTask: {},
    turnDiffByTask: {},
    imagesByTask: {},
    fileChangesByTask: {},
    liveEditTaskId: null,
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
    modelPicker: { taskId: null, enabled: null, selection: null },
    reasoningSeenByTurn: {},
    recovery: null,
    recoveryAcknowledged: false,
    settingsWorkspaceV2: true,
    runtimeStatus: null,
    stageAnnouncement: '',
    toast: null,

    async init() {
      if (!window.sprintCoder) {
        set({ sprintCoderAvailable: false, initialized: true });
        return;
      }
      set({ sprintCoderAvailable: true, loadingTasks: true, error: null });
      void get().refreshProjects();
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
      // Live file bodies (issue #39). Guarded the same way reasoning is: init() runs twice under
      // StrictMode's deliberate double-invocation, and a second listener would apply every frame
      // twice — harmless for a cumulative body, but it doubles the work at typing speed.
      if (fileEditUnsubscribe !== null) {
        fileEditUnsubscribe();
        fileEditUnsubscribe = null;
      }
      if (typeof window.sprintCoder.fileEdits?.subscribe === 'function')
        fileEditUnsubscribe = window.sprintCoder.fileEdits.subscribe((frame) => {
          applyFileEditFrame(frame);
          // One boolean in the store, so the panel can mount the live view without subscribing to
          // the body itself. The text stays in the module buffer for the same reason reasoning does.
          set((state) =>
            state.liveEditTaskId === frame.taskId ? {} : { liveEditTaskId: frame.taskId },
          );
        });
      // Startup recovery outcome and Runtime liveness both feed the SurfaceFooter (issue #9).
      // Both are best-effort: an older backend simply leaves the footer's quiet default in place.
      if (typeof window.sprintCoder.app?.getInfo === 'function')
        void window.sprintCoder.app
          .getInfo()
          .then((info) => {
            if (info.recovery !== undefined)
              set({
                recovery: info.recovery,
                settingsWorkspaceV2: info.settingsWorkspaceV2 ?? true,
              });
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

    // Every legacy runtime read/write below carries the selected Task id (UI slice U1b). Main
    // resolves that against the same per-Task canonical model selection the V2 picker writes
    // through `models.setSelection`, so the old chips and the new one cannot drift into two
    // different notions of "the model this Task uses" — a Task-less call would read and write the
    // global fallback instead. The id is taken from the store rather than added to each action's
    // signature so the callers that predate this (SettingsDialog, the Composer chips) get the
    // canonical behaviour without changing.
    async loadRuntime() {
      if (!window.sprintCoder || typeof window.sprintCoder.settings?.getRuntime !== 'function')
        return;
      const taskId = get().selectedTaskId;
      try {
        const runtime = await window.sprintCoder.settings.getRuntime(taskId ?? undefined);
        // A slow answer for a Task the user has already left would overwrite the newer one.
        if (get().selectedTaskId !== taskId) return;
        set({ runtime });
      } catch {
        // Non-fatal: keep the last-known (or default) runtime state.
      }
    },

    /** Resolves the Model Picker flag and Main's canonical selection for `taskId`.
     *
     * Uses the smallest possible catalog query (one row) — the answer this needs is the envelope,
     * not the page. The picker fetches real pages itself, and only while it is open. */
    async loadModelPicker(taskId: string) {
      // Claimed before the call so a read started earlier can no longer win, even on the
      // synchronous path below.
      const token = (modelPickerToken += 1);
      if (!window.sprintCoder || typeof window.sprintCoder.models?.query !== 'function') {
        // No `models` API at all: the Composer must keep the legacy chip forever, not wait.
        set({ modelPicker: { taskId, enabled: false, selection: null } });
        return;
      }
      const applies = () =>
        shouldApplyModelPickerAnswer({
          requestTaskId: taskId,
          requestToken: token,
          currentTaskId: get().selectedTaskId,
          latestToken: modelPickerToken,
        });
      try {
        const result = await window.sprintCoder.models.query({
          taskId,
          text: '',
          connectionIds: [],
          providerIds: [],
          accessTypes: [],
          capabilities: [],
          availableOnly: true,
          cursor: null,
          limit: 1,
        });
        // Stale two ways: the Task moved on, or a newer read/write was started while this was in
        // flight — a read that predates the user's latest choice would silently undo it.
        if (!applies()) return;
        set({
          modelPicker: {
            taskId,
            enabled: result.multiProviderModelPickerV2,
            selection: result.selection,
          },
        });
      } catch {
        // A failed probe degrades to the legacy chip rather than to no picker at all.
        if (!applies()) return;
        set({ modelPicker: { taskId, enabled: false, selection: null } });
      }
    },

    /** Writes the canonical per-Task model selection (UI slice U1b).
     *
     * Optimistic like the other selectors here, and followed by `loadRuntime()` so the legacy
     * Runtime/Effort chips reflect the same choice — Main derives the built-in runtime kind and
     * model from the selection, so leaving them stale would show two answers at once. */
    async setModelSelection(taskId: string, selection: ModelSelection) {
      if (!window.sprintCoder || typeof window.sprintCoder.models?.setSelection !== 'function')
        return;
      const previous = get().modelPicker;
      // A write is an intent too, so it takes a token: an in-flight read issued before it must not
      // land afterwards and undo the choice the user just made.
      const token = (modelPickerToken += 1);
      // Optimistic only against this Task's own snapshot — writing it over another Task's would
      // have to invent that Task's `enabled`, and guessing there swaps the whole picker.
      if (canApplyOptimisticSelection(previous, taskId))
        set({ modelPicker: { taskId, enabled: previous.enabled, selection } });
      try {
        const saved = await window.sprintCoder.models.setSelection(taskId, selection);
        if (
          shouldApplyModelPickerAnswer({
            requestTaskId: taskId,
            requestToken: token,
            currentTaskId: get().selectedTaskId,
            latestToken: modelPickerToken,
          })
        )
          // `enabled` is re-read rather than reused from `previous`: a read may have resolved the
          // flag while this write was in flight, and reinstating the older value would flip the
          // Composer back to the legacy chip for no reason.
          set({ modelPicker: { taskId, enabled: get().modelPicker.enabled, selection: saved } });
        await get().loadRuntime();
      } catch (err) {
        // Task-safe: only undoes this write, and only while the store still holds it. A rejection
        // that arrives after the user switched Tasks must not restore the old Task's snapshot over
        // the new one — that would strand the Composer on another Task's selection (or on its
        // `enabled`, dropping it back to the legacy chip).
        set({
          modelPicker: rollbackModelPicker({
            current: get().modelPicker,
            previous,
            taskId,
            attempted: selection,
          }),
        });
        set({ error: describeError(err) });
      }
    },

    async setRuntime(kind: RuntimeKind) {
      if (!window.sprintCoder || typeof window.sprintCoder.settings?.setRuntime !== 'function')
        return;
      const previous = get().runtime;
      if (previous.kind === kind) return;
      set({ runtime: { ...previous, kind } });
      try {
        await window.sprintCoder.settings.setRuntime(kind, get().selectedTaskId ?? undefined);
        await get().loadRuntime();
        await refreshModelPicker(get);
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
        await window.sprintCoder.settings.setModel(model, get().selectedTaskId ?? undefined);
        await get().loadRuntime();
        await refreshModelPicker(get);
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
        rememberAccessPreset(preset);
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
      // Live bodies belong to the Task that produced them; carrying them across a switch would show
      // one Task's file under another's name (issue #39).
      if (get().selectedTaskId !== taskId) {
        clearFileEdits();
        set({ liveEditTaskId: null });
      }
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
      void restoreSkillSelection(taskId, apply, get);
      void get().loadSkills();
      void loadWorkspace(taskId, apply, get);
      void loadPermission(taskId, apply, get);
      // The model selection is per-Task (UI slice U1b), so both the legacy chips' source and the
      // V2 picker's flag/selection have to be re-read on every switch — not just at init.
      void get().loadRuntime();
      void get().loadModelPicker(taskId);
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
        if (typeof sprintCoder.teams.subscribe === 'function') {
          let lastTeamEventSeq = 0;
          currentTeamUnsubscribe = sprintCoder.teams.subscribe(taskId, (event) => {
            if (event.type === 'updated') {
              if (event.seq <= lastTeamEventSeq) return;
              if (lastTeamEventSeq !== 0 && event.seq !== lastTeamEventSeq + 1) {
                lastTeamEventSeq = event.seq;
                void sprintCoder.teams.get(taskId).then((fresh) => {
                  if (get().selectedTaskId === taskId)
                    set((state) => ({
                      teamByTask: { ...state.teamByTask, [taskId]: fresh },
                    }));
                });
                return;
              }
              lastTeamEventSeq = event.seq;
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
            }
          });
        }
      }
    },

    async createTask(projectId?: string) {
      if (!window.sprintCoder) return null;
      set({ error: null });
      try {
        const task = await window.sprintCoder.tasks.create(
          projectId === undefined ? {} : { projectId },
        );
        set((state) => ({ tasks: [task, ...state.tasks] }));
        await get().selectTask(task.id);
        const preset = accessPresetForNewTask();
        if (preset !== 'ask') await get().setAccessPreset(task.id, preset);
        if (projectId !== undefined) void get().refreshProjects();
        return task;
      } catch (err) {
        set({ error: describeError(err) });
        return null;
      }
    },

    async refreshProjects() {
      if (!window.sprintCoder || typeof window.sprintCoder.projects?.list !== 'function') {
        projectRefreshToken += 1;
        set({ projectLoadState: 'unavailable', projectLoadError: null });
        return;
      }
      const requestToken = ++projectRefreshToken;
      const previous = get().projectLoadState;
      set({
        projectLoadState: projectRefreshState(previous, 'start'),
        projectLoadError: null,
      });
      try {
        const projects = await window.sprintCoder.projects.list();
        if (requestToken !== projectRefreshToken) return;
        set({
          projects,
          projectLoadState: projectRefreshState(previous, 'success'),
          projectLoadError: null,
        });
      } catch (err) {
        if (requestToken !== projectRefreshToken) return;
        set({
          projectLoadState: projectRefreshState(previous, 'failure'),
          projectLoadError: describeError(err),
        });
      }
    },

    async createProject(name: string) {
      if (!window.sprintCoder || typeof window.sprintCoder.projects?.create !== 'function')
        return null;
      try {
        const created = await window.sprintCoder.projects.create({ name });
        set((state) => ({ projects: [created, ...state.projects], projectLoadState: 'ready' }));
        return created;
      } catch (err) {
        set({ error: describeError(err) });
        return null;
      }
    },

    async updateProject(projectId, expectedRevision, patch) {
      if (!window.sprintCoder || typeof window.sprintCoder.projects?.update !== 'function')
        return null;
      try {
        const updated = await window.sprintCoder.projects.update({
          projectId,
          expectedRevision,
          ...patch,
        });
        set((state) => ({
          projects: state.projects.map((project) => (project.id === projectId ? updated : project)),
        }));
        return updated;
      } catch (err) {
        set({ error: describeError(err) });
        void get().refreshProjects();
        return null;
      }
    },

    async assignTaskToProject(taskId, projectId) {
      if (!window.sprintCoder || typeof window.sprintCoder.projects?.assignTask !== 'function')
        return null;
      const task = get().tasks.find(({ id }) => id === taskId);
      if (task === undefined) return null;
      try {
        const updated = await window.sprintCoder.projects.assignTask({
          projectId,
          taskId,
          expectedProjectId: task.projectId,
        });
        set((state) => ({
          tasks: state.tasks.map((candidate) => (candidate.id === taskId ? updated : candidate)),
        }));
        void get().refreshProjects();
        return updated;
      } catch (err) {
        set({ error: describeError(err) });
        return null;
      }
    },

    async unassignTaskFromProject(taskId) {
      if (!window.sprintCoder || typeof window.sprintCoder.projects?.unassignTask !== 'function')
        return null;
      const task = get().tasks.find(({ id }) => id === taskId);
      if (task === undefined) return null;
      try {
        const updated = await window.sprintCoder.projects.unassignTask({
          taskId,
          expectedProjectId: task.projectId,
        });
        set((state) => ({
          tasks: state.tasks.map((candidate) => (candidate.id === taskId ? updated : candidate)),
        }));
        void get().refreshProjects();
        return updated;
      } catch (err) {
        set({ error: describeError(err) });
        return null;
      }
    },

    async renameTask(taskId: string, title: string) {
      if (!window.sprintCoder) return;
      const trimmed = title.trim();
      if (!trimmed) return;
      try {
        const updated = await window.sprintCoder.tasks.rename(taskId, trimmed);
        set((state) => ({ tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)) }));
        if (updated.projectId !== null) void get().refreshProjects();
      } catch (err) {
        set({ error: describeError(err) });
      }
    },

    async setPinned(taskId: string, pinned: boolean) {
      if (!window.sprintCoder || typeof window.sprintCoder.tasks.setPinned !== 'function') return;
      try {
        const updated = await window.sprintCoder.tasks.setPinned(taskId, pinned);
        set((state) => ({ tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)) }));
        if (updated.projectId !== null) void get().refreshProjects();
      } catch (err) {
        set({ error: describeError(err) });
      }
    },

    async setArchived(taskId: string, archived: boolean) {
      if (!window.sprintCoder || typeof window.sprintCoder.tasks.setArchived !== 'function') return;
      try {
        const updated = await window.sprintCoder.tasks.setArchived(taskId, archived);
        set((state) => ({ tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)) }));
        if (updated.projectId !== null) void get().refreshProjects();
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
    async resumeTeamMission(taskId: string, missionId: string) {
      set({ teamBusy: true, error: null });
      try {
        await window.sprintCoder!.teams.resumeMission({ taskId, missionId });
        const detail = await window.sprintCoder!.teams.get(taskId);
        set((state) => ({
          teamByTask: { ...state.teamByTask, [taskId]: detail },
          teamBusy: false,
        }));
      } catch (error) {
        set({ teamBusy: false, error: describeError(error) });
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

    async updateTeamPolicy(
      taskId: string,
      policy: TeamPolicyValues,
      expectedRevision: number,
    ): Promise<{ ok: true } | { ok: false; message: string }> {
      if (typeof window.sprintCoder?.teams?.updatePolicy !== 'function')
        return { ok: false, message: 'この環境ではTeamのポリシーを変更できません。' };
      try {
        // `updatePolicy` returns the canonical TeamDetail, revision already bumped — so the store
        // takes the BACKEND's version wholesale rather than merging the form's values into the
        // detail it already had. There is no path here that writes a value the backend did not
        // confirm, which is what keeps the next save's `expectedRevision` honest.
        const detail = await window.sprintCoder.teams.updatePolicy({
          taskId,
          policy,
          expectedRevision,
        });
        set((state) => ({ teamByTask: { ...state.teamByTask, [taskId]: detail } }));
        return { ok: true };
      } catch (err) {
        // Stale revision and invalid hierarchy both land here. The backend's own message names
        // which one it was; the added sentence is the recovery step, because "何番目の版" is not
        // something a user can act on by itself.
        return {
          ok: false,
          message: `保存できませんでした: ${describeError(err)} — Teamの状態が変わっている可能性があります。いったん閉じて最新の内容を読み込んでから、もう一度お試しください。`,
        };
      }
    },

    setDraft(taskId: string, text: string) {
      set((state) => ({ draftByTask: { ...state.draftByTask, [taskId]: text } }));
      persistDraftDebounced(taskId, text);
    },

    async loadSkills() {
      if (!window.sprintCoder || typeof window.sprintCoder.skills?.list !== 'function') return;
      try {
        const catalog = await window.sprintCoder.skills.list();
        if (get().skillCatalogRevision === catalog.revision) return;
        set({ skillCatalog: catalog.items, skillCatalogRevision: catalog.revision });
      } catch {
        // Skills are additive. Chat remains usable when the catalog cannot be loaded.
      }
    },

    async setSkillSelection(taskId: string, skills: TurnSkillSelection[]) {
      const previous = get().skillSelectionByTask[taskId] ?? [];
      set((state) => ({
        skillSelectionByTask: { ...state.skillSelectionByTask, [taskId]: [...skills] },
      }));
      if (!window.sprintCoder || typeof window.sprintCoder.skills?.setDraftSelection !== 'function')
        return;
      try {
        await window.sprintCoder.skills.setDraftSelection(taskId, [...skills]);
      } catch (err) {
        set((state) => ({
          skillSelectionByTask: { ...state.skillSelectionByTask, [taskId]: previous },
          error: describeError(err),
        }));
      }
    },

    async installSkillDraft(taskId: string, draft: SkillDraft) {
      if (typeof window.sprintCoder?.skills?.installDraft !== 'function') return;
      try {
        await window.sprintCoder.skills.installDraft(draft.id, draft.digest, true);
        set((state) => ({
          skillDraftsByTask: {
            ...state.skillDraftsByTask,
            [taskId]: (state.skillDraftsByTask[taskId] ?? []).filter(
              ({ draft: item }) => item.id !== draft.id,
            ),
          },
        }));
        await get().loadSkills();
      } catch (err) {
        set({ error: describeError(err) });
      }
    },

    async discardSkillDraft(taskId: string, draftId: string) {
      if (typeof window.sprintCoder?.skills?.discardDraft !== 'function') return;
      try {
        await window.sprintCoder.skills.discardDraft(draftId);
        set((state) => ({
          skillDraftsByTask: {
            ...state.skillDraftsByTask,
            [taskId]: (state.skillDraftsByTask[taskId] ?? []).filter(
              ({ draft }) => draft.id !== draftId,
            ),
          },
        }));
      } catch (err) {
        set({ error: describeError(err) });
      }
    },

    async startTurn(taskId: string, text: string, skills) {
      const trimmed = text.trim();
      if (!trimmed || !window.sprintCoder) return;
      const selectedSkills = [...(skills ?? get().skillSelectionByTask[taskId] ?? [])];
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
        skillSelectionByTask: { ...state.skillSelectionByTask, [taskId]: [] },
      }));
      persistDraftDebounced(taskId, '');
      persistSkillDraftSelection(taskId, []);

      try {
        const result = await window.sprintCoder.turns.start({
          taskId,
          text: trimmed,
          skills: selectedSkills,
        });
        // turn.accepted event (delivered via subscription) reconciles the optimistic message.
        // A DB Task exists before this point so per-Task settings have a stable id, but it becomes
        // conversation history only after this acceptance succeeds. `renamedTask` is present only
        // when the first message also produced an automatic title (issue #4).
        const renamed = result?.renamedTask;
        set((state) => ({
          tasks: state.tasks.map((task) =>
            task.id === taskId
              ? {
                  ...(renamed ?? task),
                  hasConversation: true,
                }
              : task,
          ),
        }));
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
          skillSelectionByTask: {
            ...state.skillSelectionByTask,
            [taskId]: selectedSkills,
          },
          error: code === 'TURN_ACTIVE' ? null : describeError(err),
        }));
        persistSkillDraftSelection(taskId, selectedSkills);
        if (code === 'TURN_ACTIVE') {
          get().showToast('すでに実行中です。もう一度送信するとキューに追加されます');
        }
      }
    },

    async queueMessage(taskId: string, text: string, skills) {
      const trimmed = text.trim();
      if (!trimmed || !window.sprintCoder || typeof window.sprintCoder.turns.queue !== 'function')
        return;
      const selectedSkills = [...(skills ?? get().skillSelectionByTask[taskId] ?? [])];
      set((state) => ({
        draftByTask: { ...state.draftByTask, [taskId]: '' },
        skillSelectionByTask: { ...state.skillSelectionByTask, [taskId]: [] },
      }));
      persistDraftDebounced(taskId, '');
      persistSkillDraftSelection(taskId, []);
      try {
        await window.sprintCoder.turns.queue({ taskId, text: trimmed, skills: selectedSkills });
        // queue.changed (delivered via subscription) reconciles the compact queued list.
      } catch (err) {
        set((state) => ({
          draftByTask: { ...state.draftByTask, [taskId]: trimmed },
          skillSelectionByTask: {
            ...state.skillSelectionByTask,
            [taskId]: selectedSkills,
          },
          error: describeError(err),
        }));
        persistSkillDraftSelection(taskId, selectedSkills);
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

    async stopAndSend(taskId: string, text: string, skills) {
      const trimmed = text.trim();
      if (
        !trimmed ||
        !window.sprintCoder ||
        typeof window.sprintCoder.turns.stopAndSend !== 'function'
      )
        return;
      const selectedSkills = [...(skills ?? get().skillSelectionByTask[taskId] ?? [])];
      set((state) => ({
        draftByTask: { ...state.draftByTask, [taskId]: '' },
        skillSelectionByTask: { ...state.skillSelectionByTask, [taskId]: [] },
      }));
      persistDraftDebounced(taskId, '');
      persistSkillDraftSelection(taskId, []);
      try {
        await window.sprintCoder.turns.stopAndSend({
          taskId,
          text: trimmed,
          skills: selectedSkills,
        });
      } catch (err) {
        set((state) => ({
          draftByTask: { ...state.draftByTask, [taskId]: trimmed },
          skillSelectionByTask: {
            ...state.skillSelectionByTask,
            [taskId]: selectedSkills,
          },
          error: describeError(err),
        }));
        persistSkillDraftSelection(taskId, selectedSkills);
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
function persistSkillDraftSelection(taskId: string, skills: readonly TurnSkillSelection[]): void {
  const setter = window.sprintCoder?.skills?.setDraftSelection;
  if (typeof setter !== 'function') return;
  void setter(taskId, [...skills]).catch(() => undefined);
}

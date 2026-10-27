import { create } from 'zustand';
import { applyTeamDetailPatch } from '@sprint-coder/contracts';
import type {
  GraphView,
  ModelSelection,
  ResolvedCliCommand,
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
  CommandSandboxCapability,
  FileChange,
  GeneratedImage,
  ImageAttachmentCapability,
  ImageAttachmentMetadata,
  QueuedInput,
  PermissionSettings,
  DatabaseRecovery,
  RuntimeKind,
  RuntimeStatus,
  UpdateHealth,
  ProjectSummary,
  ProjectFolder,
  ProjectFolderInput,
  TaskSummary,
  TeamDetail,
  TurnDiff,
  TurnEvent,
} from '../types/sprint-coder';
import { STAGE_LABEL } from '../lib/stages';
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
import { playSoundForEvent } from '../lib/ui-sound';
import {
  applyTaskTurnEvent,
  hydrateTaskTurn,
  type TaskTurnEvent,
  type TurnRuntimeState,
  type TurnStatus,
} from './task-turn-projection';

export type { TurnStatus, TurnRuntimeState } from './task-turn-projection';

export type StopAndSendResult = Readonly<{
  completed: boolean;
  draftRestored: boolean;
}>;

export type WorkspaceInfo = { path: string; name: string };

export type RuntimeState = {
  kind: RuntimeKind;
  codexAvailable: boolean;
  codexReadiness: 'ready' | 'authentication_required' | 'unavailable';
  claudeAvailable: boolean;
  claudeReadiness: 'ready' | 'authentication_required' | 'unavailable';
  grokAvailable: boolean;
  grokReadiness: 'ready' | 'authentication_required' | 'unavailable';
  codexCli: ResolvedCliCommand | null;
  claudeCli: ResolvedCliCommand | null;
  grokCli: ResolvedCliCommand | null;
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
  // Optimistic send recovery owns a value only while its captured revision is still current.
  // Every user mutation and recovery advances the revision, so value-level ABA cannot roll back it.
  draftRevisionByTask: Record<string, number | undefined>;
  goalDraftRecoveryRevisionByTask: Record<string, number | undefined>;
  draftAttachmentsByTask: Record<string, ImageAttachmentMetadata[] | undefined>;
  attachmentCapabilityByTask: Record<string, ImageAttachmentCapability | undefined>;
  attachmentRequestRevisionByTask: Record<string, number | undefined>;
  attachmentBusyByTask: Record<string, boolean | undefined>;
  attachmentReconciliationByTask: Record<
    string,
    | {
        minimumRequestRevision: number;
        status: 'loading' | 'error';
        mutationError?: string;
      }
    | undefined
  >;
  attachmentErrorByTask: Record<string, string | undefined>;
  attachmentAnnouncementByTask: Record<string, string | undefined>;
  skillCatalog: SkillCatalogItem[];
  skillCatalogRevision: string | null;
  skillSelectionByTask: Record<string, TurnSkillSelection[] | undefined>;
  // Same ownership invariant as drafts; includes asynchronous selection-persistence rollback.
  skillSelectionRevisionByTask: Record<string, number | undefined>;
  skillDraftsByTask: Record<string, { turnId: string; draft: SkillDraft }[]>;
  activatedSkillsByTask: Record<
    string,
    { turnId: string; ref: TurnSkillSelection['ref']; name: string }[]
  >;
  workspaceByTask: Record<string, WorkspaceInfo | null | undefined>;
  permissionByTask: Record<string, PermissionSettings | undefined>;
  permissionChangeByTask: Record<string, AccessPreset | undefined>;
  approvalsByTask: Record<string, ApprovalSummary[]>;
  approvalHistoryByTask: Record<string, ApprovalSummary[]>;
  autoDecisionsByTask: Record<string, AutoPermissionDecision[]>;
  autoDecisionCountsByTask: Record<string, AutoDecisionCountState>;
  commandsByTask: Record<string, CommandCardState[]>;
  turnDiffByTask: Record<string, TurnDiff | undefined>;
  /** Turns a restart closed as interrupted, from the task snapshot (issue #842). */
  interruptedTurnIdsByTask: Record<string, readonly string[]>;
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
  teamLoadFailedByTask: Record<string, boolean>;
  /** The graph panel opens on request, never from a button: Main's `graphsUpdated` push raises one
   * for the selected Task the moment a graph tool rendered a diagram, and the inline graph card in
   * the transcript raises one again after the panel was closed. `nonce` distinguishes repeats. */
  graphOpenRequest: { taskId: string; nonce: number } | null;
  /** Saved graph versions per Task, newest first, loaded with the Task and kept current from
   * `graphsUpdated`. An inline anchor only becomes a card when it names one of these, and a Task
   * whose transcript carries no anchor (a graph from before anchors existed) gets a saved-graph
   * card instead, so no graph is ever unreachable. */
  graphVersionsByTask: Record<string, GraphVersionRef[] | undefined>;
  /** Whether `graphVersionsByTask` can be trusted yet: an anchor is only judged forged once the
   * history has actually loaded; while it loads, or if it cannot be read, the card shows a
   * placeholder rather than either a card or the raw anchor. */
  graphVersionsStateByTask: Record<string, GraphVersionsState | undefined>;
  teamBusy: boolean;
  teamBusyByTask: Record<string, boolean>;
  projectSwitchingByTask: Record<string, boolean | undefined>;

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
  /** Installed application version reported by Electron. Null until app.getInfo resolves. */
  appVersion: string | null;
  commandSandbox: CommandSandboxCapability | null;
  /** Whether the recovery notice has been dismissed. A launch-scoped fact, so acknowledging it
   * should not require persistence — it simply stops being shown for this session. */
  recoveryAcknowledged: boolean;
  settingsWorkspaceV2: boolean;
  projectMultiFolderUx: boolean;
  /** Latest Runtime process liveness, pushed by main. Null until the first transition. */
  runtimeStatus: RuntimeStatus | null;
  /** Persisted updater health. Raw updater errors and local paths never cross into Renderer. */
  updateHealth: UpdateHealth | null;

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
  resolveApproval(
    taskId: string,
    approvalId: string,
    decision: ApprovalDecision,
    userInputSelection?: number,
  ): Promise<void>;
  selectTask(taskId: string): Promise<void>;
  createTask(projectId?: string): Promise<TaskSummary | null>;
  refreshProjects(): Promise<void>;
  createProject(name: string, folders?: ProjectFolderInput[]): Promise<ProjectSummary | null>;
  pickProjectFolders(): Promise<
    { canceled: true } | { canceled: false; folders: Array<{ path: string; label: string }> }
  >;
  listProjectFolders(projectId: string): Promise<ProjectFolder[] | null>;
  replaceProjectFolders(
    projectId: string,
    expectedRevision: number,
    folders: ProjectFolderInput[],
  ): Promise<ProjectSummary | null>;
  setProjectSwitching(taskId: string, switching: boolean): void;
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
  startGoal(taskId: string, objective: string): Promise<boolean>;
  restoreFailedGoalDraft(taskId: string, expectedRevision: number, text: string): boolean;
  pauseGoal(taskId: string): Promise<void>;
  resumeGoal(taskId: string): Promise<void>;
  clearGoal(taskId: string): Promise<void>;
  toggleTeamView(taskId: string): Promise<void>;
  // No hireTeamWorker/sendTeamMessage actions here: the Leader hires and dispatches Workers on
  // its own during its Turn (FR-TEAM-06/13, main/team-tools.ts) — the user only ever converses
  // with the Leader through the normal Turn actions below. `window.sprintCoder.teams.hireWorker`/
  // `sendToWorker` IPC still exist (main/ipc.ts keeps them wired), they're just never called from
  // the renderer anymore. `stopTeamWorker`/`stopAllTeamWorkers` stay: FR-TEAM-13 keeps stop as a
  // user override.
  stopTeamWorker(taskId: string, agentId: string): Promise<void>;
  resumeTeamMission(taskId: string, missionId: string): Promise<void>;
  resumeTeamExecutionIntegration(taskId: string, executionId: string): Promise<void>;
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
  requestGraphOpen(taskId: string): void;
  loadGraphVersions(taskId: string): Promise<void>;
  noteGraphVersion(view: GraphView): void;
  refreshDraftAttachments(taskId: string): Promise<void>;
  pickDraftAttachment(taskId: string): Promise<void>;
  pasteDraftAttachment(taskId: string): Promise<void>;
  setAttachmentError(taskId: string, message: string | undefined): void;
  removeDraftAttachment(taskId: string, attachmentId: string): Promise<boolean>;
  loadSkills(): Promise<void>;
  setSkillSelection(taskId: string, skills: TurnSkillSelection[]): Promise<void>;
  installSkillDraft(taskId: string, draft: SkillDraft): Promise<void>;
  discardSkillDraft(taskId: string, draftId: string): Promise<void>;
  /** Failure text for this request, or null when no separate error alert is needed. */
  startTurn(
    taskId: string,
    text: string,
    skills?: readonly TurnSkillSelection[],
    attachmentIds?: readonly string[],
  ): Promise<string | null>;
  queueMessage(
    taskId: string,
    text: string,
    skills?: readonly TurnSkillSelection[],
  ): Promise<boolean>;
  steerMessage(taskId: string, text: string, expectedTurnId: string): Promise<void>;
  stopAndSend(
    taskId: string,
    text: string,
    skills?: readonly TurnSkillSelection[],
  ): Promise<StopAndSendResult>;
  cancelActiveTurn(taskId: string, startNextQueued?: boolean): Promise<boolean>;
  showToast(message: string): void;
  dismissToast(): void;
};

// Reasoning is subscribed once for the window's lifetime, guarded like the other subscriptions
// above. Without the guard, `init()` — called from an effect with `[]` deps — registers a second
// listener under StrictMode's deliberate double-invocation in dev, and every fragment is appended
// twice. Caught by looking at the rendered panel: every paragraph was duplicated.
let reasoningUnsubscribe: (() => void) | null = null;
let fileEditUnsubscribe: (() => void) | null = null;
let taskUpdateUnsubscribe: (() => void) | null = null;
let updateHealthUnsubscribe: (() => void) | null = null;
let runtimeStatusUnsubscribe: (() => void) | null = null;
let currentUnsubscribe: (() => void) | null = null;
let currentTeamUnsubscribe: (() => void) | null = null;
let taskSelectionGeneration = 0;
// Advances only when the selected Task actually changes. A same-Task re-select (the Turn seq-gap
// resync) must not look like a switch to an in-flight Team operation, but A -> B -> A still does.
let taskSwitchGeneration = 0;
let projectRefreshToken = 0;
let currentSubscribedTaskId: string | null = null;
const draftSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const PERMISSION_CHANGE_PENDING_MESSAGE =
  '権限の変更が完了するまで送信できません。確認ダイアログが開いている場合は回答してください。';

export function attachmentDraftIsUnresolved(
  state: Pick<AppState, 'attachmentBusyByTask' | 'attachmentReconciliationByTask'>,
  taskId: string,
): boolean {
  return (
    state.attachmentBusyByTask[taskId] === true ||
    state.attachmentReconciliationByTask[taskId] !== undefined
  );
}

function notifyPendingPermissionChange(state: AppState, taskId: string): boolean {
  if (state.permissionChangeByTask[taskId] === undefined) return false;
  state.showToast(PERMISSION_CHANGE_PENDING_MESSAGE);
  return true;
}

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
    if ('turnId' in ev && get().turnByTask[taskId]?.turnId === ev.turnId) playSoundForEvent(ev);
    if (ev.type === 'turn.completed') void get().loadSkills();
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

export function removeAcceptedAttachmentDrafts(
  drafts: readonly ImageAttachmentMetadata[],
  accepted: readonly ImageAttachmentMetadata[],
): ImageAttachmentMetadata[] {
  if (accepted.length === 0) return [...drafts];
  const acceptedIds = new Set(accepted.map(({ id }) => id));
  return drafts.filter(({ id }) => !acceptedIds.has(id));
}

function upsertApprovalHistory(
  approvals: readonly ApprovalSummary[],
  approval: ApprovalSummary,
): ApprovalSummary[] {
  return [...approvals.filter(({ id }) => id !== approval.id), approval].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

/** How many Auto decision rows a Task keeps in memory, per kind (issue #863): the newest 200
 * denials and the newest 200 other decisions — the same sets a reload reads back
 * (`listAutoPermissionDecisions`). Denials are kept apart so a stream of allows cannot push them
 * out of the audit. How many decisions a Turn had is counted separately, so a row that falls out
 * of this window still counts in the Turn's summary. */
export const AUTO_DECISION_RETAIN_LIMIT = 200;

export type AutoDecisionTally = { allow: number; allowOnce: number; deny: number };
/** Every Auto decision of a Task counted per Turn. `throughSeq` is the newest decision event
 * counted, so a replayed or already-loaded event is not counted twice. */
export type AutoDecisionCountState = {
  throughSeq: number;
  byTurn: Record<string, AutoDecisionTally>;
};

/**
 * Appends live Auto decisions in arrival order (issue #863). They arrive as turn events in `seq`
 * order, so no sort is needed; a decision already held (same id) is replaced in place, and the
 * oldest rows beyond {@link AUTO_DECISION_RETAIN_LIMIT} of their kind (denial, or anything else)
 * are dropped. A long Team run records thousands, and the old filter-and-sort over an unbounded
 * list on every event was the renderer's main cost.
 */
export function appendAutoDecisions(
  decisions: readonly AutoPermissionDecision[],
  incoming: readonly AutoPermissionDecision[],
): AutoPermissionDecision[] {
  const next = [...decisions];
  const indexById = new Map(next.map(({ id }, index) => [id, index]));
  for (const decision of incoming) {
    const index = indexById.get(decision.id);
    if (index === undefined) {
      indexById.set(decision.id, next.length);
      next.push(decision);
    } else next[index] = decision;
  }
  const denials = next.filter(({ decision }) => decision === 'deny').length;
  let dropDenials = Math.max(0, denials - AUTO_DECISION_RETAIN_LIMIT);
  let dropOthers = Math.max(0, next.length - denials - AUTO_DECISION_RETAIN_LIMIT);
  if (dropDenials === 0 && dropOthers === 0) return next;
  return next.filter(({ decision }) => {
    if (decision === 'deny') return dropDenials-- <= 0;
    return dropOthers-- <= 0;
  });
}

function tallyDecision(tally: AutoDecisionTally | undefined, decision: AutoPermissionDecision) {
  const next = { ...(tally ?? { allow: 0, allowOnce: 0, deny: 0 }) };
  if (decision.decision === 'allow') next.allow += 1;
  else if (decision.decision === 'allow_once') next.allowOnce += 1;
  else next.deny += 1;
  return next;
}

/** Counts the live decisions newer than what `counts` already holds (O(1) per decision). */
export function countAutoDecisions(
  counts: AutoDecisionCountState | undefined,
  incoming: readonly { seq: number; decision: AutoPermissionDecision }[],
): AutoDecisionCountState {
  let throughSeq = counts?.throughSeq ?? 0;
  let byTurn = counts?.byTurn ?? {};
  let copied = false;
  for (const { seq, decision } of incoming) {
    if (seq <= throughSeq) continue;
    if (!copied) {
      byTurn = { ...byTurn };
      copied = true;
    }
    byTurn[decision.turnId] = tallyDecision(byTurn[decision.turnId], decision);
    throughSeq = seq;
  }
  return copied ? { throughSeq, byTurn } : (counts ?? { throughSeq, byTurn });
}

type QueuedAutoDecision = { seq: number; decision: AutoPermissionDecision };

// Live Auto decisions waiting for the next frame (issue #863). Main records about 17 per second
// during a long Team run; folding each frame's worth into one store update keeps the Timeline from
// re-rendering once per decision. The fallback timer still delivers them while the window is
// hidden and animation frames are paused.
const pendingAutoDecisions = new Map<string, QueuedAutoDecision[]>();
let pendingAutoDecisionApply: ((fn: (state: AppState) => Partial<AppState>) => void) | null = null;
let pendingAutoDecisionFrame: number | null = null;
let pendingAutoDecisionTimer: ReturnType<typeof setTimeout> | null = null;

function flushAutoDecisions(): void {
  if (pendingAutoDecisionFrame !== null && typeof cancelAnimationFrame === 'function')
    cancelAnimationFrame(pendingAutoDecisionFrame);
  if (pendingAutoDecisionTimer !== null) clearTimeout(pendingAutoDecisionTimer);
  pendingAutoDecisionFrame = null;
  pendingAutoDecisionTimer = null;
  const apply = pendingAutoDecisionApply;
  const batches = [...pendingAutoDecisions];
  pendingAutoDecisions.clear();
  if (apply === null || batches.length === 0) return;
  apply((state) => {
    const autoDecisionsByTask = { ...state.autoDecisionsByTask };
    const autoDecisionCountsByTask = { ...state.autoDecisionCountsByTask };
    for (const [taskId, queued] of batches) {
      // Rows and counts take only decisions newer than what the Task already holds: a snapshot
      // applied while this batch waited already restored everything up to its lastSeq, and adding
      // those older rows again would push the newest ones out of the kept window.
      const boundary = autoDecisionCountsByTask[taskId]?.throughSeq ?? 0;
      const fresh = queued.filter(({ seq }) => seq > boundary);
      if (fresh.length === 0) continue;
      autoDecisionsByTask[taskId] = appendAutoDecisions(
        autoDecisionsByTask[taskId] ?? [],
        fresh.map(({ decision }) => decision),
      );
      autoDecisionCountsByTask[taskId] = countAutoDecisions(
        autoDecisionCountsByTask[taskId],
        fresh,
      );
    }
    return { autoDecisionsByTask, autoDecisionCountsByTask };
  });
}

/** Drops a Task's queued decisions that a snapshot up to `lastSeq` already holds (issue #863). */
function discardQueuedAutoDecisionsThrough(taskId: string, lastSeq: number): void {
  const queued = pendingAutoDecisions.get(taskId);
  if (queued === undefined) return;
  const newer = queued.filter(({ seq }) => seq > lastSeq);
  if (newer.length === 0) pendingAutoDecisions.delete(taskId);
  else pendingAutoDecisions.set(taskId, newer);
}

function queueAutoDecision(
  taskId: string,
  seq: number,
  decision: AutoPermissionDecision,
  apply: (fn: (state: AppState) => Partial<AppState>) => void,
): void {
  const entry = { seq, decision };
  const queued = pendingAutoDecisions.get(taskId);
  if (queued === undefined) pendingAutoDecisions.set(taskId, [entry]);
  else queued.push(entry);
  pendingAutoDecisionApply = apply;
  if (pendingAutoDecisionTimer !== null) return;
  pendingAutoDecisionTimer = setTimeout(flushAutoDecisions, 100);
  if (typeof requestAnimationFrame === 'function')
    pendingAutoDecisionFrame = requestAnimationFrame(flushAutoDecisions);
}

function taskTurnEventUpdate(
  state: AppState,
  taskId: string,
  event: TaskTurnEvent,
  receivedAt: number,
): Pick<AppState, 'turnByTask' | 'queuedByTask'> {
  const current = { turn: state.turnByTask[taskId], queued: state.queuedByTask[taskId] ?? [] };
  const next = applyTaskTurnEvent(current, event, receivedAt);
  return {
    turnByTask:
      next.turn === current.turn ? state.turnByTask : { ...state.turnByTask, [taskId]: next.turn },
    queuedByTask:
      next.queued === current.queued
        ? state.queuedByTask
        : { ...state.queuedByTask, [taskId]: next.queued },
  };
}

export function handleTurnEvent(
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
          draftAttachmentsByTask: {
            ...state.draftAttachmentsByTask,
            [taskId]: removeAcceptedAttachmentDrafts(
              state.draftAttachmentsByTask[taskId] ?? [],
              ev.userMessage.attachments,
            ),
          },
          ...taskTurnEventUpdate(state, taskId, ev, Date.now()),
          stageAnnouncement: 'Runtime起動待ち',
        };
      });
      break;
    }
    case 'stage.changed': {
      apply((state) => {
        const turn = state.turnByTask[taskId];
        if (!turn || turn.turnId !== ev.turnId) return {};
        return {
          ...taskTurnEventUpdate(state, taskId, ev, Date.now()),
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
        ...taskTurnEventUpdate(state, taskId, ev, Date.now()),
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
      queueAutoDecision(taskId, ev.seq, ev.autoDecision, apply);
      break;
    }
    case 'message.delta': {
      apply((state) => taskTurnEventUpdate(state, taskId, ev, Date.now()));
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
    case 'skill.activated': {
      apply((state) => ({
        activatedSkillsByTask: {
          ...state.activatedSkillsByTask,
          [taskId]: [
            ...(state.activatedSkillsByTask[taskId] ?? []).filter(
              ({ turnId, ref }) =>
                !(
                  turnId === ev.turnId &&
                  ref.source === ev.ref.source &&
                  ref.skillId === ev.ref.skillId &&
                  ref.digest === ev.ref.digest
                ),
            ),
            { turnId: ev.turnId, ref: ev.ref, name: ev.name },
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
            attachments: [],
            createdAt: new Date().toISOString(),
          };
          nextMessages = [...existing.filter((m) => m.id !== partial.id), partial];
        }
        return {
          messagesByTask: { ...state.messagesByTask, [taskId]: nextMessages },
          ...taskTurnEventUpdate(state, taskId, ev, Date.now()),
          turnDiffByTask: {
            ...state.turnDiffByTask,
            [taskId]: { turnId: ev.turnId, entries: ev.diff },
          },
          stageAnnouncement: finalStateLabel(ev.state),
          ...(ev.state === 'interrupted'
            ? {
                interruptedTurnIdsByTask: {
                  ...state.interruptedTurnIdsByTask,
                  [taskId]: [
                    ...(state.interruptedTurnIdsByTask[taskId] ?? []).filter(
                      (turnId) => turnId !== ev.turnId,
                    ),
                    ev.turnId,
                  ],
                },
              }
            : {}),
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
      apply((state) => taskTurnEventUpdate(state, taskId, ev, Date.now()));
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

export type GraphVersionsState = 'loading' | 'loaded' | 'unavailable';
export type GraphVersionRef = Readonly<{
  id: string;
  revision: number;
  renderRevision: number;
  title: string;
  kind: 'architecture' | 'workflow';
}>;

/** Newest render first, one entry per (graph, renderRevision); the incoming set wins on ties. */
function mergeGraphVersions(
  existing: readonly GraphVersionRef[],
  incoming: readonly GraphVersionRef[],
): GraphVersionRef[] {
  const byKey = new Map<string, GraphVersionRef>();
  for (const version of [...existing, ...incoming])
    byKey.set(`${version.id}:${version.renderRevision}`, version);
  return [...byKey.values()].sort((left, right) => right.renderRevision - left.renderRevision);
}

export const useAppStore = create<AppState>((set, get) => {
  const apply = (fn: (state: AppState) => Partial<AppState>) => set(fn);
  // Snapshot of "the user is still looking at this Task". A late result or error from a Team
  // operation is dropped once the user has switched away (A -> B -> A included).
  const captureTaskView = (taskId: string) => {
    const generation = taskSwitchGeneration;
    return () => taskSwitchGeneration === generation && get().selectedTaskId === taskId;
  };
  const beginTeamOperation = (taskId: string) => {
    if (get().teamBusyByTask[taskId]) return false;
    set((state) => ({
      teamBusyByTask: { ...state.teamBusyByTask, [taskId]: true },
      teamBusy: state.selectedTaskId === taskId ? true : state.teamBusy,
    }));
    return true;
  };
  const finishTeamOperation = (taskId: string) => {
    set((state) => {
      const teamBusyByTask = { ...state.teamBusyByTask, [taskId]: false };
      return {
        teamBusyByTask,
        teamBusy: state.selectedTaskId !== null && !!teamBusyByTask[state.selectedTaskId],
      };
    });
  };

  // Opens the Team subscription for `taskId`. Called on Task selection and again when the Team
  // view is opened after a failed subscription, so a dead stream is not left behind a live-looking
  // Team (issue #754).
  const subscribeToTeam = (taskId: string, isCurrentSelection: () => boolean) => {
    // Never leave an earlier stream attached: two live streams would double every event.
    if (currentTeamUnsubscribe) {
      currentTeamUnsubscribe();
      currentTeamUnsubscribe = null;
    }
    // A disposed stream must stay silent even for reads it started before it was disposed.
    let disposed = false;
    const live = () => !disposed && isCurrentSelection();
    let lastTeamEventSeq = 0;
    let receivedSnapshot = false;
    // The detail this stream last built, which the next patch is made against (issue #863). Null
    // when it is unknown: before the snapshot, or after a gap was filled by a separate read.
    let streamDetail: TeamDetail | null = null;
    let resynchronizing = false;
    // A patch that does not fit what this stream holds can only be repaired by a new snapshot.
    const resynchronize = () => {
      if (resynchronizing) return;
      resynchronizing = true;
      queueMicrotask(() => {
        if (live()) subscribeToTeam(taskId, isCurrentSelection);
      });
    };
    const unsubscribe = window.sprintCoder!.teams.subscribe(
      taskId,
      (event) => {
        if (!live() || resynchronizing) return;
        if (event.type === 'snapshot') {
          receivedSnapshot = true;
          lastTeamEventSeq = event.seq;
          streamDetail = event.detail;
          set((state) => ({
            teamByTask: { ...state.teamByTask, [taskId]: event.detail },
            teamLoadFailedByTask: { ...state.teamLoadFailedByTask, [taskId]: false },
          }));
          return;
        }
        if (!receivedSnapshot || event.seq <= lastTeamEventSeq) return;
        if (event.seq !== lastTeamEventSeq + 1) {
          lastTeamEventSeq = event.seq;
          streamDetail = null;
          const requestedSeq = event.seq;
          void window
            .sprintCoder!.teams.get(taskId)
            .then((fresh) => {
              if (live() && lastTeamEventSeq === requestedSeq)
                set((state) => ({
                  teamByTask: { ...state.teamByTask, [taskId]: fresh },
                  teamLoadFailedByTask: { ...state.teamLoadFailedByTask, [taskId]: false },
                }));
            })
            .catch(() => {
              if (live() && lastTeamEventSeq === requestedSeq)
                set((state) => ({
                  teamLoadFailedByTask: { ...state.teamLoadFailedByTask, [taskId]: true },
                }));
            });
          return;
        }
        let detail: TeamDetail;
        if (event.type === 'updated') detail = event.detail;
        else {
          if (streamDetail === null || streamDetail.team.id !== event.teamId) {
            resynchronize();
            return;
          }
          try {
            // Unchanged Workers, messages and executions keep their identity, so only what
            // changed re-renders.
            detail = applyTeamDetailPatch(streamDetail, event.patch);
          } catch {
            resynchronize();
            return;
          }
        }
        streamDetail = detail;
        lastTeamEventSeq = event.seq;
        set((state) => {
          // First team appearance for the selected task (leader-driven auto-promotion)
          // pulls the user into the canvas; later updates never fight a manual close.
          const firstAppearance =
            state.teamByTask[taskId] == null &&
            state.selectedTaskId === taskId &&
            !state.teamViewOpen;
          return {
            teamByTask: { ...state.teamByTask, [taskId]: detail },
            teamLoadFailedByTask: { ...state.teamLoadFailedByTask, [taskId]: false },
            ...(firstAppearance ? { teamViewOpen: true } : {}),
          };
        });
      },
      () => {
        if (live())
          set((state) => ({
            teamLoadFailedByTask: { ...state.teamLoadFailedByTask, [taskId]: true },
          }));
      },
    );

    currentTeamUnsubscribe = () => {
      disposed = true;
      unsubscribe();
    };
  };

  async function reconcileAttachmentMutation(
    taskId: string,
    mutationError?: string,
  ): Promise<void> {
    set((state) => ({
      attachmentBusyByTask: { ...state.attachmentBusyByTask, [taskId]: false },
      attachmentReconciliationByTask: {
        ...state.attachmentReconciliationByTask,
        // Mutations are single-flight until reconciliation finishes, so this monotonically
        // increasing boundary also identifies the mutation across superseding Task hydrations.
        [taskId]: {
          minimumRequestRevision: (state.attachmentRequestRevisionByTask[taskId] ?? 0) + 1,
          status: 'loading',
          ...(mutationError === undefined ? {} : { mutationError }),
        },
      },
      attachmentErrorByTask: { ...state.attachmentErrorByTask, [taskId]: mutationError },
    }));
    await get().refreshDraftAttachments(taskId);
  }

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
    draftRevisionByTask: {},
    goalDraftRecoveryRevisionByTask: {},
    draftAttachmentsByTask: {},
    attachmentCapabilityByTask: {},
    attachmentRequestRevisionByTask: {},
    attachmentBusyByTask: {},
    attachmentReconciliationByTask: {},
    attachmentErrorByTask: {},
    attachmentAnnouncementByTask: {},
    skillCatalog: [],
    skillCatalogRevision: null,
    skillSelectionByTask: {},
    skillSelectionRevisionByTask: {},
    skillDraftsByTask: {},
    activatedSkillsByTask: {},
    workspaceByTask: {},
    permissionByTask: {},
    permissionChangeByTask: {},
    approvalsByTask: {},
    approvalHistoryByTask: {},
    autoDecisionsByTask: {},
    autoDecisionCountsByTask: {},
    commandsByTask: {},
    turnDiffByTask: {},
    interruptedTurnIdsByTask: {},
    imagesByTask: {},
    fileChangesByTask: {},
    liveEditTaskId: null,
    resolvingApprovalIds: {},
    pendingOptimisticIdByTask: {},
    teamByTask: {},
    teamViewOpen: false,
    teamLoadFailedByTask: {},
    graphOpenRequest: null,
    graphVersionsByTask: {},
    graphVersionsStateByTask: {},
    teamBusy: false,
    teamBusyByTask: {},
    projectSwitchingByTask: {},
    runtime: {
      kind: 'mock',
      codexAvailable: false,
      codexReadiness: 'unavailable',
      claudeAvailable: false,
      claudeReadiness: 'unavailable',
      grokAvailable: false,
      grokReadiness: 'unavailable',
      codexCli: null,
      claudeCli: null,
      grokCli: null,
      model: 'auto',
      models: [{ id: 'auto', displayName: 'Auto', description: 'Codexの既定モデルを使用' }],
      effort: 'medium',
      codexEffort: '',
    },
    modelPicker: { taskId: null, enabled: null, selection: null },
    reasoningSeenByTurn: {},
    recovery: null,
    appVersion: null,
    commandSandbox: null,
    recoveryAcknowledged: false,
    settingsWorkspaceV2: true,
    projectMultiFolderUx: true,
    runtimeStatus: null,
    updateHealth: null,
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
      // Model-generated titles finish after the first response. Keep one window-wide subscription
      // so the sidebar updates without waiting for a Task switch or a full list reload.
      if (taskUpdateUnsubscribe !== null) {
        taskUpdateUnsubscribe();
        taskUpdateUnsubscribe = null;
      }
      if (typeof window.sprintCoder.tasks.subscribe === 'function')
        taskUpdateUnsubscribe = window.sprintCoder.tasks.subscribe((updatedTask) => {
          set((state) => ({
            tasks: state.tasks.map((task) => (task.id === updatedTask.id ? updatedTask : task)),
          }));
        });
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
      const applyUpdateHealth = (updateHealth: UpdateHealth): void => {
        const previous = get().updateHealth;
        set({ updateHealth });
        if (
          updateHealth.consecutiveFailures > 0 &&
          previous?.failedChecks !== updateHealth.failedChecks
        )
          get().showToast(
            updateHealth.consecutiveFailures >= 3
              ? '自動更新が3回以上連続で失敗しています。設定の「詳細」から手動更新・再試行・ログ確認を行えます。'
              : '自動更新に失敗しました。設定の「詳細」から再試行できます。',
          );
        else if (updateHealth.consecutiveFailures === 0 && (previous?.consecutiveFailures ?? 0) > 0)
          get().dismissToast();
      };
      if (typeof window.sprintCoder.app?.getInfo === 'function')
        void window.sprintCoder.app
          .getInfo()
          .then((info) => {
            set({
              ...(info.recovery === undefined ? {} : { recovery: info.recovery }),
              ...(typeof info.version === 'string' ? { appVersion: info.version } : {}),
              ...(info.commandSandbox === undefined ? {} : { commandSandbox: info.commandSandbox }),
              settingsWorkspaceV2: info.settingsWorkspaceV2 ?? true,
              projectMultiFolderUx: info.projectMultiFolderUx ?? true,
            });
            if (info.updateHealth !== undefined) applyUpdateHealth(info.updateHealth);
          })
          .catch(() => undefined);
      runtimeStatusUnsubscribe?.();
      runtimeStatusUnsubscribe = null;
      if (typeof window.sprintCoder.runtime?.subscribeStatus === 'function')
        runtimeStatusUnsubscribe = window.sprintCoder.runtime.subscribeStatus((runtimeStatus) =>
          set({ runtimeStatus }),
        );
      updateHealthUnsubscribe?.();
      updateHealthUnsubscribe = null;
      if (typeof window.sprintCoder.updates?.subscribeHealth === 'function')
        updateHealthUnsubscribe = window.sprintCoder.updates.subscribeHealth(applyUpdateHealth);
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
        const { modelFallbackNotice, ...runtimeState } = runtime;
        if (modelFallbackNotice !== null) {
          const migrated = modelFallbackNotice.changes.reduce(
            (total, change) => total + change.migratedCount,
            0,
          );
          const reset = modelFallbackNotice.changes.reduce(
            (total, change) => total + change.resetCount,
            0,
          );
          get().showToast(
            `保存済みモデルを最新カタログに合わせて更新しました（置換 ${migrated}件、Autoへ戻した ${reset}件）。`,
          );
        }
        // A slow answer for a Task the user has already left would overwrite the newer one.
        if (get().selectedTaskId !== taskId) return;
        set({ runtime: runtimeState });
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
        await get().refreshDraftAttachments(taskId);
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
      const taskId = get().selectedTaskId;
      if (previous.kind === kind) return;
      set({ runtime: { ...previous, kind } });
      try {
        await window.sprintCoder.settings.setRuntime(kind, taskId ?? undefined);
        await get().loadRuntime();
        await refreshModelPicker(get);
        if (taskId !== null) await get().refreshDraftAttachments(taskId);
      } catch (err) {
        set({ runtime: previous });
        const code = errorCode(err);
        if (code === 'RUNTIME_UNAVAILABLE') {
          get().showToast(
            kind === 'claude'
              ? 'Claude CLIが見つからないため切り替えできません'
              : kind === 'grok'
                ? 'Grok CLIが見つからないため切り替えできません'
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
      const taskId = get().selectedTaskId;
      if (previous.model === model || !previous.models.some(({ id }) => id === model)) return;
      set({ runtime: { ...previous, model } });
      try {
        await window.sprintCoder.settings.setModel(model, taskId ?? undefined);
        await get().loadRuntime();
        await refreshModelPicker(get);
        if (taskId !== null) await get().refreshDraftAttachments(taskId);
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
      if (get().permissionChangeByTask[taskId] !== undefined) return;
      const previous = get().permissionByTask[taskId] ?? { preset: 'ask', policyEpoch: 0 };
      if (previous.preset === preset) return;
      set((state) => ({
        permissionChangeByTask: { ...state.permissionChangeByTask, [taskId]: preset },
      }));
      try {
        const permission = await window.sprintCoder.permissions.set(
          taskId,
          preset,
          previous.policyEpoch,
        );
        if ((get().permissionByTask[taskId]?.policyEpoch ?? 0) > permission.policyEpoch) return;
        rememberAccessPreset(permission.preset);
        set((state) => ({
          permissionByTask:
            (state.permissionByTask[taskId]?.policyEpoch ?? 0) <= permission.policyEpoch
              ? { ...state.permissionByTask, [taskId]: permission }
              : state.permissionByTask,
        }));
      } catch (err) {
        const userCanceled = errorCode(err) === 'USER_CANCELED';
        let restored = previous;
        try {
          restored = await window.sprintCoder.permissions.get(taskId);
        } catch {
          // Keep the last confirmed local value when refresh is unavailable.
        }
        set((state) => ({
          permissionByTask:
            (state.permissionByTask[taskId]?.policyEpoch ?? 0) <= restored.policyEpoch
              ? { ...state.permissionByTask, [taskId]: restored }
              : state.permissionByTask,
          ...(userCanceled ? {} : { error: describeError(err) }),
        }));
      } finally {
        set((state) => ({
          permissionChangeByTask: { ...state.permissionChangeByTask, [taskId]: undefined },
        }));
      }
    },

    async resolveApproval(
      taskId: string,
      approvalId: string,
      decision: ApprovalDecision,
      userInputSelection?: number,
    ) {
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
          ...(userInputSelection === undefined ? {} : { userInputSelection }),
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
      if (get().selectedTaskId !== taskId) taskSwitchGeneration += 1;
      const generation = ++taskSelectionGeneration;
      const isCurrentSelection = () =>
        taskSelectionGeneration === generation && get().selectedTaskId === taskId;
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
      set((state) => ({
        teamViewOpen: false,
        teamBusy: !!state.teamBusyByTask[taskId],
        teamLoadFailedByTask: { ...state.teamLoadFailedByTask, [taskId]: false },
      }));
      void restoreDraft(taskId, apply, get);
      void get().refreshDraftAttachments(taskId);
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
          .then((records) => {
            if (!isCurrentSelection()) return;
            apply((state) => ({
              fileChangesByTask: { ...state.fileChangesByTask, [taskId]: records },
            }));
          })
          .catch(() => undefined);

      if (typeof window.sprintCoder?.images?.list === 'function')
        void window.sprintCoder.images
          .list(taskId)
          .then((images) => {
            if (!isCurrentSelection()) return;
            apply((state) => ({ imagesByTask: { ...state.imagesByTask, [taskId]: images } }));
          })
          .catch(() => undefined);

      void get().loadGraphVersions(taskId);

      if (!window.sprintCoder) {
        set({ loadingMessages: false });
        return;
      }
      const sprintCoder = window.sprintCoder;

      const [messagesResult, snapshot, commandsResult, approvalHistoryResult] = await Promise.all([
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
      ]);

      // Nothing from these reads lands unless this is still the newest selection (issue #863): a
      // reselection of the same Task (A→B→A, or clicking the selected Task again) starts newer
      // reads, and an older snapshot arriving after them would roll the rows, counts and lastSeq
      // back while the newer selection's subscription has already resumed after its own lastSeq.
      if (!isCurrentSelection()) return;

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

      // The kept Auto decision rows come in the snapshot, read with its lastSeq and counts
      // (issue #863): a decision recorded while the snapshot waited for the Task's mailbox is in
      // the rows and the counts together, or in neither and replayed after lastSeq.
      // Decisions still queued from the previous subscription are in this snapshot already.
      if (snapshot) discardQueuedAutoDecisionsThrough(taskId, snapshot.lastSeq);
      const snapshotAutoDecisions = snapshot?.autoDecisions;
      if (snapshotAutoDecisions !== undefined) {
        apply((state) => ({
          autoDecisionsByTask: {
            ...state.autoDecisionsByTask,
            [taskId]: snapshotAutoDecisions,
          },
        }));
      }
      // The snapshot counts every Auto decision up to its lastSeq, read in the same call, and the
      // subscription below resumes after lastSeq, so each decision is counted exactly once.
      if (snapshot?.autoDecisionCounts !== undefined) {
        const byTurn: Record<string, AutoDecisionTally> = {};
        for (const { turnId, allow, allowOnce, deny } of snapshot.autoDecisionCounts)
          byTurn[turnId] = { allow, allowOnce, deny };
        const loaded: AutoDecisionCountState = { throughSeq: snapshot.lastSeq, byTurn };
        apply((state) => ({
          autoDecisionCountsByTask: { ...state.autoDecisionCountsByTask, [taskId]: loaded },
        }));
      }

      let afterSeq: number | undefined;
      if (snapshot) {
        afterSeq = snapshot.lastSeq;
        const projection = hydrateTaskTurn(snapshot);
        apply((state) => ({
          turnByTask: { ...state.turnByTask, [taskId]: projection.turn },
          queuedByTask: { ...state.queuedByTask, [taskId]: projection.queued },
          lastSeqByTask: { ...state.lastSeqByTask, [taskId]: snapshot.lastSeq },
          contextUsageByTask: snapshot.contextUsage
            ? { ...state.contextUsageByTask, [taskId]: snapshot.contextUsage }
            : state.contextUsageByTask,
          approvalsByTask: {
            ...state.approvalsByTask,
            [taskId]: snapshot.pendingApprovals ?? [],
          },
          activatedSkillsByTask: {
            ...state.activatedSkillsByTask,
            [taskId]: snapshot.activatedSkills ?? [],
          },
          turnDiffByTask: {
            ...state.turnDiffByTask,
            [taskId]: snapshot.latestTurnDiff ?? undefined,
          },
          interruptedTurnIdsByTask: {
            ...state.interruptedTurnIdsByTask,
            [taskId]: snapshot.interruptedTurnIds ?? [],
          },
        }));
      }

      if (!isCurrentSelection()) return;
      subscribeToTask(taskId, apply, get, afterSeq);
      if (typeof sprintCoder.teams?.subscribe === 'function') {
        subscribeToTeam(taskId, isCurrentSelection);
      } else if (typeof sprintCoder.teams?.get === 'function') {
        try {
          const team = await sprintCoder.teams.get(taskId);
          if (isCurrentSelection())
            set((state) => ({
              teamByTask: { ...state.teamByTask, [taskId]: team },
              teamLoadFailedByTask: { ...state.teamLoadFailedByTask, [taskId]: false },
            }));
        } catch {
          if (isCurrentSelection())
            set((state) => ({
              teamLoadFailedByTask: { ...state.teamLoadFailedByTask, [taskId]: true },
            }));
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
        // `setAccessPreset` crosses the permissions IPC boundary. Main asks for native confirmation
        // the first time `full` is accepted on this installation; declining leaves the newly
        // created Task at the initial `ask` preset.
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

    async createProject(name: string, folders = []) {
      if (!window.sprintCoder || typeof window.sprintCoder.projects?.create !== 'function')
        return null;
      try {
        const created = await window.sprintCoder.projects.create({ name, folders });
        set((state) => ({ projects: [created, ...state.projects], projectLoadState: 'ready' }));
        return created;
      } catch (err) {
        set({ error: describeError(err) });
        return null;
      }
    },

    async pickProjectFolders() {
      if (!window.sprintCoder || typeof window.sprintCoder.projects?.pickFolders !== 'function')
        return { canceled: true };
      try {
        return await window.sprintCoder.projects.pickFolders();
      } catch (err) {
        set({ error: describeError(err) });
        return { canceled: true };
      }
    },

    async listProjectFolders(projectId) {
      if (!window.sprintCoder || typeof window.sprintCoder.projects?.folders?.list !== 'function')
        return null;
      try {
        return await window.sprintCoder.projects.folders.list({ projectId });
      } catch (err) {
        set({ error: describeError(err) });
        return null;
      }
    },

    async replaceProjectFolders(projectId, expectedRevision, folders) {
      if (
        !window.sprintCoder ||
        typeof window.sprintCoder.projects?.folders?.replace !== 'function'
      )
        return null;
      try {
        const updated = await window.sprintCoder.projects.folders.replace({
          projectId,
          expectedRevision,
          folders,
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

    setProjectSwitching(taskId, switching) {
      set((state) => ({
        projectSwitchingByTask: {
          ...state.projectSwitchingByTask,
          [taskId]: switching || undefined,
        },
      }));
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

    async startGoal(taskId: string, objective: string) {
      if (!window.sprintCoder?.goals) return false;
      if (attachmentDraftIsUnresolved(get(), taskId)) return false;
      if (notifyPendingPermissionChange(get(), taskId)) return false;
      const selectedSkills = [...(get().skillSelectionByTask[taskId] ?? [])];
      try {
        const result = await window.sprintCoder.goals.start({
          taskId,
          objective,
          skills: selectedSkills,
        });
        set((state) => ({
          tasks: state.tasks.map((task) => (task.id === taskId ? result.task : task)),
          skillSelectionByTask: { ...state.skillSelectionByTask, [taskId]: [] },
        }));
        persistSkillDraftSelection(taskId, []);
        return true;
      } catch (err) {
        set({ error: describeError(err) });
        return false;
      }
    },

    async pauseGoal(taskId: string) {
      if (!window.sprintCoder?.goals) return;
      try {
        const updated = await window.sprintCoder.goals.pause(taskId);
        set((state) => ({
          tasks: state.tasks.map((task) => (task.id === taskId ? updated : task)),
        }));
      } catch (err) {
        set({ error: describeError(err) });
      }
    },

    async resumeGoal(taskId: string) {
      if (!window.sprintCoder?.goals) return;
      if (notifyPendingPermissionChange(get(), taskId)) return;
      const selectedSkills = [...(get().skillSelectionByTask[taskId] ?? [])];
      try {
        const result = await window.sprintCoder.goals.resume(taskId, selectedSkills);
        set((state) => ({
          tasks: state.tasks.map((task) => (task.id === taskId ? result.task : task)),
          skillSelectionByTask: { ...state.skillSelectionByTask, [taskId]: [] },
        }));
        persistSkillDraftSelection(taskId, []);
      } catch (err) {
        set({ error: describeError(err) });
      }
    },

    async clearGoal(taskId: string) {
      if (!window.sprintCoder?.goals) return;
      try {
        const updated = await window.sprintCoder.goals.clear(taskId);
        set((state) => ({
          tasks: state.tasks.map((task) => (task.id === taskId ? updated : task)),
        }));
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
      const isCurrentSelection = captureTaskView(taskId);
      if (!beginTeamOperation(taskId)) return;
      set({ error: null });
      try {
        if (
          get().teamLoadFailedByTask[taskId] &&
          typeof window.sprintCoder.teams.subscribe === 'function'
        ) {
          // The earlier subscription failed: entering the view must not show a Team that no longer
          // receives updates. Re-establish the stream; a repeated failure marks it again.
          set((state) => ({
            teamLoadFailedByTask: { ...state.teamLoadFailedByTask, [taskId]: false },
          }));
          subscribeToTeam(taskId, isCurrentSelection);
        }
        let detail = await window.sprintCoder.teams.get(taskId);
        if (!isCurrentSelection()) return;
        if (detail === null) {
          await window.sprintCoder.teams.promote(taskId);
          if (!isCurrentSelection()) return;
          detail = await window.sprintCoder.teams.get(taskId);
        }
        if (!isCurrentSelection()) return;
        if (detail === null) throw new Error('Teamを取得できませんでした。Chatで続けられます。');
        set((state) => ({
          teamByTask: { ...state.teamByTask, [taskId]: detail },
          teamViewOpen: true,
        }));
      } catch (err) {
        if (isCurrentSelection()) set({ error: describeError(err) });
      } finally {
        finishTeamOperation(taskId);
      }
    },

    async stopTeamWorker(taskId: string, agentId: string) {
      if (!window.sprintCoder?.teams || !beginTeamOperation(taskId)) return;
      const isCurrentView = captureTaskView(taskId);
      try {
        await window.sprintCoder.teams.stopWorker({ taskId, agentId });
        const detail = await window.sprintCoder.teams.get(taskId);
        set((state) => ({ teamByTask: { ...state.teamByTask, [taskId]: detail } }));
      } catch (err) {
        if (isCurrentView()) set({ error: describeError(err) });
      } finally {
        finishTeamOperation(taskId);
      }
    },
    async resumeTeamMission(taskId: string, missionId: string) {
      if (!window.sprintCoder?.teams || !beginTeamOperation(taskId)) return;
      const isCurrentView = captureTaskView(taskId);
      set({ error: null });
      try {
        await window.sprintCoder!.teams.resumeMission({ taskId, missionId });
        const detail = await window.sprintCoder!.teams.get(taskId);
        set((state) => ({
          teamByTask: { ...state.teamByTask, [taskId]: detail },
        }));
      } catch (error) {
        if (isCurrentView()) set({ error: describeError(error) });
      } finally {
        finishTeamOperation(taskId);
      }
    },

    async resumeTeamExecutionIntegration(taskId: string, executionId: string) {
      if (!window.sprintCoder?.teams || !beginTeamOperation(taskId)) return;
      const isCurrentView = captureTaskView(taskId);
      set({ error: null });
      try {
        const detail = await window.sprintCoder.teams.resumeExecutionIntegration({
          taskId,
          executionId,
        });
        set((state) => ({
          teamByTask: { ...state.teamByTask, [taskId]: detail },
        }));
      } catch (error) {
        if (isCurrentView()) set({ error: describeError(error) });
      } finally {
        finishTeamOperation(taskId);
      }
    },

    async stopAllTeamWorkers(taskId: string) {
      if (!window.sprintCoder?.teams || !beginTeamOperation(taskId)) return;
      const isCurrentView = captureTaskView(taskId);
      try {
        // The Team Leader runs as the task's active Turn, separately from worker runtimes.
        // Stop it first so it cannot react to worker cancellation by hiring replacements while
        // the user's "stop all" request is still being processed.
        const activeTurn = get().turnByTask[taskId];
        if (activeTurn?.status === 'running') {
          const leaderStopped = await get().cancelActiveTurn(taskId, false);
          if (!leaderStopped) return;
        }
        const detail = await window.sprintCoder.teams.stopAll(taskId);
        set((state) => ({ teamByTask: { ...state.teamByTask, [taskId]: detail } }));
      } catch (err) {
        if (isCurrentView()) set({ error: describeError(err) });
      } finally {
        finishTeamOperation(taskId);
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

    requestGraphOpen(taskId: string) {
      set((state) => ({
        graphOpenRequest: { taskId, nonce: (state.graphOpenRequest?.nonce ?? 0) + 1 },
      }));
    },

    async loadGraphVersions(taskId: string) {
      const api = window.sprintCoder?.graphs;
      if (typeof api?.history !== 'function') return;
      const markState = (next: GraphVersionsState) =>
        set((state) => ({
          graphVersionsStateByTask: {
            ...state.graphVersionsStateByTask,
            // A completed load is never downgraded by a later reload that is still in flight or failed.
            [taskId]:
              state.graphVersionsStateByTask[taskId] === 'loaded' && next !== 'loaded'
                ? 'loaded'
                : next,
          },
        }));
      markState('loading');
      const versions: GraphVersionRef[] = [];
      let beforeRenderRevision: number | undefined;
      // History is paged newest-first; a Task rarely has more than one page, and the cap keeps a
      // misbehaving cursor from looping forever.
      for (let page = 0; page < 20; page += 1) {
        let history: Awaited<ReturnType<typeof api.history>>;
        try {
          history = await api.history({
            taskId,
            ...(beforeRenderRevision === undefined ? {} : { beforeRenderRevision }),
          });
        } catch {
          markState('unavailable');
          return;
        }
        for (const version of history.versions)
          versions.push({
            id: version.id,
            revision: version.semanticRevision,
            renderRevision: version.renderRevision,
            title: version.title,
            kind: version.kind,
          });
        if (history.nextBeforeRenderRevision === null) break;
        beforeRenderRevision = history.nextBeforeRenderRevision;
      }
      set((state) => ({
        graphVersionsByTask: {
          ...state.graphVersionsByTask,
          [taskId]: mergeGraphVersions(state.graphVersionsByTask[taskId] ?? [], versions),
        },
      }));
      markState('loaded');
    },

    noteGraphVersion(view: GraphView) {
      set((state) => ({
        graphVersionsByTask: {
          ...state.graphVersionsByTask,
          [view.taskId]: mergeGraphVersions(state.graphVersionsByTask[view.taskId] ?? [], [
            {
              id: view.id,
              revision: view.revision,
              renderRevision: view.renderRevision,
              title: view.title,
              kind: view.kind,
            },
          ]),
        },
      }));
    },

    setDraft(taskId: string, text: string) {
      set((state) => ({
        draftByTask: { ...state.draftByTask, [taskId]: text },
        draftRevisionByTask: {
          ...state.draftRevisionByTask,
          [taskId]: (state.draftRevisionByTask[taskId] ?? 0) + 1,
        },
        goalDraftRecoveryRevisionByTask: {
          ...state.goalDraftRecoveryRevisionByTask,
          [taskId]: undefined,
        },
      }));
      persistDraftDebounced(taskId, text);
    },

    restoreFailedGoalDraft(taskId, expectedRevision, text) {
      let restored = false;
      set((state) => {
        if (state.draftRevisionByTask[taskId] !== expectedRevision) return state;
        restored = true;
        const revision = expectedRevision + 1;
        return {
          draftByTask: { ...state.draftByTask, [taskId]: text },
          draftRevisionByTask: { ...state.draftRevisionByTask, [taskId]: revision },
          goalDraftRecoveryRevisionByTask: {
            ...state.goalDraftRecoveryRevisionByTask,
            [taskId]: revision,
          },
        };
      });
      if (restored) persistDraftDebounced(taskId, text);
      return restored;
    },

    async refreshDraftAttachments(taskId: string) {
      const api = window.sprintCoder?.attachments;
      if (!api) return;
      const revision = (get().attachmentRequestRevisionByTask[taskId] ?? 0) + 1;
      const mutationRevision = get().attachmentReconciliationByTask[taskId]?.minimumRequestRevision;
      set((state) => {
        const recovery = state.attachmentReconciliationByTask[taskId];
        return {
          attachmentRequestRevisionByTask: {
            ...state.attachmentRequestRevisionByTask,
            [taskId]: revision,
          },
          attachmentReconciliationByTask:
            recovery === undefined
              ? state.attachmentReconciliationByTask
              : {
                  ...state.attachmentReconciliationByTask,
                  [taskId]: { ...recovery, status: 'loading' },
                },
        };
      });
      try {
        const [capability, attachments] = await Promise.all([
          api.capability(taskId),
          api.listDraft(taskId),
        ]);
        if (get().attachmentRequestRevisionByTask[taskId] !== revision) return;
        set((state) => {
          const recovery = state.attachmentReconciliationByTask[taskId];
          const reconciled =
            recovery !== undefined &&
            recovery.minimumRequestRevision === mutationRevision &&
            revision >= recovery.minimumRequestRevision;
          return {
            attachmentCapabilityByTask: {
              ...state.attachmentCapabilityByTask,
              [taskId]: capability,
            },
            draftAttachmentsByTask: { ...state.draftAttachmentsByTask, [taskId]: attachments },
            attachmentReconciliationByTask: reconciled
              ? { ...state.attachmentReconciliationByTask, [taskId]: undefined }
              : state.attachmentReconciliationByTask,
            attachmentErrorByTask: {
              ...state.attachmentErrorByTask,
              [taskId]: reconciled ? recovery.mutationError : undefined,
            },
          };
        });
      } catch (error) {
        if (get().attachmentRequestRevisionByTask[taskId] !== revision) return;
        set((state) => {
          const recovery = state.attachmentReconciliationByTask[taskId];
          return {
            attachmentErrorByTask: {
              ...state.attachmentErrorByTask,
              [taskId]: describeError(error),
            },
            attachmentReconciliationByTask:
              recovery?.minimumRequestRevision === mutationRevision && recovery !== undefined
                ? {
                    ...state.attachmentReconciliationByTask,
                    [taskId]: { ...recovery, status: 'error' },
                  }
                : state.attachmentReconciliationByTask,
          };
        });
      }
    },

    async pickDraftAttachment(taskId: string) {
      const api = window.sprintCoder?.attachments;
      if (!api || attachmentDraftIsUnresolved(get(), taskId)) return;
      set((state) => ({
        attachmentBusyByTask: { ...state.attachmentBusyByTask, [taskId]: true },
        attachmentErrorByTask: { ...state.attachmentErrorByTask, [taskId]: undefined },
      }));
      try {
        const picked = await api.pick(taskId);
        set((state) => ({
          attachmentAnnouncementByTask: {
            ...state.attachmentAnnouncementByTask,
            [taskId]:
              picked === null
                ? '画像の選択をキャンセルしました'
                : `${picked.fileName}を追加しました`,
          },
        }));
        if (picked !== null) await reconcileAttachmentMutation(taskId);
        else
          set((state) => ({
            attachmentBusyByTask: { ...state.attachmentBusyByTask, [taskId]: false },
          }));
      } catch (error) {
        await reconcileAttachmentMutation(taskId, describeError(error));
      }
    },

    setAttachmentError(taskId: string, message: string | undefined) {
      set((state) => ({
        attachmentErrorByTask: { ...state.attachmentErrorByTask, [taskId]: message },
      }));
    },

    async pasteDraftAttachment(taskId: string) {
      const api = window.sprintCoder?.attachments;
      if (typeof api?.paste !== 'function' || attachmentDraftIsUnresolved(get(), taskId)) return;
      set((state) => ({
        attachmentBusyByTask: { ...state.attachmentBusyByTask, [taskId]: true },
        attachmentErrorByTask: { ...state.attachmentErrorByTask, [taskId]: undefined },
      }));
      try {
        const pasted = await api.paste(taskId);
        set((state) => ({
          attachmentAnnouncementByTask: {
            ...state.attachmentAnnouncementByTask,
            [taskId]:
              pasted === null
                ? 'クリップボードに画像がありません'
                : `${pasted.fileName}を貼り付けました`,
          },
        }));
        if (pasted !== null) await reconcileAttachmentMutation(taskId);
        else
          set((state) => ({
            attachmentBusyByTask: { ...state.attachmentBusyByTask, [taskId]: false },
          }));
      } catch (error) {
        await reconcileAttachmentMutation(taskId, describeError(error));
      }
    },

    async removeDraftAttachment(taskId: string, attachmentId: string) {
      const api = window.sprintCoder?.attachments;
      if (!api || attachmentDraftIsUnresolved(get(), taskId)) return false;
      set((state) => ({
        attachmentBusyByTask: { ...state.attachmentBusyByTask, [taskId]: true },
        attachmentErrorByTask: { ...state.attachmentErrorByTask, [taskId]: undefined },
      }));
      try {
        const fileName = get().draftAttachmentsByTask[taskId]?.find(
          ({ id }) => id === attachmentId,
        )?.fileName;
        await api.remove({ taskId, attachmentId });
        set((state) => ({
          attachmentAnnouncementByTask: {
            ...state.attachmentAnnouncementByTask,
            [taskId]: `${fileName ?? '画像'}を削除しました`,
          },
        }));
        await reconcileAttachmentMutation(taskId);
        return true;
      } catch (error) {
        await reconcileAttachmentMutation(taskId, describeError(error));
        return false;
      }
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
      let selectionRevision = 0;
      set((state) => {
        selectionRevision = (state.skillSelectionRevisionByTask[taskId] ?? 0) + 1;
        return {
          skillSelectionByTask: { ...state.skillSelectionByTask, [taskId]: [...skills] },
          skillSelectionRevisionByTask: {
            ...state.skillSelectionRevisionByTask,
            [taskId]: selectionRevision,
          },
        };
      });
      if (!window.sprintCoder || typeof window.sprintCoder.skills?.setDraftSelection !== 'function')
        return;
      try {
        await window.sprintCoder.skills.setDraftSelection(taskId, [...skills]);
      } catch (err) {
        set((state) => {
          if (state.skillSelectionRevisionByTask[taskId] !== selectionRevision) {
            return { error: describeError(err) };
          }
          return {
            skillSelectionByTask: { ...state.skillSelectionByTask, [taskId]: previous },
            skillSelectionRevisionByTask: {
              ...state.skillSelectionRevisionByTask,
              [taskId]: selectionRevision + 1,
            },
            error: describeError(err),
          };
        });
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

    async startTurn(taskId: string, text: string, skills, attachmentIds = []) {
      if (!text.trim() || !window.sprintCoder) return null;
      if (attachmentDraftIsUnresolved(get(), taskId))
        return '画像の準備が完了してから送信してください';
      if (notifyPendingPermissionChange(get(), taskId)) return null;
      const selectedSkills = [...(skills ?? get().skillSelectionByTask[taskId] ?? [])];
      const selectedAttachmentIds = [...attachmentIds];
      const draftsById = new Map(
        (get().draftAttachmentsByTask[taskId] ?? []).map((attachment) => [
          attachment.id,
          attachment,
        ]),
      );
      const selectedAttachments = selectedAttachmentIds.flatMap((id) => {
        const attachment = draftsById.get(id);
        return attachment === undefined ? [] : [attachment];
      });
      const turn = get().turnByTask[taskId];
      if (turn && (turn.status === 'running' || turn.status === 'canceling')) return null;

      const optimisticId = `pending-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const optimisticMessage: ChatMessage = {
        id: optimisticId,
        taskId,
        turnId: null,
        author: 'user',
        content: text,
        attachments: selectedAttachments,
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
        draftRevisionByTask: {
          ...state.draftRevisionByTask,
          [taskId]: (state.draftRevisionByTask[taskId] ?? 0) + 1,
        },
        goalDraftRecoveryRevisionByTask: {
          ...state.goalDraftRecoveryRevisionByTask,
          [taskId]: undefined,
        },
        skillSelectionByTask: { ...state.skillSelectionByTask, [taskId]: [] },
      }));
      persistDraftDebounced(taskId, '');
      persistSkillDraftSelection(taskId, []);

      try {
        const result = await window.sprintCoder.turns.start({
          taskId,
          text,
          skills: selectedSkills,
          attachmentIds: selectedAttachmentIds,
          attachmentSelectionIdentity:
            selectedAttachmentIds.length === 0
              ? null
              : (get().attachmentCapabilityByTask[taskId]?.selectionIdentity ?? null),
        });
        // turn.accepted event (delivered via subscription) reconciles the optimistic message.
        // A DB Task exists before this point so per-Task settings have a stable id, but it becomes
        // conversation history only after this acceptance succeeds. `renamedTask` is present only
        // when the first message also produced an automatic title (issue #4).
        const renamed = result?.renamedTask;
        set((state) => ({
          // The accepted event may have been published while another Task was selected.
          sendingByTask:
            state.pendingOptimisticIdByTask[taskId] === optimisticId
              ? { ...state.sendingByTask, [taskId]: false }
              : state.sendingByTask,
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
        const message = code === 'TURN_ACTIVE' ? null : describeError(err);
        let restoredDraft = false;
        set((state) => {
          restoredDraft = (state.draftByTask[taskId] ?? '') === '';
          return {
            messagesByTask: {
              ...state.messagesByTask,
              [taskId]: (state.messagesByTask[taskId] ?? []).filter((m) => m.id !== optimisticId),
            },
            pendingOptimisticIdByTask: { ...state.pendingOptimisticIdByTask, [taskId]: undefined },
            sendingByTask: { ...state.sendingByTask, [taskId]: false },
            draftByTask: restoredDraft
              ? { ...state.draftByTask, [taskId]: text }
              : state.draftByTask,
            skillSelectionByTask: {
              ...state.skillSelectionByTask,
              [taskId]: selectedSkills,
            },
            error: message,
          };
        });
        if (restoredDraft) persistDraftDebounced(taskId, text);
        persistSkillDraftSelection(taskId, selectedSkills);
        if (selectedAttachmentIds.length > 0) void get().refreshDraftAttachments(taskId);
        if (code === 'TURN_ACTIVE') {
          get().showToast('すでに実行中です。もう一度送信するとキューに追加されます');
        }
        return message;
      }
      return null;
    },

    async queueMessage(taskId: string, text: string, skills) {
      if (
        !text.trim() ||
        !window.sprintCoder ||
        typeof window.sprintCoder.turns.queue !== 'function'
      )
        return false;
      if (notifyPendingPermissionChange(get(), taskId)) return false;
      const selectedSkills = [...(skills ?? get().skillSelectionByTask[taskId] ?? [])];
      let selectionRevision = 0;
      let draftRevision = 0;
      set((state) => {
        selectionRevision = (state.skillSelectionRevisionByTask[taskId] ?? 0) + 1;
        draftRevision = (state.draftRevisionByTask[taskId] ?? 0) + 1;
        return {
          draftByTask: { ...state.draftByTask, [taskId]: '' },
          draftRevisionByTask: { ...state.draftRevisionByTask, [taskId]: draftRevision },
          goalDraftRecoveryRevisionByTask: {
            ...state.goalDraftRecoveryRevisionByTask,
            [taskId]: undefined,
          },
          skillSelectionByTask: { ...state.skillSelectionByTask, [taskId]: [] },
          skillSelectionRevisionByTask: {
            ...state.skillSelectionRevisionByTask,
            [taskId]: selectionRevision,
          },
        };
      });
      persistDraftDebounced(taskId, '');
      persistSkillDraftSelection(taskId, []);
      try {
        await window.sprintCoder.turns.queue({ taskId, text, skills: selectedSkills });
        // queue.changed (delivered via subscription) reconciles the compact queued list.
        return true;
      } catch (err) {
        let restoredDraft = false;
        let restoredSkills = false;
        set((state) => {
          restoredDraft = state.draftRevisionByTask[taskId] === draftRevision;
          restoredSkills = state.skillSelectionRevisionByTask[taskId] === selectionRevision;
          return {
            draftByTask: restoredDraft
              ? { ...state.draftByTask, [taskId]: text }
              : state.draftByTask,
            draftRevisionByTask: restoredDraft
              ? { ...state.draftRevisionByTask, [taskId]: draftRevision + 1 }
              : state.draftRevisionByTask,
            skillSelectionByTask: {
              ...state.skillSelectionByTask,
              [taskId]: restoredSkills ? selectedSkills : state.skillSelectionByTask[taskId],
            },
            skillSelectionRevisionByTask: restoredSkills
              ? {
                  ...state.skillSelectionRevisionByTask,
                  [taskId]: selectionRevision + 1,
                }
              : state.skillSelectionRevisionByTask,
            error: describeError(err),
          };
        });
        if (restoredDraft) persistDraftDebounced(taskId, text);
        if (restoredSkills) persistSkillDraftSelection(taskId, selectedSkills);
        return false;
      }
    },

    async steerMessage(taskId: string, text: string, expectedTurnId: string) {
      if (
        !text.trim() ||
        !window.sprintCoder ||
        typeof window.sprintCoder.turns.steer !== 'function'
      )
        return;
      if (notifyPendingPermissionChange(get(), taskId)) return;
      set((state) => ({
        draftByTask: { ...state.draftByTask, [taskId]: '' },
        draftRevisionByTask: {
          ...state.draftRevisionByTask,
          [taskId]: (state.draftRevisionByTask[taskId] ?? 0) + 1,
        },
        goalDraftRecoveryRevisionByTask: {
          ...state.goalDraftRecoveryRevisionByTask,
          [taskId]: undefined,
        },
      }));
      persistDraftDebounced(taskId, '');
      try {
        await window.sprintCoder.turns.steer({ taskId, text, expectedTurnId });
      } catch (err) {
        const code = errorCode(err);
        let restoredDraft = false;
        set((state) => {
          restoredDraft = (state.draftByTask[taskId] ?? '') === '';
          return {
            draftByTask: restoredDraft
              ? { ...state.draftByTask, [taskId]: text }
              : state.draftByTask,
            error:
              code === 'STEER_STALE' || code === 'STEER_UNSUPPORTED'
                ? state.error
                : describeError(err),
          };
        });
        if (restoredDraft) persistDraftDebounced(taskId, text);
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
      if (
        !text.trim() ||
        !window.sprintCoder ||
        typeof window.sprintCoder.turns.stopAndSend !== 'function'
      )
        return { completed: false, draftRestored: false };
      if (notifyPendingPermissionChange(get(), taskId))
        return { completed: false, draftRestored: false };
      const selectedSkills = [...(skills ?? get().skillSelectionByTask[taskId] ?? [])];
      const activeTurn = get().turnByTask[taskId];
      let selectionRevision = 0;
      let draftRevision = 0;
      set((state) => {
        selectionRevision = (state.skillSelectionRevisionByTask[taskId] ?? 0) + 1;
        draftRevision = (state.draftRevisionByTask[taskId] ?? 0) + 1;
        return {
          draftByTask: { ...state.draftByTask, [taskId]: '' },
          draftRevisionByTask: { ...state.draftRevisionByTask, [taskId]: draftRevision },
          goalDraftRecoveryRevisionByTask: {
            ...state.goalDraftRecoveryRevisionByTask,
            [taskId]: undefined,
          },
          skillSelectionByTask: { ...state.skillSelectionByTask, [taskId]: [] },
          skillSelectionRevisionByTask: {
            ...state.skillSelectionRevisionByTask,
            [taskId]: selectionRevision,
          },
          turnByTask:
            activeTurn?.status === 'running'
              ? {
                  ...state.turnByTask,
                  [taskId]: { ...activeTurn, status: 'canceling' },
                }
              : state.turnByTask,
        };
      });
      persistDraftDebounced(taskId, '');
      persistSkillDraftSelection(taskId, []);
      try {
        await window.sprintCoder.turns.stopAndSend({
          taskId,
          text,
          skills: selectedSkills,
        });
        return { completed: true, draftRestored: false };
      } catch (err) {
        let restoredDraft = false;
        let restoredSkills = false;
        set((state) => {
          restoredDraft = state.draftRevisionByTask[taskId] === draftRevision;
          restoredSkills = state.skillSelectionRevisionByTask[taskId] === selectionRevision;
          const currentTurn = state.turnByTask[taskId];
          const restoreTurn =
            activeTurn?.status === 'running' &&
            currentTurn?.turnId === activeTurn.turnId &&
            currentTurn.status === 'canceling';
          return {
            draftByTask: restoredDraft
              ? { ...state.draftByTask, [taskId]: text }
              : state.draftByTask,
            draftRevisionByTask: restoredDraft
              ? { ...state.draftRevisionByTask, [taskId]: draftRevision + 1 }
              : state.draftRevisionByTask,
            skillSelectionByTask: {
              ...state.skillSelectionByTask,
              [taskId]: restoredSkills ? selectedSkills : state.skillSelectionByTask[taskId],
            },
            skillSelectionRevisionByTask: restoredSkills
              ? {
                  ...state.skillSelectionRevisionByTask,
                  [taskId]: selectionRevision + 1,
                }
              : state.skillSelectionRevisionByTask,
            turnByTask: restoreTurn
              ? {
                  ...state.turnByTask,
                  [taskId]: { ...currentTurn, status: 'running' },
                }
              : state.turnByTask,
            error: describeError(err),
          };
        });
        if (restoredDraft) persistDraftDebounced(taskId, text);
        if (restoredSkills) persistSkillDraftSelection(taskId, selectedSkills);
        return { completed: false, draftRestored: restoredDraft };
      }
    },

    async cancelActiveTurn(taskId: string, startNextQueued = true) {
      const turn = get().turnByTask[taskId];
      if (!turn || turn.status !== 'running' || !window.sprintCoder) return false;
      set((state) => ({
        turnByTask: { ...state.turnByTask, [taskId]: { ...turn, status: 'canceling' } },
      }));
      try {
        await window.sprintCoder.turns.cancel({
          taskId,
          turnId: turn.turnId,
          ...(startNextQueued ? {} : { startNextQueued: false }),
        });
        // turn.completed(state:'canceled') will arrive via subscription and finalize.
        return true;
      } catch (err) {
        set((state) => {
          const current = state.turnByTask[taskId];
          const shouldRestore = current?.turnId === turn.turnId && current.status === 'canceling';
          return {
            turnByTask: shouldRestore
              ? {
                  ...state.turnByTask,
                  [taskId]: { ...current, status: 'running' },
                }
              : state.turnByTask,
            error: describeError(err),
          };
        });
        return false;
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

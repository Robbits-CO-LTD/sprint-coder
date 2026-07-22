import { create } from 'zustand';
import type {
  AccessPreset,
  ApprovalDecision,
  ApprovalSummary,
  ChatMessage,
  ContextUsage,
  CodexModelOption,
  QueuedInput,
  PermissionSettings,
  RuntimeKind,
  TaskSummary,
  TurnEvent,
  TurnStage,
} from '../types/vibe';

export type TurnStatus =
  'running' | 'canceling' | 'completed' | 'canceled' | 'failed' | 'interrupted';

export type TurnRuntimeState = {
  turnId: string;
  stage: TurnStage;
  status: TurnStatus;
  startedAt: number;
  streamingMessageId: string | null;
  streamingContent: string;
};

export type WorkspaceInfo = { path: string; name: string };

export type RuntimeState = {
  kind: RuntimeKind;
  codexAvailable: boolean;
  model: string;
  models: CodexModelOption[];
};

export const STAGE_LABEL: Record<TurnStage, string> = {
  understanding: 'ユーザーの依頼を理解中',
  planning: '方針を組み立て中',
  executing: 'ファイル・コマンドを実行中',
  synthesizing: '回答をまとめ中',
  waiting_approval: '承認を待っています',
};

export const STAGE_ORDER: TurnStage[] = [
  'understanding',
  'planning',
  'executing',
  'waiting_approval',
  'synthesizing',
];

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
  vibeAvailable: boolean;
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
  resolvingApprovalIds: Record<string, boolean | undefined>;
  pendingOptimisticIdByTask: Record<string, string | undefined>;

  /** Runtime (Mock/Codex) selection surfaced by the Composer runtime chip (FR-SET-03).
   * Defaults to Mock/unavailable until `settings.getRuntime` resolves (or forever if the
   * backend hasn't wired the `settings` API yet — see `loadRuntime`). */
  runtime: RuntimeState;

  /** Latest stage/turn-completion announcement text for the aria-live region (NFR-A11Y-03). */
  stageAnnouncement: string;
  /** Ephemeral toast for non-fatal notices (e.g. STEER_STALE). */
  toast: { id: number; message: string } | null;

  init(): Promise<void>;
  loadRuntime(): Promise<void>;
  setRuntime(kind: RuntimeKind): Promise<void>;
  setModel(model: string): Promise<void>;
  setAccessPreset(taskId: string, preset: AccessPreset): Promise<void>;
  resolveApproval(taskId: string, approvalId: string, decision: ApprovalDecision): Promise<void>;
  selectTask(taskId: string): Promise<void>;
  createTask(): Promise<void>;
  renameTask(taskId: string, title: string): Promise<void>;
  setPinned(taskId: string, pinned: boolean): Promise<void>;
  setArchived(taskId: string, archived: boolean): Promise<void>;
  setGoal(taskId: string, goal: string): Promise<void>;
  selectWorkspace(taskId: string): Promise<void>;
  setDraft(taskId: string, text: string): void;
  startTurn(taskId: string, text: string): Promise<void>;
  queueMessage(taskId: string, text: string): Promise<void>;
  steerMessage(taskId: string, text: string, expectedTurnId: string): Promise<void>;
  stopAndSend(taskId: string, text: string): Promise<void>;
  cancelActiveTurn(taskId: string): Promise<void>;
  showToast(message: string): void;
  dismissToast(): void;
};

let currentUnsubscribe: (() => void) | null = null;
let currentSubscribedTaskId: string | null = null;
const draftSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function persistDraftDebounced(taskId: string, text: string) {
  if (!window.vibe || typeof window.vibe.tasks.setDraft !== 'function') return;
  const existing = draftSaveTimers.get(taskId);
  if (existing !== undefined) clearTimeout(existing);
  draftSaveTimers.set(
    taskId,
    setTimeout(() => {
      draftSaveTimers.delete(taskId);
      void window.vibe?.tasks.setDraft(taskId, text).catch(() => undefined);
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
  if (!window.vibe || typeof window.vibe.tasks.getDraft !== 'function') return;
  if (get().draftByTask[taskId] !== undefined) return;
  try {
    const draft = await window.vibe.tasks.getDraft(taskId);
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
  if (!window.vibe) return;
  if (typeof window.vibe.workspace?.get === 'function') {
    try {
      const workspace = await window.vibe.workspace.get(taskId);
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
  if (!window.vibe || typeof window.vibe.permissions?.get !== 'function') return;
  try {
    const permission = await window.vibe.permissions.get(taskId);
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
  afterSeq?: number,
) {
  if (currentUnsubscribe) {
    currentUnsubscribe();
    currentUnsubscribe = null;
  }
  currentSubscribedTaskId = taskId;
  if (!window.vibe) return;
  const listener = (ev: TurnEvent) => {
    // Ignore stray events if the user has since switched tasks and this callback
    // has not been torn down yet (defensive; unsubscribe should prevent this).
    if (currentSubscribedTaskId !== taskId) return;
    handleTurnEvent(taskId, ev, apply);
  };
  currentUnsubscribe =
    afterSeq !== undefined
      ? window.vibe.turns.subscribe(taskId, listener, { afterSeq })
      : window.vibe.turns.subscribe(taskId, listener);
}

function handleTurnEvent(
  taskId: string,
  ev: TurnEvent,
  apply: (fn: (state: AppState) => Partial<AppState>) => void,
) {
  apply((state) => ({ lastSeqByTask: { ...state.lastSeqByTask, [taskId]: ev.seq } }));

  switch (ev.type) {
    case 'turn.accepted': {
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
          turnByTask: { ...state.turnByTask, [taskId]: { ...turn, stage: ev.stage } },
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
          stageAnnouncement: finalStateLabel(ev.state),
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
    default:
      break;
  }
}

export const useAppStore = create<AppState>((set, get) => {
  const apply = (fn: (state: AppState) => Partial<AppState>) => set(fn);

  return {
    vibeAvailable: typeof window !== 'undefined' && !!window.vibe,
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
    resolvingApprovalIds: {},
    pendingOptimisticIdByTask: {},
    runtime: {
      kind: 'mock',
      codexAvailable: false,
      model: 'auto',
      models: [{ id: 'auto', displayName: 'Auto', description: 'Codexの既定モデルを使用' }],
    },
    stageAnnouncement: '',
    toast: null,

    async init() {
      if (!window.vibe) {
        set({ vibeAvailable: false, initialized: true });
        return;
      }
      set({ vibeAvailable: true, loadingTasks: true, error: null });
      void get().loadRuntime();
      try {
        const tasks = await window.vibe.tasks.list();
        set({ tasks, loadingTasks: false, initialized: true });
        const firstSelectable = tasks.find((t) => !t.archived) ?? tasks[0];
        if (firstSelectable) {
          await get().selectTask(firstSelectable.id);
        }
      } catch (err) {
        set({ loadingTasks: false, initialized: true, error: describeError(err) });
      }
    },

    async loadRuntime() {
      if (!window.vibe || typeof window.vibe.settings?.getRuntime !== 'function') return;
      try {
        const runtime = await window.vibe.settings.getRuntime();
        set({ runtime });
      } catch {
        // Non-fatal: keep the last-known (or default) runtime state.
      }
    },

    async setRuntime(kind: RuntimeKind) {
      if (!window.vibe || typeof window.vibe.settings?.setRuntime !== 'function') return;
      const previous = get().runtime;
      if (previous.kind === kind) return;
      set({ runtime: { ...previous, kind } });
      try {
        await window.vibe.settings.setRuntime(kind);
        await get().loadRuntime();
      } catch (err) {
        set({ runtime: previous });
        const code = errorCode(err);
        if (code === 'RUNTIME_UNAVAILABLE') {
          get().showToast('Codex CLIが見つからないため切り替えできません');
        } else {
          set({ error: describeError(err) });
        }
      }
    },

    async setModel(model: string) {
      if (!window.vibe || typeof window.vibe.settings?.setModel !== 'function') return;
      const previous = get().runtime;
      if (previous.model === model || !previous.models.some(({ id }) => id === model)) return;
      set({ runtime: { ...previous, model } });
      try {
        await window.vibe.settings.setModel(model);
        await get().loadRuntime();
      } catch (err) {
        set({ runtime: previous });
        set({ error: describeError(err) });
      }
    },

    async setAccessPreset(taskId: string, preset: AccessPreset) {
      if (!window.vibe || typeof window.vibe.permissions?.set !== 'function') return;
      const previous = get().permissionByTask[taskId] ?? { preset: 'ask', policyEpoch: 0 };
      if (previous.preset === preset) return;
      set((state) => ({
        permissionByTask: {
          ...state.permissionByTask,
          [taskId]: { ...previous, preset },
        },
      }));
      try {
        const permission = await window.vibe.permissions.set(taskId, preset, previous.policyEpoch);
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
          restored = await window.vibe.permissions.get(taskId);
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
      if (!window.vibe || typeof window.vibe.approvals?.resolve !== 'function') return;
      const approval = (get().approvalsByTask[taskId] ?? []).find(({ id }) => id === approvalId);
      if (approval === undefined || get().resolvingApprovalIds[approvalId]) return;
      set((state) => ({
        resolvingApprovalIds: { ...state.resolvingApprovalIds, [approvalId]: true },
      }));
      try {
        await window.vibe.approvals.resolve({
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
      void restoreDraft(taskId, apply, get);
      void loadWorkspace(taskId, apply, get);
      void loadPermission(taskId, apply, get);

      if (!window.vibe) {
        set({ loadingMessages: false });
        return;
      }
      const vibe = window.vibe;

      const [messagesResult, snapshot] = await Promise.all([
        vibe.tasks
          .messages(taskId)
          .then((v) => ({ ok: true as const, v }))
          .catch((err: unknown) => ({ ok: false as const, err })),
        typeof vibe.turns.snapshot === 'function'
          ? vibe.turns.snapshot(taskId).catch(() => null)
          : Promise.resolve(null),
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
        }));
      }

      if (get().selectedTaskId !== taskId) return;
      subscribeToTask(taskId, apply, afterSeq);
    },

    async createTask() {
      if (!window.vibe) return;
      set({ error: null });
      try {
        const task = await window.vibe.tasks.create();
        set((state) => ({ tasks: [task, ...state.tasks] }));
        await get().selectTask(task.id);
      } catch (err) {
        set({ error: describeError(err) });
      }
    },

    async renameTask(taskId: string, title: string) {
      if (!window.vibe) return;
      const trimmed = title.trim();
      if (!trimmed) return;
      try {
        const updated = await window.vibe.tasks.rename(taskId, trimmed);
        set((state) => ({ tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)) }));
      } catch (err) {
        set({ error: describeError(err) });
      }
    },

    async setPinned(taskId: string, pinned: boolean) {
      if (!window.vibe || typeof window.vibe.tasks.setPinned !== 'function') return;
      try {
        const updated = await window.vibe.tasks.setPinned(taskId, pinned);
        set((state) => ({ tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)) }));
      } catch (err) {
        set({ error: describeError(err) });
      }
    },

    async setArchived(taskId: string, archived: boolean) {
      if (!window.vibe || typeof window.vibe.tasks.setArchived !== 'function') return;
      try {
        const updated = await window.vibe.tasks.setArchived(taskId, archived);
        set((state) => ({ tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)) }));
      } catch (err) {
        set({ error: describeError(err) });
      }
    },

    async setGoal(taskId: string, goal: string) {
      if (!window.vibe || typeof window.vibe.tasks.setGoal !== 'function') return;
      try {
        const updated = await window.vibe.tasks.setGoal(taskId, goal);
        set((state) => ({ tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)) }));
      } catch (err) {
        set({ error: describeError(err) });
      }
    },

    async selectWorkspace(taskId: string) {
      if (!window.vibe || typeof window.vibe.workspace?.select !== 'function') return;
      try {
        const workspace = await window.vibe.workspace.select(taskId);
        set((state) => ({ workspaceByTask: { ...state.workspaceByTask, [taskId]: workspace } }));
      } catch (err) {
        set({ error: describeError(err) });
      }
    },

    setDraft(taskId: string, text: string) {
      set((state) => ({ draftByTask: { ...state.draftByTask, [taskId]: text } }));
      persistDraftDebounced(taskId, text);
    },

    async startTurn(taskId: string, text: string) {
      const trimmed = text.trim();
      if (!trimmed || !window.vibe) return;
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
        await window.vibe.turns.start({ taskId, text: trimmed });
        // turn.accepted event (delivered via subscription) reconciles the optimistic message.
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
      if (!trimmed || !window.vibe || typeof window.vibe.turns.queue !== 'function') return;
      set((state) => ({ draftByTask: { ...state.draftByTask, [taskId]: '' } }));
      persistDraftDebounced(taskId, '');
      try {
        await window.vibe.turns.queue({ taskId, text: trimmed });
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
      if (!trimmed || !window.vibe || typeof window.vibe.turns.steer !== 'function') return;
      set((state) => ({ draftByTask: { ...state.draftByTask, [taskId]: '' } }));
      persistDraftDebounced(taskId, '');
      try {
        await window.vibe.turns.steer({ taskId, text: trimmed, expectedTurnId });
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
            'Codex runtimeでは実行中の追加指示に対応していません。キュー追加を使ってください',
          );
        }
      }
    },

    async stopAndSend(taskId: string, text: string) {
      const trimmed = text.trim();
      if (!trimmed || !window.vibe || typeof window.vibe.turns.stopAndSend !== 'function') return;
      set((state) => ({ draftByTask: { ...state.draftByTask, [taskId]: '' } }));
      persistDraftDebounced(taskId, '');
      try {
        await window.vibe.turns.stopAndSend({ taskId, text: trimmed });
      } catch (err) {
        set((state) => ({
          draftByTask: { ...state.draftByTask, [taskId]: trimmed },
          error: describeError(err),
        }));
      }
    },

    async cancelActiveTurn(taskId: string) {
      const turn = get().turnByTask[taskId];
      if (!turn || turn.status !== 'running' || !window.vibe) return;
      set((state) => ({
        turnByTask: { ...state.turnByTask, [taskId]: { ...turn, status: 'canceling' } },
      }));
      try {
        await window.vibe.turns.cancel({ taskId, turnId: turn.turnId });
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

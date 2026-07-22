import { create } from 'zustand';
import type { ChatMessage, TaskSummary, TurnEvent, TurnStage } from '../types/vibe';

export type TurnStatus = 'running' | 'canceling' | 'completed' | 'canceled' | 'failed' | 'interrupted';

export type TurnRuntimeState = {
  turnId: string;
  stage: TurnStage;
  status: TurnStatus;
  startedAt: number;
  streamingMessageId: string | null;
  streamingContent: string;
};

export const STAGE_LABEL: Record<TurnStage, string> = {
  understanding: 'ユーザーの依頼を理解中',
  planning: '方針を組み立て中',
  executing: 'ファイル・コマンドを実行中',
  synthesizing: '回答をまとめ中',
};

export const STAGE_ORDER: TurnStage[] = ['understanding', 'planning', 'executing', 'synthesizing'];

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
  sendingByTask: Record<string, boolean>;
  draftByTask: Record<string, string>;
  pendingOptimisticIdByTask: Record<string, string | undefined>;

  /** Latest stage/turn-completion announcement text for the aria-live region (NFR-A11Y-03). */
  stageAnnouncement: string;

  init(): Promise<void>;
  selectTask(taskId: string): Promise<void>;
  createTask(): Promise<void>;
  renameTask(taskId: string, title: string): Promise<void>;
  setDraft(taskId: string, text: string): void;
  sendMessage(taskId: string, text: string): Promise<void>;
  cancelActiveTurn(taskId: string): Promise<void>;
};

let currentUnsubscribe: (() => void) | null = null;
let currentSubscribedTaskId: string | null = null;

function subscribeToTask(taskId: string, apply: (fn: (state: AppState) => Partial<AppState>) => void, get: () => AppState) {
  if (currentUnsubscribe) {
    currentUnsubscribe();
    currentUnsubscribe = null;
  }
  currentSubscribedTaskId = taskId;
  if (!window.vibe) return;
  currentUnsubscribe = window.vibe.turns.subscribe(taskId, (ev: TurnEvent) => {
    // Ignore stray events if the user has since switched tasks and this callback
    // has not been torn down yet (defensive; unsubscribe should prevent this).
    if (currentSubscribedTaskId !== taskId) return;
    handleTurnEvent(taskId, ev, apply, get);
  });
}

function handleTurnEvent(
  taskId: string,
  ev: TurnEvent,
  apply: (fn: (state: AppState) => Partial<AppState>) => void,
  get: () => AppState,
) {
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
    default:
      break;
  }
  void get; // reserved for future read-before-write needs
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
    sendingByTask: {},
    draftByTask: {},
    pendingOptimisticIdByTask: {},
    stageAnnouncement: '',

    async init() {
      if (!window.vibe) {
        set({ vibeAvailable: false, initialized: true });
        return;
      }
      set({ vibeAvailable: true, loadingTasks: true, error: null });
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

    async selectTask(taskId: string) {
      set({ selectedTaskId: taskId, loadingMessages: true, error: null });
      subscribeToTask(taskId, apply, get);
      if (!window.vibe) {
        set({ loadingMessages: false });
        return;
      }
      try {
        const messages = await window.vibe.tasks.messages(taskId);
        set((state) => ({
          messagesByTask: { ...state.messagesByTask, [taskId]: messages },
          loadingMessages: false,
        }));
      } catch (err) {
        set({ loadingMessages: false, error: describeError(err) });
      }
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

    setDraft(taskId: string, text: string) {
      set((state) => ({ draftByTask: { ...state.draftByTask, [taskId]: text } }));
    },

    async sendMessage(taskId: string, text: string) {
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
        messagesByTask: { ...state.messagesByTask, [taskId]: [...(state.messagesByTask[taskId] ?? []), optimisticMessage] },
        pendingOptimisticIdByTask: { ...state.pendingOptimisticIdByTask, [taskId]: optimisticId },
        sendingByTask: { ...state.sendingByTask, [taskId]: true },
        draftByTask: { ...state.draftByTask, [taskId]: '' },
      }));

      try {
        await window.vibe.turns.start({ taskId, text: trimmed });
        // turn.accepted event (delivered via subscription) reconciles the optimistic message.
      } catch (err) {
        set((state) => ({
          messagesByTask: {
            ...state.messagesByTask,
            [taskId]: (state.messagesByTask[taskId] ?? []).filter((m) => m.id !== optimisticId),
          },
          pendingOptimisticIdByTask: { ...state.pendingOptimisticIdByTask, [taskId]: undefined },
          sendingByTask: { ...state.sendingByTask, [taskId]: false },
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
  };
});

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

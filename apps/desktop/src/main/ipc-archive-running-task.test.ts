import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type TaskRunningWork } from '@sprint-coder/contracts';
import { IpcRouter, TaskMailbox, toPublicError } from './ipc';
import { TaskStillRunningError } from './persistence';
import { UpdateInstallMutationGate } from './update-install-mutation-gate';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  clipboard: {},
  dialog: {},
  ipcMain: { on: vi.fn() },
  MessageChannelMain: class {},
  BrowserWindow: class {},
  nativeImage: {},
  shell: {},
  utilityProcess: {},
  session: {},
  safeStorage: {},
  screen: {},
  globalShortcut: {},
}));

type Handler = (input: Record<string, unknown>, event: unknown, envelope: unknown) => unknown;
type Recorded = Pick<TaskRunningWork, 'turn' | 'team' | 'workers'>;
const IDLE: Recorded = { turn: false, team: false, workers: 0 };

/**
 * The archive handler as Main registers it: the real mailbox, mutation wrapper and refusal, over a
 * persistence that records what moves in the Task and a harness that counts its live commands.
 */
function archiveRouter(state: { recorded: Recorded; commands: number }) {
  const router = Object.create(IpcRouter.prototype) as { register(): void; mailbox: TaskMailbox };
  const handlers = new Map<string, Handler>();
  const setArchived = vi.fn((taskId: string, archived: boolean) => {
    // The persistence layer's own check, in its transaction (the double guard).
    if (archived && (state.recorded.turn || state.recorded.team))
      throw new TaskStillRunningError({ ...state.recorded, commands: 0 });
    return { id: taskId, archived };
  });
  const revokePendingHires = vi.fn();
  const endArchivedTaskDesktopControl = vi.fn(async () => undefined);
  Object.assign(router, {
    handle: (channel: string, _input: unknown, _output: unknown, handler: Handler) =>
      handlers.set(channel, handler),
    mailbox: new TaskMailbox(),
    pendingPermissionChanges: new Set<string>(),
    updateInstallMutationGate: new UpdateInstallMutationGate(),
    window: { webContents: { once: vi.fn() } },
    persistence: {
      getOperationResult: () => ({ found: false }),
      executeOperation: (...args: unknown[]) => (args[5] as () => unknown)(),
      getTaskRecordedWork: () => state.recorded,
      setArchived,
    },
    managedCodingHarness: { activeTaskCommandCount: () => state.commands },
    teamCoordinator: { revokePendingHires },
    endArchivedTaskDesktopControl,
  });
  router.register();
  const handler = handlers.get(IPC_CHANNELS.tasksSetArchived)!;
  let operation = 0;
  const archive = (archived: boolean) => {
    const payload = { taskId: 'task-1', archived };
    operation += 1;
    return Promise.resolve(
      handler(payload, {}, { operationId: `op-${operation}`, taskId: 'task-1', payload }),
    );
  };
  return { router, archive, setArchived, revokePendingHires, endArchivedTaskDesktopControl };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error('archive was not refused');
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(TaskStillRunningError);
  return toPublicError(error);
}

describe('the window’s snapshot of what moves in a Task (issue #1225)', () => {
  type ActivityProbe = {
    refreshTaskRunningWork(taskId: string): void;
    taskWithActivity(task: { id: string }): unknown;
  };

  it('sends the Task again only when what moves in it changed', () => {
    const state = { recorded: IDLE, commands: 0 };
    const router = Object.create(IpcRouter.prototype) as ActivityProbe;
    const send = vi.fn();
    Object.assign(router, {
      sentRunningWork: new Map<string, string>(),
      window: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } },
      persistence: {
        getTaskRecordedWork: () => state.recorded,
        getActiveTurnId: () => (state.recorded.turn ? 'turn-1' : null),
        getTask: (id: string) => ({
          id,
          projectId: null,
          title: 'Task',
          pinned: false,
          archived: false,
          goal: null,
          goalState: null,
          workspacePath: null,
          localOnly: false,
          createdAt: '2026-11-14T00:00:00.000Z',
          updatedAt: '2026-11-14T00:00:00.000Z',
        }),
      },
      managedCodingHarness: { activeTaskCommandCount: () => state.commands },
    });
    expect(router.taskWithActivity({ id: 'task-1' })).toMatchObject({ runningWork: null });
    router.refreshTaskRunningWork('task-1');
    expect(send).not.toHaveBeenCalled();
    // The Leader's Turn ended, a dev server goes on in the background.
    state.commands = 1;
    router.refreshTaskRunningWork('task-1');
    router.refreshTaskRunningWork('task-1');
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![1]).toMatchObject({
      id: 'task-1',
      activeTurnId: null,
      runningWork: { turn: false, team: false, workers: 0, commands: 1 },
    });
    state.commands = 0;
    router.refreshTaskRunningWork('task-1');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![1]).toMatchObject({ runningWork: null });
  });
});

describe('archiving a Task that still moves is refused (issue #1225)', () => {
  it.each([
    [
      'its Turn runs (or waits for an approval)',
      { recorded: { turn: true, team: false, workers: 0 }, commands: 0 },
      'このTaskは、まだ動いています（AIの作業）。AIの作業は入力欄の「実行を停止」で止めてから、アーカイブしてください。',
    ],
    [
      'its Team’s Workers go on after the Leader’s Turn',
      { recorded: { turn: false, team: true, workers: 2 }, commands: 0 },
      'このTaskは、まだ動いています（TeamのWorker 2人）。Teamは「すべて停止」（Workerの起動中は、少し待ってから）で止めてから、アーカイブしてください。',
    ],
    [
      'a command goes on in the background after its Turn',
      { recorded: IDLE, commands: 1 },
      'このTaskは、まだ動いています（実行中のコマンド 1件）。コマンドは「実行中のコマンドを停止」で止めてから、アーカイブしてください。',
    ],
    [
      'all three move',
      { recorded: { turn: true, team: true, workers: 1 }, commands: 3 },
      'このTaskは、まだ動いています（AIの作業／TeamのWorker 1人／実行中のコマンド 3件）。AIの作業は入力欄の「実行を停止」、Teamは「すべて停止」（Workerの起動中は、少し待ってから）、コマンドは「実行中のコマンドを停止」で止めてから、アーカイブしてください。',
    ],
  ])('while %s, naming what moves', async (_name, state, message) => {
    const { archive, setArchived, revokePendingHires, endArchivedTaskDesktopControl } =
      archiveRouter(state);
    expect(await refusal(archive(true))).toEqual({
      code: 'TASK_STILL_RUNNING',
      userMessage: message,
      retryable: false,
    });
    // Nothing was archived, and nothing of the archive's clean-up ran.
    expect(setArchived).not.toHaveBeenCalled();
    expect(revokePendingHires).not.toHaveBeenCalled();
    expect(endArchivedTaskDesktopControl).not.toHaveBeenCalled();
  });

  it('archives a Task with nothing moving, and still ends its desktop control (PR #1224)', async () => {
    const { archive, setArchived, revokePendingHires, endArchivedTaskDesktopControl } =
      archiveRouter({ recorded: IDLE, commands: 0 });
    await expect(archive(true)).resolves.toEqual({ id: 'task-1', archived: true });
    expect(setArchived).toHaveBeenCalledExactlyOnceWith('task-1', true);
    expect(revokePendingHires).toHaveBeenCalledWith('task-1');
    expect(endArchivedTaskDesktopControl).toHaveBeenCalledWith('task-1');
  });

  it('never refuses a restore, whatever moves', async () => {
    const { archive, setArchived } = archiveRouter({
      recorded: { turn: true, team: true, workers: 2 },
      commands: 1,
    });
    await expect(archive(false)).resolves.toEqual({ id: 'task-1', archived: false });
    expect(setArchived).toHaveBeenCalledExactlyOnceWith('task-1', false);
  });

  it('waits behind work queued in the Task’s mailbox, and sees a Turn it started', async () => {
    const state = { recorded: IDLE, commands: 0 };
    const { router, archive, setArchived } = archiveRouter(state);
    // A Turn's start runs in the same mailbox; one in flight finishes before the archive checks.
    let release = (): void => undefined;
    const started = router.mailbox.run('task-1', async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      state.recorded = { turn: true, team: false, workers: 0 };
    });
    const archived = archive(true);
    await Promise.resolve();
    release();
    await started;
    expect((await refusal(archived)).code).toBe('TASK_STILL_RUNNING');
    expect(setArchived).not.toHaveBeenCalled();
  });

  it('is refused by persistence itself when a Turn is recorded after Main’s check', async () => {
    const state = { recorded: IDLE, commands: 0 };
    const { archive, setArchived } = archiveRouter(state);
    // Main's snapshot says idle; the archive's own transaction sees the Turn (the double guard).
    let calls = 0;
    const recorded = { turn: true, team: false, workers: 0 };
    Object.defineProperty(state, 'recorded', {
      get: () => (calls++ === 0 ? IDLE : recorded),
    });
    expect((await refusal(archive(true))).userMessage).toContain('AIの作業');
    expect(setArchived).toHaveBeenCalledOnce();
  });
});

describe('the person’s stop of a Task’s running commands (issue #1225)', () => {
  /** The stop and the fresh read as Main registers them, over a harness holding live runs. */
  function stopRouter(state: { recorded: Recorded; commands: number; unconfirmed?: boolean }) {
    const router = Object.create(IpcRouter.prototype) as { register(): void };
    const handlers = new Map<string, Handler>();
    const send = vi.fn();
    const stopTaskCommands = vi.fn(async (_taskId: string) => {
      if (state.unconfirmed) throw new Error('Managed command Task stop could not be confirmed');
      state.commands = 0;
    });
    Object.assign(router, {
      handle: (channel: string, _input: unknown, _output: unknown, handler: Handler) =>
        handlers.set(channel, handler),
      mailbox: new TaskMailbox(),
      pendingPermissionChanges: new Set<string>(),
      updateInstallMutationGate: new UpdateInstallMutationGate(),
      sentRunningWork: new Map<string, string>(),
      window: {
        isDestroyed: () => false,
        webContents: { once: vi.fn(), isDestroyed: () => false, send },
      },
      persistence: {
        getTaskRecordedWork: () => state.recorded,
        getActiveTurnId: () => null,
        getTask: (id: string) => ({
          id,
          projectId: null,
          title: 'Task',
          pinned: false,
          archived: false,
          goal: null,
          goalState: null,
          workspacePath: null,
          localOnly: false,
          createdAt: '2026-11-14T00:00:00.000Z',
          updatedAt: '2026-11-14T00:00:00.000Z',
        }),
      },
      managedCodingHarness: {
        activeTaskCommandCount: () => state.commands,
        stopTaskCommands,
      },
    });
    router.register();
    const call = (channel: string) => {
      const payload = { taskId: 'task-1' };
      return Promise.resolve(
        handlers.get(channel)!(payload, {}, { operationId: 'op-1', taskId: 'task-1', payload }),
      );
    };
    return { call, send, stopTaskCommands };
  }

  it('stops every command of the Task, an earlier Turn’s included, and says what still moves', async () => {
    // A dev server the first Turn left in the background; no Turn runs.
    const { call, send, stopTaskCommands } = stopRouter({ recorded: IDLE, commands: 1 });
    await expect(call(IPC_CHANNELS.commandsStopTask)).resolves.toBeNull();
    expect(stopTaskCommands).toHaveBeenCalledExactlyOnceWith('task-1');
    // The window's snapshot follows, so 「アーカイブ」 can be pressed again.
    expect(send).toHaveBeenLastCalledWith(
      IPC_CHANNELS.tasksUpdated,
      expect.objectContaining({ id: 'task-1', runningWork: null }),
    );
  });

  it('leaves what else moves to its own stop', async () => {
    const { call } = stopRouter({ recorded: { turn: true, team: false, workers: 0 }, commands: 2 });
    await expect(call(IPC_CHANNELS.commandsStopTask)).resolves.toEqual({
      turn: true,
      team: false,
      workers: 0,
      commands: 0,
    });
  });

  it('says so when a command’s end could not be confirmed', async () => {
    const { call } = stopRouter({ recorded: IDLE, commands: 1, unconfirmed: true });
    const error = await call(IPC_CHANNELS.commandsStopTask).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(toPublicError(error)).toEqual({
      code: 'RUNTIME_STOP_UNCONFIRMED',
      userMessage:
        'コマンドの停止を確認できませんでした。アプリを再起動してからもう一度お試しください。',
      retryable: true,
    });
  });

  it('reads what moves afresh, so a stale snapshot never holds an archive back', async () => {
    const state = { recorded: IDLE, commands: 1 };
    const { call, send } = stopRouter(state);
    await expect(call(IPC_CHANNELS.tasksRunningWork)).resolves.toMatchObject({ commands: 1 });
    // The run ended unseen; the next read says nothing moves.
    state.commands = 0;
    await expect(call(IPC_CHANNELS.tasksRunningWork)).resolves.toBeNull();
    expect(send).toHaveBeenLastCalledWith(
      IPC_CHANNELS.tasksUpdated,
      expect.objectContaining({ runningWork: null }),
    );
  });
});

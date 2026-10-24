import { TurnStreamingResources } from './turn-streaming-resources';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { IpcRouter } from './ipc';
import { FullAccessConfirmation } from './full-access-confirmation';
import { secureLogger } from './secure-logger';
import { IPC_CHANNELS } from '@sprint-coder/contracts';

const ipc = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  removeListener: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { isPackaged: false },
  clipboard: {},
  dialog: {},
  ipcMain: ipc,
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

it('broadcasts terminal activity to the window even without a Task event port', () => {
  const send = vi.fn();
  const invalidate = vi.fn();
  const router = Object.create(IpcRouter.prototype) as { publish(event: unknown): void };
  Object.assign(router, {
    window: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } },
    ports: new Set(),
    recordTurnDiagnosticEvent: vi.fn(),
    graphSourceMonitor: { invalidate },
    persistence: {
      getActiveTurnId: () => null,
      getTask: () => ({
        id: 'task-1',
        title: 'Task',
        pinned: false,
        archived: false,
        goal: null,
        workspacePath: null,
        localOnly: false,
        createdAt: '2026-09-05T00:00:00.000Z',
        updatedAt: '2026-09-05T00:00:00.000Z',
      }),
    },
  });
  router.publish({
    type: 'turn.completed',
    taskId: 'task-1',
    turnId: 'turn-1',
    seq: 2,
    state: 'completed',
    diff: [],
  });
  expect(send).toHaveBeenCalledWith(
    IPC_CHANNELS.tasksUpdated,
    expect.objectContaining({ id: 'task-1', activeTurnId: null }),
  );
  expect(invalidate).toHaveBeenCalledWith('task-1');
});

it.each([false, true])(
  'finishes resource disposal after a destroyed window (tail failure: %s)',
  async (tailFails) => {
    const router = Object.create(IpcRouter.prototype) as IpcRouter;
    let resumeDisposal!: () => void;
    const heldDisposal = new Promise<void>((resolve) => {
      resumeDisposal = resolve;
    });
    const dispose = vi.fn<() => void | Promise<void>>().mockImplementationOnce(() => heldDisposal);
    const streamFailure = new Error('reasoning sink unavailable');
    const emit = vi.fn(() => {
      if (tailFails) throw streamFailure;
    });
    const resources = new TurnStreamingResources(emit);
    const lease = resources.begin('task-stream', 'turn-stream')!;
    const stop = vi.fn();
    lease.pushReasoning('safe tail\nraw carry');
    lease.replaceWatchers(() => [{ stop }]);
    const providerAbort = new AbortController();
    providerAbort.signal.addEventListener('abort', () => {
      expect(resources.size).toBe(0);
      lease.pushReasoning('too late\n');
      expect(resources.begin('new-task', 'new-turn')).toBeUndefined();
    });
    const policyCleanups = new Map([['task-1', { epoch: 3, confirm: vi.fn() }]]);
    const disposeGraphSources = vi.fn();
    const fullAccessConfirmation = new FullAccessConfirmation();
    let confirmationSignal: AbortSignal | undefined;
    const pendingConfirmation = fullAccessConfirmation.confirm((signal) => {
      confirmationSignal = signal;
      return new Promise<boolean>(() => undefined);
    });
    const state: Record<string, unknown> = {
      window: {
        isDestroyed: () => true,
        get webContents() {
          throw new Error('Object has been destroyed');
        },
      },
      turnStreamingResources: resources,
      policyCleanupsByTask: policyCleanups,
      taskTitleProviderAborts: { abortAll: vi.fn() },
      fullAccessConfirmation,
      closeAllPorts: vi.fn(),
      graphSourceMonitor: { dispose: disposeGraphSources },
    };
    for (const key of [
      'providerAbortByTurn',
      'computerUseSessionByTask',
      'computerUsePendingApprovalBySession',
      'computerUseApprovalSessionById',
      'computerUseStatusBySession',
      'computerUseQuickStartLatches',
      'teamDetailStream',
      'cliTaskTitleJobs',
      'pendingTaskTitles',
      'attachmentCustodyByTurn',
      'attachmentCapabilityByTurn',
    ])
      state[key] = new Map();
    state['providerAbortByTurn'] = new Map([['turn-stream', providerAbort]]);
    state['computerUsePendingGrantRequestIds'] = new Set();
    for (const key of [
      'computerUseController',
      'computerUseActivationGate',
      'computerUseEmergencyStop',
      'approvalCoordinator',
      'managedCodingHarness',
      'mockRuntime',
      'taskTitleRuntimes',
      'codexRuntime',
      'teamWorkerRuntime',
      'compatibleRuntime',
      'claudeRuntime',
      'grokRuntime',
      'attachmentCustodyStore',
      'teamMcpBridge',
    ])
      state[key] = { dispose };
    Object.assign(router, state);
    const pendingDisposal = router.dispose();
    const disposalOutcome = pendingDisposal.then(
      () => null,
      (error: unknown) => error,
    );
    // The fence and safe-tail cleanup precede abort callbacks and the first awaited subsystem.
    expect(resources.size).toBe(0);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledExactlyOnceWith('task-stream', 'turn-stream', {
      text: 'safe tail\n',
      truncated: false,
    });
    resumeDisposal();
    expect(await disposalOutcome).toBe(tailFails ? streamFailure : null);
    expect(providerAbort.signal.aborted).toBe(true);
    expect(confirmationSignal?.aborted).toBe(true);
    await expect(pendingConfirmation).resolves.toBe(false);
    await expect(fullAccessConfirmation.confirm(async () => true)).resolves.toBe(false);
    expect(dispose).toHaveBeenCalledTimes(14);
    expect(disposeGraphSources).toHaveBeenCalledTimes(1);
    expect(policyCleanups.size).toBe(0);
  },
);

it('reports invalid handler output as an internal failure without exposing schema contents', async () => {
  const router = Object.create(IpcRouter.prototype) as {
    handle(channel: string, input: z.ZodType, output: z.ZodType, handler: () => unknown): void;
  };
  Object.assign(router, { validateSender: vi.fn() });
  const log = vi.spyOn(secureLogger, 'error').mockImplementation(() => undefined);
  try {
    router.handle(
      'test-output',
      z.object({}),
      z.enum(['private-schema-value']),
      () => 'private-output',
    );
    const callback = ipc.handle.mock.calls.at(-1)![1] as (
      event: unknown,
      raw: unknown,
    ) => Promise<unknown>;
    const result = await callback(
      {},
      { requestId: randomUUID(), operationId: randomUUID(), payload: {} },
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify([result, log.mock.calls])).not.toContain('private-');
  } finally {
    log.mockRestore();
  }
});

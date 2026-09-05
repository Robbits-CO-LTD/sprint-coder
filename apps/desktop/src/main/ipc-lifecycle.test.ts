import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { IpcRouter } from './ipc';
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
  const router = Object.create(IpcRouter.prototype) as { publish(event: unknown): void };
  Object.assign(router, {
    window: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } },
    ports: new Set(),
    recordTurnDiagnosticEvent: vi.fn(),
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
});

it('finishes resource disposal after the BrowserWindow has been destroyed', async () => {
  const router = Object.create(IpcRouter.prototype) as IpcRouter;
  const dispose = vi.fn();
  const state: Record<string, unknown> = {
    window: {
      isDestroyed: () => true,
      get webContents() {
        throw new Error('Object has been destroyed');
      },
    },
    taskTitleProviderAborts: { abortAll: vi.fn() },
    closeAllPorts: vi.fn(),
  };
  for (const key of [
    'providerAbortByTurn',
    'computerUseSessionByTask',
    'computerUsePendingApprovalBySession',
    'computerUseApprovalSessionById',
    'computerUseStatusBySession',
    'computerUseQuickStartLatches',
    'teamSubscriptions',
    'workspaceWatchByTurn',
    'cliTaskTitleJobs',
    'pendingTaskTitles',
    'attachmentCustodyByTurn',
    'attachmentCapabilityByTurn',
  ])
    state[key] = new Map();
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
    'attachmentCustodyStore',
    'teamMcpBridge',
  ])
    state[key] = { dispose };
  Object.assign(router, state);
  await expect(router.dispose()).resolves.toBeUndefined();
  expect(dispose).toHaveBeenCalledTimes(13);
});

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

import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@sprint-coder/contracts';
import { IpcRouter, toPublicError } from './ipc';

vi.mock('electron', () => ({ ipcMain: { on: vi.fn() } }));

describe('permission change cleanup delivery', () => {
  function permissionHandler(replay = false) {
    type Handler = (input: unknown, event: unknown, envelope: unknown) => Promise<unknown>;
    let handler: Handler | undefined;
    const policy = { preset: 'ask', policyEpoch: 3 };
    const drain = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const invalidate = vi.fn();
    const router = Object.create(IpcRouter.prototype) as Record<string, unknown>;
    Object.assign(router, {
      handle: vi.fn(),
      handleMutation: (channel: string, _input: unknown, _output: unknown, action: Handler) => {
        if (channel === IPC_CHANNELS.permissionsSet) handler = action;
      },
      window: { webContents: { once: vi.fn() } },
      permissionBroker: {
        getPolicy: () => ({ preset: 'full', policyEpoch: 2 }),
        drainPolicyEpochOutbox: drain,
      },
      persistence: {
        getOperationResult: () => (replay ? { found: true, value: policy } : { found: false }),
        executeOperation: (
          _principal: string,
          _task: string,
          _channel: string,
          _operation: string,
          _hash: string,
          action: () => unknown,
        ) => action(),
        setAccessPreset: vi.fn(() => policy),
      },
      graphSourceMonitor: { invalidate },
    });
    IpcRouter.prototype.register.call(router as unknown as IpcRouter);
    if (!handler) throw new Error('permissions handler missing');
    const input = { taskId: 'task-1', preset: 'ask', expectedPolicyEpoch: 2 };
    return {
      drain,
      invalidate,
      invoke: () => handler!(input, {}, { operationId: 'op-1', payload: input }),
    };
  }

  it.each([false, true])(
    'reports cleanup failure even for an operation replay=%s',
    async (replay) => {
      const f = permissionHandler(replay);
      f.drain.mockRejectedValue(new Error('stop not confirmed'));
      await expect(
        f.invoke().catch((error: unknown) => {
          throw toPublicError(error);
        }),
      ).rejects.toMatchObject({
        code: 'OPERATION_IN_PROGRESS',
        retryable: true,
        userMessage: expect.stringContaining('権限の変更は保存されました'),
      });
      expect(f.drain).toHaveBeenCalledOnce();
    },
  );
});

describe('permission epoch coordinator', () => {
  it.each([false, true])(
    'awaits command cleanup after revocation/quarantine (failure=%s)',
    async (failure) => {
      const events: string[] = [];
      let confirm = (): void => undefined;
      let fail = (): void => undefined;
      const cleanup = new Promise<void>((resolve, reject) => {
        confirm = resolve;
        fail = () => reject(new Error('stop unconfirmed'));
      });
      const router = Object.create(IpcRouter.prototype) as Record<string, unknown>;
      Object.assign(router, {
        policyCleanupsByTask: new Map(),
        approvalCoordinator: { policyEpochChanged: () => events.push('approvals') },
        computerUseController: { policyEpochChanged: () => events.push('computer') },
        persistence: { quarantineBackgroundForPolicyEpoch: () => events.push('quarantine') },
        managedCodingHarness: {
          beginPolicyEpochChange: () => {
            events.push('commands');
            return () => cleanup;
          },
        },
      });
      const notify = Reflect.get(IpcRouter.prototype, 'policyEpochChanged') as (
        this: unknown,
        taskId: string,
        epoch: number,
      ) => Promise<void>;
      let completed = false;
      const result = notify.call(router, 'task-1', 3).then(() => {
        completed = true;
      });
      await Promise.resolve();
      expect(events).toEqual(['approvals', 'computer', 'quarantine', 'commands']);
      expect(completed).toBe(false);
      if (failure) {
        const rejected = expect(result).rejects.toThrow('stop unconfirmed');
        fail();
        await rejected;
      } else {
        confirm();
        await result;
        expect(completed).toBe(true);
      }
    },
  );
});

it('retries a captured cleanup without repeating revocation, and starts new epochs immediately', async () => {
  let failFirst = (): void => undefined;
  const firstCleanup = new Promise<void>((_resolve, reject) => {
    failFirst = () => reject(new Error('unconfirmed'));
  });
  const firstConfirmation = vi.fn(() => firstCleanup);
  const nextConfirmation = vi.fn().mockResolvedValue(undefined);
  const begin = vi
    .fn()
    .mockReturnValueOnce(firstConfirmation)
    .mockReturnValueOnce(nextConfirmation);
  const revoke = vi.fn();
  const router = Object.create(IpcRouter.prototype) as Record<string, unknown>;
  Object.assign(router, {
    policyCleanupsByTask: new Map(),
    approvalCoordinator: { policyEpochChanged: revoke },
    computerUseController: { policyEpochChanged: vi.fn() },
    persistence: { quarantineBackgroundForPolicyEpoch: vi.fn() },
    managedCodingHarness: { beginPolicyEpochChange: begin },
  });
  const notify = Reflect.get(IpcRouter.prototype, 'policyEpochChanged') as (
    this: unknown,
    taskId: string,
    epoch: number,
  ) => Promise<void>;
  const first = expect(notify.call(router, 'task-1', 3)).rejects.toThrow('unconfirmed');
  const duplicate = expect(notify.call(router, 'task-1', 3)).rejects.toThrow('unconfirmed');
  expect(revoke).toHaveBeenCalledTimes(1);
  expect(begin).toHaveBeenCalledTimes(1);
  await notify.call(router, 'task-1', 4);
  failFirst();
  await first;
  await duplicate;
  await notify.call(router, 'task-1', 3);
  expect(revoke.mock.calls).toEqual([
    ['task-1', 3],
    ['task-1', 4],
  ]);
  expect(begin).toHaveBeenCalledTimes(2);
  expect(firstConfirmation).toHaveBeenCalledTimes(2);
  expect(nextConfirmation).toHaveBeenCalledTimes(1);
});

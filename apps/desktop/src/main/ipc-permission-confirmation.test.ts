import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import type { z } from 'zod';
import { IPC_CHANNELS, type CommandResult, type PermissionSettings } from '@sprint-coder/contracts';
import { IpcRouter, TaskMailbox } from './ipc';
import {
  FullAccessConfirmation,
  FULL_ACCESS_CONFIRMATION_TIMEOUT_MS,
} from './full-access-confirmation';
import { OperationConflictError } from './persistence';
import { UpdateInstallMutationGate } from './update-install-mutation-gate';
import { secureLogger } from './secure-logger';

type Invoke = (event: unknown, raw: unknown) => Promise<CommandResult<unknown>>;
const electron = vi.hoisted(() => ({
  handlers: new Map<string, Invoke>(),
  showMessageBox:
    vi.fn<(_window: unknown, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn(),
    handle: (channel: string, invoke: Invoke) => electron.handlers.set(channel, invoke),
  },
  dialog: { showMessageBox: electron.showMessageBox },
}));

const newWork = [
  [
    IPC_CHANNELS.turnsStart,
    { text: 'こんにちは', skills: [], attachmentIds: [], attachmentSelectionIdentity: null },
  ],
  [IPC_CHANNELS.turnsQueue, { text: '続き', skills: [] }],
  [IPC_CHANNELS.turnsSteer, { text: '続き', expectedTurnId: 'active-turn' }],
  [IPC_CHANNELS.turnsStopAndSend, { text: '続き', skills: [] }],
  [IPC_CHANNELS.goalsStart, { objective: '作業', skills: [] }],
  [IPC_CHANNELS.goalsResume, { skills: [] }],
] as const;

function fixture(acknowledged = false) {
  const policies = new Map<string, PermissionSettings>();
  const operations = new Map<string, { hash: string; value: unknown }>();
  const confirmations: Array<{ signal: AbortSignal; respond: (response: number) => void }> = [];
  electron.showMessageBox.mockImplementation(
    (_window, options) =>
      new Promise((resolve) => {
        if (options.signal === undefined)
          throw new Error('Native confirmation requires cancellation');
        confirmations.push({
          signal: options.signal,
          respond: (response) => resolve({ response, checkboxChecked: false }),
        });
      }),
  );
  const getPolicy = (taskId: string): PermissionSettings =>
    policies.get(taskId) ?? { preset: 'ask', policyEpoch: 0 };
  const setAccessPreset = vi.fn(
    (taskId: string, preset: PermissionSettings['preset'], epoch: number) => {
      const policy = { preset, policyEpoch: epoch + 1 };
      policies.set(taskId, policy);
      return policy;
    },
  );
  const startTurn = vi.fn(() => ({ turnId: randomUUID() }));
  const drain = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const pending = new Set<string>();
  const confirmation = new FullAccessConfirmation();
  const gate = new UpdateInstallMutationGate();
  const capture = Reflect.get(IpcRouter.prototype, 'handle') as (
    this: unknown,
    channel: string,
    input: z.ZodType,
    output: z.ZodType,
    action: (input: unknown, event: unknown, envelope: unknown) => unknown,
  ) => void;
  const channels = new Set<string>([
    IPC_CHANNELS.permissionsSet,
    ...newWork.map(([channel]) => channel),
  ]);
  const router = Object.create(IpcRouter.prototype) as Record<string, unknown>;
  Object.assign(router, {
    window: { webContents: { id: 1, once: vi.fn() } },
    trustedRendererOrigin: 'http://localhost:5173',
    mailbox: new TaskMailbox(),
    pendingPermissionChanges: pending,
    fullAccessConfirmation: confirmation,
    updateInstallMutationGate: gate,
    handle: (
      channel: string,
      input: z.ZodType,
      output: z.ZodType,
      action: Parameters<typeof capture>[3],
    ) => {
      if (channels.has(channel)) capture.call(router, channel, input, output, action);
    },
    persistence: {
      getOperationResult: (
        _principal: string,
        taskId: string,
        channel: string,
        operationId: string,
        hash: string,
      ) => {
        const cached = operations.get(`${taskId}:${channel}:${operationId}`);
        if (cached !== undefined && cached.hash !== hash) throw new OperationConflictError();
        return cached === undefined ? { found: false } : { found: true, value: cached.value };
      },
      executeOperation: (
        _principal: string,
        taskId: string,
        channel: string,
        operationId: string,
        hash: string,
        action: () => unknown,
      ) => {
        const value = action();
        operations.set(`${taskId}:${channel}:${operationId}`, { hash, value });
        return value;
      },
      hasAcknowledgedFullAccessRisk: () => acknowledged,
      acknowledgeFullAccessRisk: () => {
        acknowledged = true;
      },
      getTaskModelSelection: () => null,
      getRuntime: () => 'mock',
      setAccessPreset,
      startTurn,
    },
    permissionBroker: { getPolicy, drainPolicyEpochOutbox: drain },
    skillSettings: { resolveSelections: vi.fn().mockResolvedValue([]) },
    graphSourceMonitor: { invalidate: vi.fn() },
    dispatchStarted: vi.fn(),
  });
  IpcRouter.prototype.register.call(router as unknown as IpcRouter);
  const frame: { url: string; top?: unknown } = { url: 'http://localhost:5173/' };
  frame.top = frame;
  const event = { sender: { id: 1 }, senderFrame: frame };
  const invoke = (
    channel: string,
    payload: Record<string, unknown>,
    operationId = randomUUID(),
  ) => {
    const handler = electron.handlers.get(channel);
    if (handler === undefined) throw new Error('Handler missing');
    return handler(event, {
      requestId: randomUUID(),
      operationId,
      taskId: payload.taskId,
      payload,
    });
  };
  return {
    pending,
    gate,
    policies,
    confirmations,
    confirmation,
    startTurn,
    setAccessPreset,
    drain,
    invoke,
    acknowledged: () => acknowledged,
    change: (taskId = 'task-1', operationId = randomUUID()) =>
      invoke(
        IPC_CHANNELS.permissionsSet,
        { taskId, preset: 'full', expectedPolicyEpoch: 0 },
        operationId,
      ),
    send: (taskId = 'task-1') => invoke(IPC_CHANNELS.turnsStart, { taskId, ...newWork[0][1] }),
  };
}

async function flush() {
  for (let index = 0; index < 15; index += 1) await Promise.resolve();
}

describe('Turn text through the registered IPC handler', () => {
  it.each([
    ['    担当を雇ってください。\n\nこの例文を添削してください。\n', false],
    ['担当を雇ってください。', true],
  ] as const)(
    'preserves text and seals only actual hiring instructions',
    async (text, teamTurn) => {
      const f = fixture();
      const result = await f.invoke(IPC_CHANNELS.turnsStart, {
        taskId: 'task-1',
        text,
        skills: [],
        attachmentIds: [],
        attachmentSelectionIdentity: null,
      });
      expect(result).toMatchObject({ ok: true });
      expect(f.startTurn).toHaveBeenCalledWith(
        'task-1',
        text,
        [],
        teamTurn,
        [],
        expect.any(Function),
      );
    },
  );
});

beforeEach(() => {
  electron.handlers.clear();
  electron.showMessageBox.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('permission confirmation admission through the real IPC handlers and Task mailbox', () => {
  it('refuses every new-work channel before an unanswered native confirmation, then sends after approval', async () => {
    const f = fixture();
    const changing = f.change();
    // No await between permission admission and the first send: the marker must already exist.
    const requests = newWork.map(([channel, input]) =>
      f.invoke(channel, { taskId: 'task-1', ...input }),
    );
    for (const response of await Promise.all(requests))
      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'OPERATION_IN_PROGRESS',
          userMessage: expect.stringContaining('確認ダイアログ'),
        },
      });
    expect(await f.change()).toMatchObject({ ok: false, error: { code: 'OPERATION_IN_PROGRESS' } });
    expect(f.acknowledged()).toBe(false);
    expect(f.policies.size).toBe(0);
    expect(f.startTurn).not.toHaveBeenCalled();
    expect(f.confirmations).toHaveLength(1);
    f.confirmations[0]!.respond(1);
    expect(await changing).toMatchObject({ ok: true, value: { preset: 'full', policyEpoch: 1 } });
    expect(f.pending.size).toBe(0);
    expect(f.acknowledged()).toBe(true);
    expect(await f.send()).toMatchObject({ ok: true });
    expect(f.startTurn).toHaveBeenCalledOnce();
  });

  it.each([0, 1])(
    'keeps cancel/accept and operation replay cleanup semantics (response=%s)',
    async (response) => {
      const f = fixture();
      const operationId = randomUUID();
      const changing = f.change('task-1', operationId);
      await flush();
      expect(electron.showMessageBox.mock.calls[0]![1]).toMatchObject({
        defaultId: 0,
        cancelId: 0,
      });
      f.confirmations[0]!.respond(response);
      const result = await changing;
      expect(result.ok).toBe(response === 1);
      expect(f.acknowledged()).toBe(response === 1);
      expect(f.policies.size).toBe(response);
      expect(f.pending.size).toBe(0);
      if (response === 1) {
        f.drain.mockRejectedValueOnce(new Error('cleanup unconfirmed'));
        expect(await f.change('task-1', operationId)).toMatchObject({
          ok: false,
          error: {
            code: 'OPERATION_IN_PROGRESS',
            userMessage: expect.stringContaining('保存されました'),
          },
        });
        expect(await f.change('task-1', operationId)).toMatchObject({
          ok: true,
          value: { preset: 'full' },
        });
        expect(f.setAccessPreset).toHaveBeenCalledOnce();
        expect(f.drain).toHaveBeenCalledTimes(3);
        expect(
          await f.invoke(
            IPC_CHANNELS.permissionsSet,
            { taskId: 'task-1', preset: 'auto', expectedPolicyEpoch: 0 },
            operationId,
          ),
        ).toMatchObject({ ok: false, error: { code: 'OPERATION_CONFLICT' } });
      }
      expect(await f.send()).toMatchObject({ ok: true });
    },
  );

  it('expires at 120 seconds even if native never settles, ignores a late approval, and releases the mailbox', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let settled = false;
    const changing = f.change().then((result) => {
      settled = true;
      return result;
    });
    await flush();
    await vi.advanceTimersByTimeAsync(FULL_ACCESS_CONFIRMATION_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(f.confirmations[0]!.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await changing).toMatchObject({ ok: false, error: { code: 'USER_CANCELED' } });
    expect(f.confirmations[0]!.signal.aborted).toBe(true);
    expect(f.pending.size).toBe(0);
    f.confirmations[0]!.respond(1);
    await flush();
    expect(f.acknowledged()).toBe(false);
    expect(f.setAccessPreset).not.toHaveBeenCalled();
    expect(await f.send()).toMatchObject({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps Tasks independent, preserves work admitted earlier, and does not share approval on cancellation', async () => {
    const f = fixture();
    const earlier = f.send();
    const first = f.change();
    const second = f.change('task-2');
    expect(await earlier).toMatchObject({ ok: true });
    expect(await f.send('task-3')).toMatchObject({ ok: true });
    await flush();
    expect(f.confirmations).toHaveLength(2);
    // Task 2 reaches its dialog first, while Task 1 waits behind the accepted send.
    f.confirmations[0]!.respond(1);
    expect(await second).toMatchObject({ ok: true });
    f.confirmations[1]!.respond(0);
    expect(await first).toMatchObject({ ok: false, error: { code: 'USER_CANCELED' } });
    expect(f.policies.has('task-1')).toBe(false);
    expect(f.policies.get('task-2')?.preset).toBe('full');
    expect(f.acknowledged()).toBe(true);
    expect(f.pending.size).toBe(0);
  });

  it('rechecks the policy epoch after approval and cleans admission up on errors or install-gate refusal', async () => {
    const f = fixture();
    const changing = f.change();
    await flush();
    f.policies.set('task-1', { preset: 'auto', policyEpoch: 1 });
    f.confirmations[0]!.respond(1);
    expect(await changing).toMatchObject({ ok: false, error: { code: 'OPERATION_CONFLICT' } });
    expect(f.setAccessPreset).not.toHaveBeenCalled();
    expect(f.pending.size).toBe(0);
    await f.gate.closeWhenIdle(() => true);
    vi.spyOn(secureLogger, 'error').mockImplementation(() => undefined);
    expect(await f.change('task-2')).toMatchObject({ ok: false });
    expect(f.pending.size).toBe(0);
  });

  it('skips native prompting only when acknowledged and rejects malformed input before marking pending', async () => {
    const f = fixture(true);
    expect(
      await f.invoke(IPC_CHANNELS.permissionsSet, {
        taskId: 'task-1',
        preset: 'invalid',
        expectedPolicyEpoch: 0,
      }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(f.pending.size).toBe(0);
    expect(await f.change()).toMatchObject({ ok: true });
    expect(electron.showMessageBox).not.toHaveBeenCalled();
    expect(await f.send()).toMatchObject({ ok: true });
  });
});

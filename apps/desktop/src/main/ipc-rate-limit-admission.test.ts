import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@sprint-coder/contracts';
import { IpcRouter } from './ipc';
import { managedLocalConnection } from './managed-local-provider-runtime';
vi.mock('electron', () => ({
  app: {},
  clipboard: {},
  dialog: {},
  ipcMain: { on: vi.fn() },
  MessageChannelMain: class {},
  shell: {},
}));
describe('connection rate-limit mutation', () => {
  it('refreshes Team admission only after a successful IPC rate-limit mutation', () => {
    const router = Object.create(IpcRouter.prototype) as Record<string, unknown>;
    const connection = managedLocalConnection();
    const lower = vi.fn(() => connection);
    const refresh = vi.fn();
    let handler!: (
      input: { connectionId: string; tokensPerMinute: number },
      event: unknown,
      envelope: unknown,
    ) => unknown;
    const captured = new Error('captured');
    Object.assign(router, {
      handle: vi.fn(),
      handleMutation: (
        channel: string,
        _input: unknown,
        _output: unknown,
        callback: typeof handler,
      ) => {
        if (channel === IPC_CHANNELS.providersLowerRateLimits) {
          handler = callback;
          throw captured;
        }
      },
      runMutation: (
        _event: unknown,
        _envelope: unknown,
        _task: unknown,
        _channel: unknown,
        action: () => unknown,
      ) => ({ value: action() }),
      persistence: { lowerProviderConnectionRateLimits: lower },
      teamCoordinator: { refreshConnectionAdmission: refresh },
    });
    expect(() => IpcRouter.prototype.register.call(router)).toThrow(captured);
    expect(handler({ connectionId: connection.id, tokensPerMinute: 19_999 }, {}, {})).toBe(
      connection,
    );
    expect(lower).toHaveBeenCalledWith(connection.id, { tokensPerMinute: 19_999 });
    expect(refresh).toHaveBeenCalledExactlyOnceWith(connection);
    lower.mockImplementationOnce(() => {
      throw new Error('mutation denied');
    });
    expect(() => handler({ connectionId: connection.id, tokensPerMinute: 19_998 }, {}, {})).toThrow(
      'mutation denied',
    );
    expect(refresh).toHaveBeenCalledOnce();
  });
});

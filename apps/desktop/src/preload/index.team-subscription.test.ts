// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type SprintCoderApi } from '@sprint-coder/contracts';

const bridge = vi.hoisted(() => ({
  expose: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: bridge.expose },
  ipcRenderer: bridge,
}));
await import('./index');
const api: SprintCoderApi = bridge.expose.mock.calls[0]![1];

beforeEach(() => {
  bridge.invoke.mockReset();
  bridge.on.mockClear();
  bridge.removeListener.mockClear();
});

describe('Team preload failure boundary', () => {
  it('reports subscribe failure and detaches the failed event listener', async () => {
    bridge.invoke.mockRejectedValue(new Error('synthetic subscribe failure'));
    const listener = vi.fn();
    const failure = vi.fn();
    const dispose = api.teams.subscribe('task-failure', listener, failure);
    await vi.waitFor(() => expect(failure).toHaveBeenCalledTimes(1));
    expect(listener).not.toHaveBeenCalled();
    expect(bridge.removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.teamsEvent,
      bridge.on.mock.calls[0]![1],
    );
    dispose();
  });

  it('does not report a late rejection for a disposed subscription', async () => {
    let reject!: (reason: Error) => void;
    const pending = new Promise((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    bridge.invoke.mockReturnValueOnce(pending).mockResolvedValue(undefined);
    const listener = vi.fn();
    const failure = vi.fn();
    const dispose = api.teams.subscribe('task-disposed', listener, failure);
    dispose();
    reject(new Error('late synthetic failure'));
    await pending.catch(() => undefined);
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
  });
});

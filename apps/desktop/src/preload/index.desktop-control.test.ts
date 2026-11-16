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
  bridge.send.mockReset();
});

describe('desktop-control permission bridge', () => {
  it('reads the permissions and drops an answer outside the contract', async () => {
    bridge.invoke.mockResolvedValueOnce({
      applicable: true,
      accessibility: 'granted',
      screenRecording: 'denied',
    });
    await expect(api.desktopControl.getPermissions()).resolves.toEqual({
      applicable: true,
      accessibility: 'granted',
      screenRecording: 'denied',
    });
    expect(bridge.invoke).toHaveBeenCalledWith(IPC_CHANNELS.desktopControlGetPermissions);

    bridge.invoke.mockResolvedValueOnce({ applicable: true, accessibility: 'yes' });
    await expect(api.desktopControl.getPermissions()).rejects.toThrow();
  });

  it('sends only a known pane name', () => {
    api.desktopControl.openPermissionSettings('screen-recording');
    expect(bridge.send).toHaveBeenCalledWith(
      IPC_CHANNELS.desktopControlOpenPermissionSettings,
      'screen-recording',
    );
    expect(() => api.desktopControl.openPermissionSettings('camera' as never)).toThrow();
    expect(bridge.send).toHaveBeenCalledTimes(1);
  });
});

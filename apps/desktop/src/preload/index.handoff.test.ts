// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type SprintCoderApi } from '@sprint-coder/contracts';
import { foregroundHandoffActivationIntent } from '../computer-use-activation-intent';

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
const listeners = vi.spyOn(window, 'addEventListener');
await import('./index');
const api: SprintCoderApi = bridge.expose.mock.calls[0]![1];
const request = { sessionId: 'session-1', intentId: 'handoff-1', decision: 'continue' as const };

function gesture(type: 'pointerdown' | 'keydown', key?: string) {
  const button = document.createElement('button');
  button.dataset['computerUseActivation'] = 'foreground-handoff';
  button.dataset['computerUseIntent'] = foregroundHandoffActivationIntent(request);
  const callback = listeners.mock.calls.find(([name]) => name === type)?.[1];
  if (typeof callback !== 'function') throw new Error('Missing preload listener');
  // Invoke the capture listener as a unit seam; no real OS input is sent.
  callback({ isTrusted: true, target: button, key } as unknown as Event);
}
afterEach(() => {
  bridge.invoke.mockReset();
  bridge.send.mockClear();
});

describe('P6 preload handoff bridge', () => {
  it('does not invoke IPC on load or a synthetic click', async () => {
    expect(bridge.invoke).not.toHaveBeenCalled();
    window.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    await expect(api.computerUse!.resolveForegroundHandoff!(request)).rejects.toThrow(
      'trusted click',
    );
    expect(bridge.invoke).not.toHaveBeenCalled();
  });
  it.each(['pointerdown', 'Enter', ' '] as const)(
    'forwards %j once through strict IPC',
    async (input) => {
      gesture(input === 'pointerdown' ? input : 'keydown', input);
      bridge.invoke.mockRejectedValue(new Error('fixture transport error'));
      await expect(api.computerUse!.resolveForegroundHandoff!(request)).rejects.toThrow(
        'fixture transport error',
      );
      expect(bridge.send).toHaveBeenCalledWith(IPC_CHANNELS.computerUseActivationIntent, {
        kind: 'foreground-handoff',
        intent: foregroundHandoffActivationIntent(request),
      });
      expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith(
        IPC_CHANNELS.computerUseForegroundHandoffResolve,
        expect.objectContaining({ payload: request }),
      );
      await expect(api.computerUse!.resolveForegroundHandoff!(request)).rejects.toThrow(
        'trusted click',
      );
      expect(bridge.invoke).toHaveBeenCalledTimes(1);
    },
  );
  it('rejects extra identity fields before IPC even with an activation', async () => {
    gesture('pointerdown');
    await expect(
      api.computerUse!.resolveForegroundHandoff!({ ...request, ...{ pid: 42 } }),
    ).rejects.toThrow();
    expect(bridge.invoke).not.toHaveBeenCalled();
  });
});

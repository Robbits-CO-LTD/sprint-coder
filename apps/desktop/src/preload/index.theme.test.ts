// @vitest-environment jsdom
import type { SprintCoderApi } from '@sprint-coder/contracts';
import { beforeEach, expect, it, vi } from 'vitest';
import { WINDOW_THEME_CHANNELS } from '../window-theme';

const bridge = vi.hoisted(() => ({
  expose: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
  sendSync: vi.fn(() => 'gray'),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: bridge.expose },
  ipcRenderer: bridge,
}));
await import('./index');
const api: SprintCoderApi = bridge.expose.mock.calls[0]![1];

beforeEach(() => bridge.invoke.mockReset());

it('still reads the initial theme synchronously', () => {
  expect(bridge.sendSync).toHaveBeenCalledWith(WINDOW_THEME_CHANNELS.get);
  expect(document.documentElement.getAttribute('data-theme')).toBe('gray');
});

it.each([true, false])('returns the save outcome saved=%s through invoke', async (saved) => {
  bridge.invoke.mockResolvedValueOnce({ saved });
  await expect(api.theme.set('white')).resolves.toEqual({ saved });
  expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith(WINDOW_THEME_CHANNELS.set, 'white');
  expect(bridge.send).not.toHaveBeenCalledWith(WINDOW_THEME_CHANNELS.set, 'white');
});

it('rejects unknown themes without sending them to Main', async () => {
  await expect(api.theme.set('unknown')).resolves.toEqual({ saved: false });
  expect(bridge.invoke).not.toHaveBeenCalled();
});

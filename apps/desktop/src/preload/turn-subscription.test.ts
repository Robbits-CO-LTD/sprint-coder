import type { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type SprintCoderApi } from '@sprint-coder/contracts';

const bridge = vi.hoisted(() => ({ exposeInMainWorld: vi.fn(), invoke: vi.fn() }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    contextBridge: bridge,
    ipcRenderer: Object.assign(new EventEmitter(), { invoke: bridge.invoke }),
  };
});

afterEach(() => vi.unstubAllGlobals());

it('closes a Turn port that arrives after unsubscribe', async () => {
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  let requestId = '';
  bridge.invoke.mockImplementation((_channel: string, input: { requestId: string }) => {
    requestId = input.requestId;
    return new Promise(() => {});
  });
  await import('./index');
  const api = bridge.exposeInMainWorld.mock.calls[0]![1] as SprintCoderApi;
  const unsubscribe = api.turns.subscribe('task-1', vi.fn());
  unsubscribe();
  const port = { close: vi.fn(), postMessage: vi.fn(), start: vi.fn() };
  const { ipcRenderer } = await import('electron');
  (ipcRenderer as unknown as EventEmitter).emit(
    IPC_CHANNELS.turnsPort,
    { ports: [port] },
    { requestId, taskId: 'task-1' },
  );
  expect(port.close).toHaveBeenCalledTimes(1);
  expect(port.start).not.toHaveBeenCalled();
  expect((ipcRenderer as unknown as EventEmitter).listenerCount(IPC_CHANNELS.turnsPort)).toBe(0);
});

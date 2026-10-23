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

it('keeps message indentation through Preload validation and IPC envelopes', async () => {
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  bridge.invoke.mockImplementation((channel: string, envelope: { requestId: string }) => ({
    ok: true,
    requestId: envelope.requestId,
    value:
      channel === IPC_CHANNELS.turnsStart
        ? { turnId: 'turn-1' }
        : channel === IPC_CHANNELS.turnsQueue
          ? { ordinal: 1 }
          : undefined,
  }));
  await import('./index');
  const api = bridge.exposeInMainWorld.mock.calls[0]![1] as SprintCoderApi;
  const input = {
    taskId: 'task-1',
    text: '    担当を雇ってください。\n\nこの例文を添削してください。\n',
  };
  await api.turns.start({
    ...input,
    skills: [],
    attachmentIds: [],
    attachmentSelectionIdentity: null,
  });
  await api.turns.queue({ ...input, skills: [] });
  await api.turns.steer({ ...input, expectedTurnId: 'turn-1' });
  await api.turns.stopAndSend({ ...input, skills: [] });
  expect(bridge.invoke).toHaveBeenCalledTimes(4);
  for (const [, envelope] of bridge.invoke.mock.calls) {
    expect(envelope).toMatchObject({ taskId: input.taskId, payload: input });
  }
});

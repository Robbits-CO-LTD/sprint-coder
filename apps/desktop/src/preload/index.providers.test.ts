// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type SprintCoderApi } from '@sprint-coder/contracts';
import { LOCAL_PROVIDER_PROFILES } from '../main/bundled-provider-profiles';

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
});

describe('external local Provider bridge after Managed Local retirement', () => {
  it('does not expose an installation or runtime API', () => {
    expect(api).not.toHaveProperty('localAI');
  });

  it('still lists LocalAI, Ollama, and LM Studio profiles over the Provider IPC', async () => {
    bridge.invoke.mockImplementation(async (_channel: string, envelope: { requestId: string }) => ({
      ok: true,
      requestId: envelope.requestId,
      value: LOCAL_PROVIDER_PROFILES,
    }));
    const profiles = await api.providers.listProfiles();
    expect(profiles.map(({ id }) => id).sort()).toEqual(['lm-studio', 'localai', 'ollama']);
    expect(profiles.every(({ computeLocation }) => computeLocation === 'local')).toBe(true);
    expect(bridge.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.providersListProfiles,
      expect.objectContaining({
        payload: {},
        requestId: expect.any(String),
        operationId: expect.any(String),
      }),
    );
    expect(typeof api.providers.createProfileConnection).toBe('function');
  });
});

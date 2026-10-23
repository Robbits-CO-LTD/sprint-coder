import { describe, expect, it, vi } from 'vitest';
import {
  IPC_CHANNELS,
  type ModelSelection,
  type ProviderConnection,
} from '@sprint-coder/contracts';
import { IpcRouter, toPublicError } from './ipc';
import { MainProviderRegistry, DeterministicMockProviderRuntime } from './provider-runtime';
import { ProviderAwareTeamWorkerRuntime } from './provider-team-worker-runtime';
import { RetiredManagedLocalError } from './retired-managed-local';
import { ModelCatalogService } from './model-catalog-service';
import { MainProviderProfileRegistry } from './provider-profile';
import { LOCAL_PROVIDER_PROFILES } from './bundled-provider-profiles';
import type { AgentRecord, StartedTurn } from './persistence';
import type { ProviderVerificationService } from './provider-verification';
import { localProviderTestConnection } from './provider-connection-test-fixture';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  clipboard: {},
  dialog: {},
  ipcMain: { on: vi.fn() },
  MessageChannelMain: class {},
  BrowserWindow: class {},
  nativeImage: {},
  shell: {},
  utilityProcess: {},
  session: {},
  safeStorage: {},
  screen: {},
  globalShortcut: {},
}));

const retiredSelection: ModelSelection = {
  connectionId: 'managed-local:runtime',
  requestedProvider: 'sprint-managed-local',
  requestedModel: 'a'.repeat(64),
};
const retiredConnection: ProviderConnection = {
  ...localProviderTestConnection(),
  id: retiredSelection.connectionId!,
  providerId: retiredSelection.requestedProvider!,
  displayName: 'Managed Local',
};
type Handler = (input: Record<string, unknown>) => Promise<unknown>;
type RouterProbe = {
  register(): void;
  refreshModelCatalog(): Promise<void>;
  startSelectedRuntime(started: StartedTurn): Promise<void>;
  ensureProviderEndpointConsent(connection: ProviderConnection): Promise<ProviderConnection>;
};

function makeRouter() {
  const router = Object.create(IpcRouter.prototype) as RouterProbe;
  const handlers = new Map<string, Handler>();
  const register = (channel: string, _input: unknown, _output: unknown, handler: Handler) =>
    handlers.set(channel, handler);
  Object.assign(router, {
    handle: register,
    handleMutation: register,
    window: { webContents: { once: vi.fn() } },
  });
  return { router, handlers };
}

function started(selection = retiredSelection): StartedTurn {
  return {
    turnId: 'retired-turn',
    text: 'Continue the saved task',
    runtimeKind: 'codex',
    model: 'auto',
    modelSelection: selection,
    skills: [],
    autoSkills: [],
    teamTurn: false,
    sealId: 'seal-retired',
    contextUsageEvents: [],
    workspaceSet: {
      roots: [],
      primaryRootId: null,
      digest: 'workspace-retired',
      source: 'none',
      projectId: null,
    },
    event: {
      type: 'stage.changed',
      taskId: 'retired-task',
      turnId: 'retired-turn',
      seq: 1,
      stage: 'understanding',
    },
  };
}

function worker(selection: ModelSelection, writeCapable: boolean): AgentRecord {
  return {
    id: 'retired-worker',
    teamId: 'team',
    threadId: 'thread',
    taskId: 'retired-task',
    kind: 'worker',
    role: 'Researcher',
    state: 'ready',
    objective: 'Continue',
    parentCapabilityCeiling: null,
    contextInheritancePolicy: 'none',
    writeCapable,
    currentActivity: null,
    runtimeKind: 'codex',
    modelSelection: selection,
    parentAgentId: 'leader',
    depth: 1,
    canDelegate: false,
    managerPolicy: null,
    blueprintRoleKey: null,
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
  };
}

describe('retired Managed Local execution boundary', () => {
  it.each([
    ['managed-local:runtime', 'localai'],
    ['localai:test', 'sprint-managed-local'],
    ['managed-local:runtime', 'sprint-managed-local'],
  ])('rejects reserved identity %s/%s before any registry fallback', (id, providerId) => {
    const registry = new MainProviderRegistry();
    const runtime = new DeterministicMockProviderRuntime();
    registry.register({ runtimeKind: 'openai_compatible', providerId: null, runtime });
    registry.register({
      runtimeKind: 'openai_compatible',
      providerId: 'sprint-managed-local',
      runtime,
    });
    expect(() => registry.resolve({ ...retiredConnection, id, providerId })).toThrow(
      RetiredManagedLocalError,
    );
    for (const provider of ['localai', 'ollama', 'lm-studio'])
      expect(
        registry.resolve({
          ...retiredConnection,
          id: `${provider}:external`,
          providerId: provider,
        }),
      ).toBe(runtime);
  });

  it('rejects a new turn before accepting it and asks the user to select a provider', async () => {
    const { router, handlers } = makeRouter();
    const reconcile = vi.fn();
    Object.assign(router, {
      persistence: { getTaskModelSelection: () => retiredSelection },
      reconcileTaskBuiltinModel: reconcile,
    });
    router.register();
    const error = await handlers.get(IPC_CHANNELS.turnsStart)!({ taskId: 'retired-task' }).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(RetiredManagedLocalError);
    expect(toPublicError(error)).toEqual({
      code: 'RUNTIME_UNAVAILABLE',
      userMessage: new RetiredManagedLocalError().message,
      retryable: false,
    });
    expect(reconcile).not.toHaveBeenCalled();
    expect(
      [...handlers.keys()].some((channel) => channel.startsWith('sprint-coder:local-ai:')),
    ).toBe(false);
  });

  it.each([retiredSelection, { ...retiredSelection, connectionId: null }])(
    'fails an accepted legacy turn before provider/CLI route selection',
    async (selection) => {
      const { router } = makeRouter();
      const dispatchProvider = vi.fn();
      const dispatchCli = vi.fn();
      const finish = vi.fn();
      const appendDelta = vi.fn(() => ({ type: 'message.delta' }));
      Object.assign(router, {
        canceledRuntimeTurns: new Set(),
        turnRuntimes: new Map(),
        persistence: { getActiveTurnId: () => 'retired-turn', appendDelta },
        mailbox: { run: async (_taskId: string, action: () => void) => action() },
        publish: vi.fn(),
        finishAndAdvance: finish,
        startProviderTurn: dispatchProvider,
        runtimeFor: dispatchCli,
      });
      await router.startSelectedRuntime(started(selection));
      expect(dispatchProvider).not.toHaveBeenCalled();
      expect(dispatchCli).not.toHaveBeenCalled();
      expect(appendDelta).toHaveBeenCalledWith(
        'retired-task',
        'retired-turn',
        expect.any(String),
        new RetiredManagedLocalError().message,
      );
      expect(finish).toHaveBeenCalledExactlyOnceWith('retired-task', 'retired-turn', 'failed');
      expect(selection.requestedProvider).toBe('sprint-managed-local');
    },
  );

  it('rechecks cancellation before terminalizing a queued retirement rejection', async () => {
    const { router } = makeRouter();
    const appendDelta = vi.fn();
    const finish = vi.fn();
    let active: string | null = 'retired-turn';
    Object.assign(router, {
      canceledRuntimeTurns: new Set(),
      turnRuntimes: new Map(),
      persistence: { getActiveTurnId: () => active, appendDelta },
      mailbox: {
        run: async (_taskId: string, action: () => void) => {
          active = null;
          action();
        },
      },
      finishAndAdvance: finish,
    });
    await router.startSelectedRuntime(started());
    expect(appendDelta).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'refuses a saved Team worker before CLI fallback, write=%s',
    async (writeCapable) => {
      const fallback = { start: vi.fn(), execute: vi.fn(), stop: vi.fn() };
      const verify = vi.fn();
      const resolve = vi.fn();
      const adapter = new ProviderAwareTeamWorkerRuntime({
        fallback,
        verification: {
          requireVerifiedForExecution: verify,
        } as unknown as ProviderVerificationService,
        registry: { register: vi.fn(), resolve },
        getConnection: vi.fn(),
        authorizeEgress: vi.fn(),
        managerGuidance: '',
        managerTools: [],
        workerGuidance: '',
        workerTools: [],
        executeManagerTool: vi.fn(),
      });
      for (const selection of [retiredSelection, { ...retiredSelection, connectionId: null }]) {
        const saved = worker(selection, writeCapable);
        await expect(adapter.start(saved)).rejects.toThrow(RetiredManagedLocalError);
        await expect(
          adapter.execute({
            worker: saved,
            content: 'Continue',
            envelope: {
              deliveryId: 'delivery',
              sourceAgentId: 'leader',
              targetAgentId: saved.id,
              teamId: 'team',
              messageId: 'message',
              sourceKind: 'leader',
              targetKind: 'worker',
              seq: 1,
              attempt: 1,
              issuedAt: '2026-10-23T00:00:00.000Z',
            },
          }),
        ).rejects.toThrow(RetiredManagedLocalError);
      }
      expect(fallback.start).not.toHaveBeenCalled();
      expect(fallback.execute).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it('rejects old connection consent before accessing secrets or prompting for another endpoint', async () => {
    const { router } = makeRouter();
    const challenge = vi.fn();
    const secret = vi.fn();
    Object.assign(router, {
      providerEndpointChallenges: { prepare: challenge },
      providerSecrets: { get: secret },
    });
    await expect(router.ensureProviderEndpointConsent(retiredConnection)).rejects.toThrow(
      RetiredManagedLocalError,
    );
    expect(challenge).not.toHaveBeenCalled();
    expect(secret).not.toHaveBeenCalled();
  });

  it('keeps the saved selection when its catalog row disappears while external local providers remain', async () => {
    const { router, handlers } = makeRouter();
    const profiles = new MainProviderProfileRegistry();
    for (const profile of LOCAL_PROVIDER_PROFILES) profiles.register(profile);
    const externalConnections = LOCAL_PROVIDER_PROFILES.map(({ id }) => ({
      ...localProviderTestConnection(),
      id: `${id}:external`,
      providerId: id,
      secretReference: 'provider-secret:00000000-0000-4000-8000-000000000001',
    }));
    const catalog = new ModelCatalogService();
    const verify = vi.fn(async (id: string) =>
      externalConnections.find((connection) => connection.id === id)!,
    );
    const listModels = vi.fn(async (connection: ProviderConnection) =>
      new DeterministicMockProviderRuntime().listModels(connection, new AbortController().signal),
    );
    const consent = vi.fn(async (connection: ProviderConnection) => connection);
    const saved = { ...retiredSelection };
    const capability = {
      probe: async () => ({
        available: true,
        readiness: 'ready',
        models: [{ id: 'auto', displayName: 'Auto' }],
      }),
    };
    Object.assign(router, {
      codexRuntime: capability,
      claudeRuntime: capability,
      grokRuntime: capability,
      reconcileBuiltinCapability: vi.fn(),
      teamRuntimeAvailability: { isAvailable: () => true },
      providerConnections: { list: () => [retiredConnection, ...externalConnections] },
      providerProfiles: profiles,
      providerVerification: { requireVerifiedForExecution: verify },
      providerRegistry: { resolve: () => ({ listModels }) },
      ensureProviderEndpointConsent: consent,
      modelCatalog: catalog,
      persistence: {
        getTaskModelSelection: () => saved,
        getRuntime: () => 'codex',
        getModel: () => 'auto',
      },
    });
    router.register();
    const query = {
      taskId: 'retired-task',
      text: '',
      connectionIds: [],
      providerIds: [],
      accessTypes: ['local'],
      capabilities: [],
      availableOnly: true,
      cursor: null,
      limit: 100,
    };
    const result = (await handlers.get(IPC_CHANNELS.modelsCatalogQuery)!(query)) as {
      selection: ModelSelection;
      items: { providerId: string }[];
    };
    expect(result.selection).toEqual(retiredSelection);
    expect(saved).toEqual(retiredSelection);
    expect(result.items.map(({ providerId }) => providerId).sort()).toEqual([
      'lm-studio',
      'localai',
      'ollama',
    ]);
    expect(verify.mock.calls.map(([id]) => id)).not.toContain(retiredConnection.id);
    expect(consent).toHaveBeenCalledTimes(3);
    const listed = (await handlers.get(IPC_CHANNELS.providersListConnections)!(
      {},
    )) as ProviderConnection[];
    expect(listed.map(({ id }) => id)).toEqual(externalConnections.map(({ id }) => id));
  });
});

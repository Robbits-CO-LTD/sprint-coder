import { describe, expect, it, vi } from 'vitest';
import {
  IPC_CHANNELS,
  type ModelCatalogQueryInput,
  type ModelCatalogQueryResult,
  type ProviderConnection,
  type ProviderModel,
} from '@sprint-coder/contracts';
import { IpcRouter } from './ipc';
import { ModelCatalogService } from './model-catalog-service';
import { MainProviderProfileRegistry } from './provider-profile';
import { LOCAL_PROVIDER_PROFILES } from './bundled-provider-profiles';
import { localProviderTestConnection } from './provider-connection-test-fixture';
import { queryAllModelCatalogPages } from '../renderer/lib/model-catalog-pages';

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

type Handler = (input: Record<string, unknown>) => Promise<unknown>;

const SECRET = 'provider-secret:00000000-0000-4000-8000-000000000001';
const stable: ProviderConnection = {
  ...localProviderTestConnection(),
  id: 'localai:stable',
  providerId: 'localai',
  secretReference: SECRET,
};
// Unrelated to the listing: it answers on one refresh and fails on the next.
const flaky: ProviderConnection = {
  ...localProviderTestConnection(),
  id: 'ollama:flaky',
  providerId: 'ollama',
  displayName: 'Flaky',
  secretReference: SECRET,
};

function models(connection: ProviderConnection, count: number): ProviderModel[] {
  const unknown = { value: null, source: 'unknown' as const };
  return Array.from({ length: count }, (_, index) => ({
    connectionId: connection.id,
    providerId: connection.providerId,
    modelId: `model-${String(index).padStart(3, '0')}`,
    displayName: `Model ${index}`,
    available: true,
    availabilityCheckedAt: '2026-10-24T00:00:00.000Z',
    contextWindow: unknown,
    maxOutputTokens: unknown,
    toolCalling: unknown,
    structuredOutput: unknown,
    multimodalInput: unknown,
    reasoning: unknown,
  }));
}

function makeRouter() {
  const router = Object.create(IpcRouter.prototype) as { register(): void };
  const handlers = new Map<string, Handler>();
  const register = (channel: string, _input: unknown, _output: unknown, handler: Handler) =>
    handlers.set(channel, handler);
  const profiles = new MainProviderProfileRegistry();
  for (const profile of LOCAL_PROVIDER_PROFILES) profiles.register(profile);
  const probe = vi.fn(async () => ({ available: false, readiness: 'missing', models: [] }));
  let flakyCalls = 0;
  const listModels = vi.fn(async (connection: ProviderConnection) => {
    if (connection.id === stable.id) return models(stable, 250);
    flakyCalls += 1;
    if (flakyCalls % 2 === 0) throw new Error('flaky provider is down');
    return models(flaky, 3);
  });
  const catalog = new ModelCatalogService();
  Object.assign(router, {
    handle: register,
    handleMutation: register,
    window: { webContents: { once: vi.fn() } },
    codexRuntime: { probe },
    claudeRuntime: { probe },
    grokRuntime: { probe },
    reconcileBuiltinCapability: vi.fn(),
    teamRuntimeAvailability: { isAvailable: () => true },
    providerConnections: { list: () => [stable, flaky] },
    providerProfiles: profiles,
    providerVerification: {
      requireVerifiedForExecution: async (id: string) => (id === stable.id ? stable : flaky),
    },
    providerRegistry: { resolve: () => ({ listModels }) },
    ensureProviderEndpointConsent: async (connection: ProviderConnection) => connection,
    modelCatalog: catalog,
    persistence: {
      getTaskModelSelection: () => null,
      getRuntime: () => 'codex',
      getModel: () => 'auto',
    },
  });
  router.register();
  const query = async (input: ModelCatalogQueryInput) =>
    (await handlers.get(IPC_CHANNELS.modelsCatalogQuery)!(input)) as ModelCatalogQueryResult;
  return { query, probe, listModels };
}

const listing = {
  taskId: 'task-1',
  text: '',
  connectionIds: [stable.id],
  providerIds: [],
  accessTypes: [],
  capabilities: [],
  availableOnly: true,
} satisfies Omit<ModelCatalogQueryInput, 'cursor' | 'limit'>;

describe('#906: models catalog query rebuilds the catalog only for a first page', () => {
  it('answers a continuation page from the catalog the first page built, without re-probing', async () => {
    const { query, probe, listModels } = makeRouter();

    const first = await query({ ...listing, cursor: null, limit: 100 });
    expect(probe).toHaveBeenCalledTimes(3);
    expect(listModels).toHaveBeenCalledTimes(2);

    const second = await query({ ...listing, cursor: first.nextCursor, limit: 100 });
    expect(second.revision).toBe(first.revision);
    expect(second.items[0]?.modelId).toBe('model-100');
    expect(probe).toHaveBeenCalledTimes(3);
    expect(listModels).toHaveBeenCalledTimes(2);

    // A new first page (reopening, a new search) still sees the current Providers.
    await query({ ...listing, cursor: null, limit: 100 });
    expect(probe).toHaveBeenCalledTimes(6);
    expect(listModels).toHaveBeenCalledTimes(4);
  });

  it('builds the catalog once when a cursor arrives before any catalog exists', async () => {
    const { query, listModels } = makeRouter();

    const page = await query({ ...listing, cursor: 'cursor:100', limit: 100 });

    expect(listModels).toHaveBeenCalledTimes(2);
    expect(page.items[0]?.modelId).toBe('model-100');
  });

  it('completes a full listing while an unrelated Provider flickers between refreshes', async () => {
    const { query, listModels } = makeRouter();
    // The flaky Provider has answered once already, so the next refresh drops its rows.
    await query({ ...listing, cursor: null, limit: 1 });

    const all = await queryAllModelCatalogPages(query, listing);

    expect(all.map(({ modelId }) => modelId)).toEqual(
      models(stable, 250).map(({ modelId }) => modelId),
    );
    // One refresh for the listing's first page, none for pages 2 and 3.
    expect(
      listModels.mock.calls.filter(([connection]) => connection.id === stable.id),
    ).toHaveLength(2);
  });
});

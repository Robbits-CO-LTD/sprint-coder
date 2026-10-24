import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IPC_CHANNELS,
  type ModelCatalogQueryInput,
  type ModelCatalogQueryResult,
  type ProviderConnection,
  type ProviderModel,
  type TeamModelRestriction,
} from '@sprint-coder/contracts';
import { IpcRouter } from './ipc';
import { ModelCatalogService } from './model-catalog-service';
import { MainProviderProfileRegistry } from './provider-profile';
import { LOCAL_PROVIDER_PROFILES } from './bundled-provider-profiles';
import { localProviderTestConnection } from './provider-connection-test-fixture';
import { queryAllModelCatalogPages } from '../renderer/lib/model-catalog-pages';
import { executeTeamTool, type ExecuteTeamToolOptions } from './team-tools';
import { TeamCoordinator } from './team-coordinator';

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

function makeRouter({
  stableConnection = stable,
  flakyConnection = flaky,
  stableCount = 250,
  flakyCount = 3,
  flakyInitiallyAvailable = true,
} = {}) {
  const router = Object.create(IpcRouter.prototype) as {
    register(): void;
    listTeamModelCandidates: NonNullable<ExecuteTeamToolOptions['listModelCandidates']>;
  };
  const handlers = new Map<string, Handler>();
  const register = (channel: string, _input: unknown, _output: unknown, handler: Handler) =>
    handlers.set(channel, handler);
  const profiles = new MainProviderProfileRegistry();
  for (const profile of LOCAL_PROVIDER_PROFILES) profiles.register(profile);
  const probe = vi.fn(async () => ({ available: false, readiness: 'missing', models: [] }));
  let flakyCalls = 0;
  const listModels = vi.fn(async (connection: ProviderConnection) => {
    if (connection.id === stableConnection.id) return models(stableConnection, stableCount);
    flakyCalls += 1;
    if ((flakyCalls % 2 === 1) !== flakyInitiallyAvailable)
      throw new Error('flaky provider is down');
    return models(flakyConnection, flakyCount);
  });
  const catalog = new ModelCatalogService();
  const getTeamModelRestriction = vi.fn((): TeamModelRestriction => ({
    mode: 'all',
    allowedModels: [],
  }));
  Object.assign(router, {
    handle: register,
    handleMutation: register,
    window: { webContents: { once: vi.fn() } },
    codexRuntime: { probe },
    claudeRuntime: { probe },
    grokRuntime: { probe },
    reconcileBuiltinCapability: vi.fn(),
    teamRuntimeAvailability: { isAvailable: () => true },
    providerConnections: { list: () => [stableConnection, flakyConnection] },
    providerProfiles: profiles,
    providerVerification: {
      requireVerifiedForExecution: async (id: string) =>
        id === stableConnection.id ? stableConnection : flakyConnection,
    },
    providerRegistry: { resolve: () => ({ listModels }) },
    ensureProviderEndpointConsent: async (connection: ProviderConnection) => connection,
    modelCatalog: catalog,
    teamModelListingRevisions: new Map<string, number>(),
    persistence: {
      getTaskModelSelection: () => null,
      getRuntime: () => 'codex',
      getModel: () => 'auto',
      getTeamModelRestriction,
    },
  });
  router.register();
  const query = async (input: ModelCatalogQueryInput) =>
    (await handlers.get(IPC_CHANNELS.modelsCatalogQuery)!(input)) as ModelCatalogQueryResult;
  // Listing does not use the coordinator; the real tool still validates and routes the call.
  const coordinator = Object.create(TeamCoordinator.prototype) as TeamCoordinator;
  const markQueried = vi.fn();
  const teamQuery = async (args: { cursor?: string | null; limit?: number }) =>
    (await executeTeamTool(coordinator, 'task-1', 'team_list_models', args, {
      listModelCandidates: (input) => router.listTeamModelCandidates(input),
      modelCatalogAudit: { wasQueried: () => markQueried.mock.calls.length > 0, markQueried },
    })) as ModelCatalogQueryResult;
  return { query, teamQuery, probe, listModels, getTeamModelRestriction, markQueried };
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

describe('#939: Team model listing keeps continuation pages in the existing catalog', () => {
  const teamFlaky: ProviderConnection = { ...flaky, id: 'localai:flaky', providerId: 'localai' };
  const teamStable: ProviderConnection = { ...stable, id: 'ollama:stable', providerId: 'ollama' };
  const options = {
    stableConnection: teamStable,
    flakyConnection: teamFlaky,
    stableCount: 150,
    flakyCount: 100,
  };
  const identity = ({ connectionId, providerId, modelId }: ProviderModel) => ({
    connectionId,
    providerId,
    modelId,
  });

  beforeEach(() => vi.stubEnv('SPRINT_CODER_TEAM_CODEX_ONLY', '0'));
  afterEach(() => vi.unstubAllEnvs());

  it.each([true, false])(
    'returns every initial candidate exactly once when the flaky Provider initially answers=%s',
    async (flakyInitiallyAvailable) => {
      const { teamQuery, probe, listModels } = makeRouter({ ...options, flakyInitiallyAvailable });
      const first = await teamQuery({ limit: 100 });
      expect(Object.keys(first).sort()).toEqual(['items', 'nextCursor', 'revision', 'total']);
      const items = [...first.items];
      let cursor = first.nextCursor;
      for (let pages = 1; cursor !== null && pages < 5; pages += 1) {
        const page = await teamQuery({ cursor, limit: 100 });
        items.push(...page.items);
        cursor = page.nextCursor;
      }

      expect(cursor).toBeNull();
      expect(items.map(identity)).toEqual(
        [
          ...(flakyInitiallyAvailable ? models(teamFlaky, 100) : []),
          ...models(teamStable, 150),
        ].map(identity),
      );
      expect(probe).toHaveBeenCalledTimes(3);
      expect(listModels).toHaveBeenCalledTimes(2);
    },
  );

  it('does not probe on a continuation, but refreshes when a new listing starts', async () => {
    const { teamQuery, probe, listModels } = makeRouter(options);
    const first = await teamQuery({ limit: 100 });
    const second = await teamQuery({ cursor: first.nextCursor, limit: 100 });

    expect(second.revision).toBe(first.revision);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(listModels).toHaveBeenCalledTimes(2);

    const refreshed = await teamQuery({ cursor: null, limit: 100 });
    expect(refreshed.total).toBe(150);
    expect(refreshed.revision).toBeGreaterThan(first.revision);
    expect(probe).toHaveBeenCalledTimes(6);
    expect(listModels).toHaveBeenCalledTimes(4);
  });

  it('builds the catalog if a cursor arrives before any listing', async () => {
    const { teamQuery, probe, listModels } = makeRouter(options);
    const page = await teamQuery({ cursor: 'cursor:100', limit: 100 });

    expect(page.items.map(identity)).toEqual(models(teamStable, 100).map(identity));
    expect(probe).toHaveBeenCalledTimes(3);
    expect(listModels).toHaveBeenCalledTimes(2);
  });

  it('applies current Team restrictions even on a continuation', async () => {
    const { teamQuery, getTeamModelRestriction, listModels } = makeRouter(options);
    const first = await teamQuery({ limit: 1 });
    getTeamModelRestriction.mockReturnValue({
      mode: 'selected',
      allowedModels: models(teamStable, 3).map(identity),
    });

    const page = await teamQuery({ cursor: first.nextCursor, limit: 100 });

    expect(page.total).toBe(3);
    expect(page.items.map(identity)).toEqual(models(teamStable, 3).slice(1).map(identity));
    expect(listModels).toHaveBeenCalledTimes(2);
  });
  it('rejects a page from a changed catalog without recording a successful query, then restarts', async () => {
    const { teamQuery, query, markQueried } = makeRouter(options);
    const first = await teamQuery({ limit: 100 });
    expect(first.total).toBe(250);
    expect(markQueried).toHaveBeenCalledTimes(1);
    const picker = await query({ ...listing, connectionIds: [], cursor: null, limit: 100 });
    expect(picker.revision).not.toBe(first.revision);

    // A later Turn's audit starts empty even though the Task has an older listing.
    markQueried.mockClear();
    const stale = await teamQuery({ cursor: first.nextCursor, limit: 100 });
    expect(stale).toMatchObject({ ok: false, message: expect.stringContaining('cursor null') });
    expect(markQueried).not.toHaveBeenCalled();

    const restarted = await teamQuery({ cursor: null, limit: 100 });
    const second = await teamQuery({ cursor: restarted.nextCursor, limit: 100 });
    const third = await teamQuery({ cursor: second.nextCursor, limit: 100 });
    expect(third.nextCursor).toBeNull();
    expect([...restarted.items, ...second.items, ...third.items].map(identity)).toEqual(
      [...models(teamFlaky, 100), ...models(teamStable, 150)].map(identity),
    );
    expect(markQueried).toHaveBeenCalledTimes(3);
  });
});

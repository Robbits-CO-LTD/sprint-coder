import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type RuntimeKind } from '@sprint-coder/contracts';
import type { ToolCatalogSnapshot } from '@sprint-coder/domain';
import {
  IpcRouter,
  invalidModelUserMessage,
  listAvailableTeamRuntimeModels,
  toPublicError,
} from './ipc';
import { createEmptyToolCatalogSnapshot, MANAGED_EXEC_COMMAND_TOOL } from './default-tools';
import { ModelCatalogService } from './model-catalog-service';
import type { StartedTurn } from './persistence';
import type { RuntimeHostClient } from './runtime-host';
import type { RuntimeCanonicalEvent } from '../runtime-host/protocol';
import { authorizeGrokProviderEgress, dispatchAfterGrokProviderEgress } from './provider-egress';
import type * as ProviderEgressModule from './provider-egress';

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
vi.mock('./provider-egress', async (importOriginal) => ({
  ...(await importOriginal<typeof ProviderEgressModule>()),
  authorizeGrokProviderEgress: vi.fn(() => ({ allowed: true })),
  dispatchAfterGrokProviderEgress: vi.fn((_input: unknown, dispatch: () => void) => {
    dispatch();
    return { allowed: true };
  }),
}));

type CliKind = Exclude<RuntimeKind, 'mock'>;
type TitleRequest = Pick<StartedTurn, 'text' | 'runtimeKind' | 'model' | 'modelSelection'> & {
  taskId: string;
};
type Handler = (input: Record<string, unknown>, event?: unknown, envelope?: unknown) => unknown;
type RouterProbe = {
  register(): void;
  adoptInstalledRuntime(): Promise<void>;
  refreshModelCatalog(): Promise<void>;
  runtimeFor(kind: CliKind): RuntimeHostClient;
  startSelectedRuntime(started: StartedTurn): Promise<void>;
  generateCliTaskTitle(request: TitleRequest, kind: CliKind, model: string): Promise<string | null>;
  routeCliTaskTitleEvent(
    kind: CliKind,
    taskId: string,
    turnId: string,
    event: RuntimeCanonicalEvent,
  ): void;
};

function createHarness() {
  const router = Object.create(IpcRouter.prototype) as RouterProbe;
  const handlers = new Map<string, Handler>();
  const register = (channel: string, _input: unknown, _output: unknown, handler: Handler) =>
    handlers.set(channel, handler);
  const host = (model: string) => ({
    probe: vi.fn(async () => ({
      available: true,
      readiness: 'ready',
      models: [
        { id: 'auto', displayName: 'Auto' },
        { id: model, displayName: model },
      ],
    })),
    start: vi.fn<RuntimeHostClient['start']>(),
    cancel: vi.fn(async () => undefined),
  });
  const codex = host('gpt-test');
  const claude = host('claude-test');
  const grok = host('grok-test');
  const persistence = {
    getStoredRuntime: vi.fn((): RuntimeKind | null => null),
    getRuntime: vi.fn((): RuntimeKind => 'grok'),
    setRuntime: vi.fn(),
    getModel: () => 'grok-test',
    setModel: vi.fn(),
    getTaskModelSelection: () => null,
    getEffort: vi.fn(() => 'high'),
    getCodexEffort: vi.fn(() => 'ultra'),
    setCodexEffort: vi.fn(),
    takeModelFallbackNotice: () => null,
    reconcileBuiltinModelCatalog: vi.fn(),
    getActiveTurnId: () => 'turn-grok',
    getTask: () => ({ id: 'task-grok', projectId: null }),
    getPermissionPolicy: () => ({ preset: 'ask', policyEpoch: 1 }),
  };
  const catalog: ToolCatalogSnapshot = {
    ...createEmptyToolCatalogSnapshot('grok', null),
    entries: [MANAGED_EXEC_COMMAND_TOOL],
  };
  const registerManagedMcp = vi.fn(() => ({
    endpoint: 'http://127.0.0.1:1234',
    token: 'test-token',
    guidance: 'Managed tools',
    managedTools: [],
    toolCatalogDigest: catalog.digest,
  }));
  const handleRuntimeFailure = vi.fn();
  const diagnosticContexts = new Map();
  Object.assign(router, {
    handle: register,
    handleMutation: register,
    window: { webContents: { once: vi.fn() } },
    runMutation: (
      _event: unknown,
      _envelope: unknown,
      _taskId: string,
      _channel: string,
      action: () => unknown,
    ) => ({ value: action() }),
    persistence,
    codexRuntime: codex,
    claudeRuntime: claude,
    grokRuntime: grok,
    providerConnections: { list: () => [] },
    managedLocalProviderRuntime: null,
    teamRuntimeAvailability: { isAvailable: () => true },
    modelCatalog: new ModelCatalogService(),
    canceledRuntimeTurns: new Set(),
    quarantinedRuntimeTasks: new Set(),
    quarantinedRuntimeKinds: new Set(),
    turnRuntimes: new Map(),
    turnWorkspaceByTurn: new Map(),
    runtimeDiagnosticContextByTurn: diagnosticContexts,
    assertTurnWorkspaceHealthy: vi.fn(async () => undefined),
    pushRuntimeStatus: vi.fn(),
    prepareContext: () => ({
      fragments: [],
      projectItems: [],
      projectSnapshotDigest: null,
      usageEvents: [],
      compacted: false,
    }),
    managedCodingHarness: { startTurn: vi.fn(() => catalog) },
    computerTargetsExposedForTurn: () => false,
    registerManagedMcp,
    prepareTurnImageAttachments: async () => undefined,
    teamMcpBridge: { unregister: vi.fn() },
    handleRuntimeFailure,
    cliTaskTitleJobs: new Map(),
    taskTitleRuntimeFor: () => grok,
  });
  return {
    router,
    handlers,
    codex,
    claude,
    grok,
    persistence,
    registerManagedMcp,
    handleRuntimeFailure,
    diagnosticContexts,
  };
}

const started: StartedTurn = {
  turnId: 'turn-grok',
  text: 'Reply OK',
  runtimeKind: 'grok',
  model: 'grok-test',
  modelSelection: {
    connectionId: 'builtin:grok-cli',
    requestedProvider: 'xai',
    requestedModel: 'grok-test',
  },
  skills: [],
  autoSkills: [],
  teamTurn: false,
  sealId: 'seal-grok',
  contextUsageEvents: [],
  workspaceSet: {
    roots: [],
    primaryRootId: null,
    digest: 'workspace-grok',
    source: 'none',
    projectId: null,
  },
  event: {
    type: 'stage.changed',
    taskId: 'task-grok',
    turnId: 'turn-grok',
    seq: 1,
    stage: 'understanding',
  },
};

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('Grok CLI Main routing', () => {
  it('probes Grok settings and validates its own model space', async () => {
    const { router, handlers, grok, persistence } = createHarness();
    router.register();
    expect(await handlers.get(IPC_CHANNELS.settingsGetRuntime)!({})).toMatchObject({
      kind: 'grok',
      grokAvailable: true,
      grokReadiness: 'ready',
      grokCli: null,
      model: 'grok-test',
      models: [{ id: 'auto' }, { id: 'grok-test' }],
    });
    await handlers.get(IPC_CHANNELS.settingsSetRuntime)!({ kind: 'grok' });
    expect(persistence.setRuntime).toHaveBeenCalledWith('grok');
    await handlers.get(IPC_CHANNELS.settingsSetModel)!({ model: 'grok-test' });
    expect(persistence.setModel).toHaveBeenCalledWith('grok-test');
    expect(persistence.setCodexEffort).not.toHaveBeenCalled();
    await expect(
      handlers.get(IPC_CHANNELS.settingsSetModel)!({ model: 'gpt-test' }),
    ).rejects.toThrow();
    grok.probe.mockResolvedValue({ available: false, readiness: 'unavailable', models: [] });
    try {
      await handlers.get(IPC_CHANNELS.settingsSetRuntime)!({ kind: 'grok' });
      expect.fail('Unavailable Grok must be rejected');
    } catch (error) {
      expect(toPublicError(error)).toMatchObject({
        code: 'RUNTIME_UNAVAILABLE',
        userMessage: expect.stringContaining('Grok CLI'),
      });
    }
    expect(invalidModelUserMessage('grok')).toContain('Grok CLI');
  });

  it('adopts Grok when it is the only ready CLI and selects its own host', async () => {
    vi.stubEnv('SPRINT_CODER_RUNTIME_ADOPT', '1');
    const { router, codex, claude, grok, persistence } = createHarness();
    codex.probe.mockResolvedValue({ available: false, readiness: 'unavailable', models: [] });
    claude.probe.mockResolvedValue({
      available: true,
      readiness: 'authentication_required',
      models: [],
    });
    await router.adoptInstalledRuntime();
    expect(persistence.setRuntime).toHaveBeenCalledWith('grok');
    expect(router.runtimeFor('grok')).toBe(grok);
    persistence.setRuntime.mockClear();
    persistence.getStoredRuntime.mockReturnValue('mock');
    await router.adoptInstalledRuntime();
    expect(persistence.setRuntime).not.toHaveBeenCalled();
  });

  it('includes xAI Grok subscription models in both the catalog and Team candidates', async () => {
    const { router } = createHarness();
    await router.refreshModelCatalog();
    const catalog = Reflect.get(router, 'modelCatalog') as ModelCatalogService;
    expect(listAvailableTeamRuntimeModels(catalog, 'task-grok')).toContainEqual(
      expect.objectContaining({
        connectionId: 'builtin:grok-cli',
        providerId: 'xai',
        providerDisplayName: 'xAI',
        modelId: 'grok-test',
        available: true,
      }),
    );
    expect(
      catalog.query({
        taskId: 'task-grok',
        text: '',
        connectionIds: ['builtin:grok-cli'],
        providerIds: [],
        accessTypes: ['subscription'],
        capabilities: [],
        availableOnly: true,
        cursor: null,
        limit: 10,
      }).items,
    ).toHaveLength(2);
  });

  it('dispatches managed Grok turns through MCP and Grok egress without effort overrides', async () => {
    const {
      router,
      grok,
      codex,
      claude,
      persistence,
      registerManagedMcp,
      handleRuntimeFailure,
      diagnosticContexts,
    } = createHarness();
    await router.startSelectedRuntime(started);
    expect(handleRuntimeFailure).not.toHaveBeenCalled();
    expect(registerManagedMcp).toHaveBeenCalledOnce();
    expect(diagnosticContexts.get('turn-grok')).toMatchObject({
      runtimeKind: 'grok',
      teamMcpEnabled: true,
    });
    expect(dispatchAfterGrokProviderEgress).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'builtin:grok-cli', modelId: 'grok-test' }),
      expect.any(Function),
    );
    expect(grok.start).toHaveBeenCalledOnce();
    expect(grok.start.mock.calls[0]?.[7]).toMatchObject({ token: 'test-token' });
    expect(grok.start.mock.calls[0]?.[8]).toBeUndefined();
    expect(persistence.getEffort).not.toHaveBeenCalled();
    expect(persistence.getCodexEffort).not.toHaveBeenCalled();
    expect(codex.start).not.toHaveBeenCalled();
    expect(claude.start).not.toHaveBeenCalled();
  });

  it('fails as Grok before dispatch when managed MCP registration is unavailable', async () => {
    const { router, grok, handleRuntimeFailure } = createHarness();
    Object.assign(router, { registerManagedMcp: () => undefined });
    await router.startSelectedRuntime(started);
    expect(handleRuntimeFailure).toHaveBeenCalledWith(
      'grok',
      'task-grok',
      'turn-grok',
      expect.objectContaining({ code: 'RUNTIME_FAILED' }),
    );
    expect(grok.start).not.toHaveBeenCalled();
    expect(dispatchAfterGrokProviderEgress).not.toHaveBeenCalled();
  });

  it('generates Grok titles without Codex probes or effort and keeps event ownership', async () => {
    const { router, grok, codex, persistence } = createHarness();
    grok.start.mockImplementation((taskId, turnId) => {
      router.routeCliTaskTitleEvent('claude', taskId, turnId, {
        type: 'completed',
        finalText: 'Wrong title',
      });
      router.routeCliTaskTitleEvent('grok', taskId, turnId, {
        type: 'completed',
        finalText: 'Grok title',
      });
      return true;
    });
    expect(
      await router.generateCliTaskTitle({ ...started, taskId: 'task-grok' }, 'grok', 'grok-test'),
    ).toBe('Grok title');
    expect(authorizeGrokProviderEgress).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'builtin:grok-cli' }),
    );
    expect(grok.start.mock.calls[0]?.[8]).toBeUndefined();
    expect(codex.probe).not.toHaveBeenCalled();
    expect(persistence.getEffort).not.toHaveBeenCalled();
    expect(persistence.getCodexEffort).not.toHaveBeenCalled();
  });
});

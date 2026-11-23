import { TurnStreamingResources } from './turn-streaming-resources';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type PublicError, type RuntimeKind } from '@sprint-coder/contracts';
import type { ToolCatalogSnapshot } from '@sprint-coder/domain';
import {
  IpcRouter,
  invalidModelUserMessage,
  listAvailableTeamRuntimeModels,
  toPublicError,
} from './ipc';
import { createEmptyToolCatalogSnapshot, MANAGED_EXEC_COMMAND_TOOL } from './default-tools';
import * as editBaseline from './edit-baseline';
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
  authorizeOfficialApiProviderEgress: vi.fn(() => ({ allowed: true })),
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
  permissionReviewSelection(
    taskId: string,
    turnId: string,
    callId: string,
  ): StartedTurn['modelSelection'] | null;
  register(): void;
  adoptInstalledRuntime(): Promise<void>;
  assertChatAiConnected(selection: StartedTurn['modelSelection'] | null): Promise<void>;
  refreshModelCatalog(): Promise<void>;
  runtimeFor(kind: CliKind): RuntimeHostClient;
  startSelectedRuntime(started: StartedTurn): Promise<void>;
  handleRuntimeFailure(kind: CliKind, taskId: string, turnId: string, error: PublicError): void;
  generateCliText(
    request: TitleRequest,
    kind: CliKind,
    model: string,
    purpose: 'title' | 'permission-review',
    signal?: AbortSignal,
  ): Promise<string | null>;
  generateProviderText(
    request: TitleRequest,
    connectionId: string,
    purpose: 'permission-review',
    signal: AbortSignal,
  ): Promise<string | null>;
  routeCliTaskTitleEvent(
    kind: CliKind,
    taskId: string,
    turnId: string,
    event: RuntimeCanonicalEvent,
  ): void;
};

const streamingResources: TurnStreamingResources[] = [];

function createHarness() {
  const resources = new TurnStreamingResources(vi.fn());
  streamingResources.push(resources);
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
    refreshCapabilityProbe: vi.fn(async (): Promise<unknown> => undefined),
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
    turnStreamingResources: resources,
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
    resources,
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
  for (const resources of streamingResources.splice(0)) resources.dispose();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('Grok CLI Main routing', () => {
  it('reviews a worker call with its bound model, even when the mission shares the leader turn', () => {
    const { router } = createHarness();
    const leader = started.modelSelection;
    const worker = {
      connectionId: 'local-worker',
      requestedProvider: 'ollama',
      requestedModel: 'review-local',
    };
    const getTurnModelIdentity = vi.fn(() => ({ selection: leader }));
    Object.assign(router, {
      persistence: { getTurnModelIdentity },
      managedWorkerCall: new Map([
        [
          JSON.stringify(['turn-grok', 'worker-call']),
          { executionBinding: { modelSelection: worker } },
        ],
        [JSON.stringify(['turn-grok', 'unbound-worker']), {}],
      ]),
    });
    expect(router.permissionReviewSelection('task-grok', 'turn-grok', 'worker-call')).toBe(worker);
    expect(router.permissionReviewSelection('task-grok', 'turn-grok', 'unbound-worker')).toBeNull();
    expect(getTurnModelIdentity).not.toHaveBeenCalled();
    expect(router.permissionReviewSelection('task-grok', 'turn-grok', 'leader-call')).toBe(leader);
  });

  it('allocates no streaming lease or runtime after cancellation during workspace verification', async () => {
    const { router, grok, resources } = createHarness();
    let verified!: () => void;
    const canceled = new Set<string>();
    Object.assign(router, {
      canceledRuntimeTurns: canceled,
      assertTurnWorkspaceHealthy: () =>
        new Promise<void>((resolve) => {
          verified = resolve;
        }),
    });
    const pending = router.startSelectedRuntime(started);
    expect(resources.size).toBe(0);
    canceled.add(started.turnId);
    verified();
    await pending;
    expect(resources.size).toBe(0);
    expect(grok.start).not.toHaveBeenCalled();
  });

  it('begins an external Provider lease before dispatch without starting workspace watchers', async () => {
    const { router, resources } = createHarness();
    const startWorkspaceWatch = vi.fn();
    const startProviderTurn = vi.fn(() => {
      expect(resources.get('task-grok', started.turnId)).toBeDefined();
    });
    Object.assign(router, { startProviderTurn, startWorkspaceWatch });
    await router.startSelectedRuntime({
      ...started,
      modelSelection: {
        connectionId: 'profile:provider',
        requestedProvider: 'openai',
        requestedModel: 'fixture',
      },
    });
    expect(startProviderTurn).toHaveBeenCalledTimes(1);
    expect(startWorkspaceWatch).not.toHaveBeenCalled();
    expect(resources.size).toBe(1);
  });

  it('owns the writing CLI lease before workspace watching and runtime dispatch', async () => {
    const { router, resources, grok, persistence, handleRuntimeFailure } = createHarness();
    const writing: StartedTurn = {
      ...started,
      workspaceSet: {
        source: 'task',
        projectId: null,
        primaryRootId: 'root-writing',
        digest: 'writing',
        roots: [
          {
            rootId: 'root-writing',
            role: 'primary',
            label: 'Workspace',
            path: process.cwd(),
            status: 'available',
          },
        ],
      },
    };
    const order: string[] = [];
    let leaseAtWatch: ReturnType<TurnStreamingResources['get']>;
    const startWorkspaceWatch = vi.fn((taskId: string, turnId: string) => {
      leaseAtWatch = resources.get(taskId, turnId);
      expect(leaseAtWatch).toBeDefined();
      order.push('watch');
    });
    const baseline = vi.spyOn(editBaseline, 'createEditBaselines').mockReturnValue({
      note: vi.fn(),
      get: async () => null,
    });
    vi.spyOn(persistence, 'getPermissionPolicy').mockReturnValue({
      preset: 'auto',
      policyEpoch: 1,
    });
    Object.assign(router, { startWorkspaceWatch, baselinesByTurn: new Map() });
    grok.start.mockImplementation(() => {
      expect(resources.get('task-grok', started.turnId)).toBe(leaseAtWatch);
      expect(leaseAtWatch).toBeDefined();
      order.push('start');
      return true;
    });
    try {
      await router.startSelectedRuntime(writing);
      expect(handleRuntimeFailure).not.toHaveBeenCalled();
      expect(startWorkspaceWatch).toHaveBeenCalledExactlyOnceWith(
        'task-grok',
        started.turnId,
        writing.workspaceSet,
      );
      expect(grok.start).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['watch', 'start']);
    } finally {
      baseline.mockRestore();
    }
  });

  it('does not begin or dispatch once streaming resource disposal starts', async () => {
    const { router, resources, grok } = createHarness();
    resources.dispose();
    await router.startSelectedRuntime(started);
    expect(resources.size).toBe(0);
    expect(grok.start).not.toHaveBeenCalled();
  });

  it.each(['active', 'canceled', 'late'] as const)(
    'quarantines Grok before %s failure guards and blocks queued and other Task turns',
    async (phase) => {
      const { router, grok, persistence } = createHarness();
      const quarantinedRuntimeKinds = new Set<CliKind>();
      const finishQuarantinedRuntimeStart = vi.fn();
      const next = (taskId: string, turnId: string): StartedTurn => ({
        ...started,
        turnId,
        event: { type: 'stage.changed', taskId, turnId, seq: 1, stage: 'understanding' },
      });
      const queued = next('task-grok', 'turn-queued');
      const otherTask = next('task-other', 'turn-other');
      const mailboxActions: Array<() => Promise<void>> = [];
      const finishAndAdvance = vi.fn(() => {
        expect(quarantinedRuntimeKinds.has('grok')).toBe(true);
        return router.startSelectedRuntime(queued);
      });
      Object.assign(router, {
        handleRuntimeFailure: Reflect.get(IpcRouter.prototype, 'handleRuntimeFailure'),
        quarantinedRuntimeKinds,
        canceledRuntimeTurns: new Set(phase === 'canceled' ? ['turn-grok'] : []),
        turnRuntimes: new Map(phase === 'late' ? [] : [['turn-grok', 'grok']]),
        mailbox: {
          run: (_taskId: string, action: () => Promise<void>) => {
            mailboxActions.push(action);
            return Promise.resolve();
          },
        },
        attachmentCustodyByTurn: new Map(),
        turnLogCategoryByTurn: new Map(),
        finishAndAdvance,
        finishQuarantinedRuntimeStart,
      });
      persistence.getActiveTurnId = () => 'turn-other';
      router.handleRuntimeFailure('grok', 'task-grok', 'turn-grok', {
        code: 'RUNTIME_STOP_UNCONFIRMED',
        userMessage: 'Runtime stop could not be confirmed',
        retryable: false,
      });
      // Quarantine must take effect before the failure reaches the Task mailbox.
      await router.startSelectedRuntime(otherTask);
      expect(finishQuarantinedRuntimeStart).toHaveBeenCalledWith(otherTask);
      persistence.getActiveTurnId = () => 'turn-queued';
      await mailboxActions[0]!();
      if (phase === 'active') expect(finishAndAdvance).toHaveBeenCalledOnce();
      else {
        expect(finishAndAdvance).not.toHaveBeenCalled();
        await router.startSelectedRuntime(queued);
      }
      expect(finishQuarantinedRuntimeStart).toHaveBeenCalledWith(queued);
      expect(grok.start).not.toHaveBeenCalled();
      expect(quarantinedRuntimeKinds).toEqual(new Set(['grok']));
    },
  );

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

  it('reports an unconnected default Mock without blocking an explicitly chosen Mock', async () => {
    vi.stubEnv('SPRINT_CODER_RUNTIME_ADOPT', '1');
    const { router, handlers, persistence } = createHarness();
    persistence.getRuntime.mockReturnValue('mock');
    router.register();
    const getRuntime = handlers.get(IPC_CHANNELS.settingsGetRuntime)!;
    expect(await getRuntime({})).toMatchObject({ aiConnectionRequired: true });
    persistence.getStoredRuntime.mockReturnValue('mock');
    expect(await getRuntime({})).not.toHaveProperty('aiConnectionRequired');
    persistence.getStoredRuntime.mockReturnValue(null);
    vi.stubEnv('SPRINT_CODER_RUNTIME_ADOPT', '0');
    expect(await getRuntime({})).not.toHaveProperty('aiConnectionRequired');
  });

  it('keeps a selected CLI usable after an inconclusive probe and blocks a known login requirement', async () => {
    const { router, handlers, grok, persistence } = createHarness();
    persistence.getStoredRuntime.mockReturnValue('grok');
    router.register();
    const getRuntime = handlers.get(IPC_CHANNELS.settingsGetRuntime)!;
    grok.probe.mockRejectedValueOnce(new Error('Temporary host failure'));
    await expect(router.assertChatAiConnected(null)).resolves.toBeUndefined();
    grok.probe.mockResolvedValue({ available: false, readiness: 'unavailable', models: [] });
    await expect(router.assertChatAiConnected(null)).resolves.toBeUndefined();
    expect(await getRuntime({})).not.toHaveProperty('aiConnectionRequired');

    grok.probe.mockResolvedValue({
      available: true,
      readiness: 'authentication_required',
      models: [],
    });
    const error = await router.assertChatAiConnected(null).catch((cause: unknown) => cause);
    expect(toPublicError(error)).toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
    expect(await getRuntime({})).toMatchObject({ aiConnectionRequired: true });
  });

  it('detects every CLI again on request so a Grok missed at startup becomes selectable (issue #581)', async () => {
    const { router, handlers, codex, claude, grok } = createHarness();
    router.register();
    grok.probe.mockResolvedValue({ available: true, readiness: 'unavailable', models: [] });
    expect(await handlers.get(IPC_CHANNELS.settingsGetRuntime)!({})).toMatchObject({
      grokReadiness: 'unavailable',
      models: [],
    });
    grok.refreshCapabilityProbe.mockImplementation(async () => {
      grok.probe.mockResolvedValue({
        available: true,
        readiness: 'ready',
        models: [
          { id: 'auto', displayName: 'Auto' },
          { id: 'grok-test', displayName: 'grok-test' },
        ],
      });
      return grok.probe();
    });
    await expect(
      handlers.get(IPC_CHANNELS.settingsRefreshRuntimeDetection)!({}),
    ).resolves.toBeUndefined();
    for (const host of [codex, claude, grok])
      expect(host.refreshCapabilityProbe).toHaveBeenCalledOnce();
    expect(await handlers.get(IPC_CHANNELS.settingsGetRuntime)!({})).toMatchObject({
      codexReadiness: 'ready',
      claudeReadiness: 'ready',
      grokReadiness: 'ready',
      model: 'grok-test',
      models: [{ id: 'auto' }, { id: 'grok-test' }],
    });
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

  it('starts using the newly ready CLI for an existing unconnected Task after rechecking', async () => {
    vi.stubEnv('SPRINT_CODER_RUNTIME_ADOPT', '1');
    const { router, handlers, codex, claude, grok, persistence } = createHarness();
    const missing = { available: false, readiness: 'unavailable', models: [] };
    codex.probe.mockResolvedValue(missing);
    claude.probe.mockResolvedValue(missing);
    grok.probe.mockResolvedValue(missing);
    persistence.getRuntime.mockReturnValue('mock');
    persistence.setRuntime.mockImplementation((kind: RuntimeKind) => {
      persistence.getRuntime.mockReturnValue(kind);
      persistence.getStoredRuntime.mockReturnValue(kind);
    });
    router.register();
    const readRuntime = handlers.get(IPC_CHANNELS.settingsGetRuntime)!;
    expect(await readRuntime({ taskId: 'task-grok' })).toMatchObject({
      kind: 'mock',
      aiConnectionRequired: true,
    });
    grok.refreshCapabilityProbe.mockImplementation(async () => {
      grok.probe.mockResolvedValue({
        available: true,
        readiness: 'ready',
        models: [{ id: 'grok-test', displayName: 'grok-test' }],
      });
    });
    await handlers.get(IPC_CHANNELS.settingsRefreshRuntimeDetection)!({});
    const connected = await readRuntime({ taskId: 'task-grok' });
    expect(connected).toMatchObject({ kind: 'grok', grokReadiness: 'ready' });
    expect(connected).not.toHaveProperty('aiConnectionRequired');
    await expect(router.assertChatAiConnected(null)).resolves.toBeUndefined();
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
      await router.generateCliText(
        { ...started, taskId: 'task-grok' },
        'grok',
        'grok-test',
        'title',
      ),
    ).toBe('Grok title');
    expect(authorizeGrokProviderEgress).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'builtin:grok-cli' }),
    );
    expect(grok.start.mock.calls[0]?.[8]).toBeUndefined();
    expect(codex.probe).not.toHaveBeenCalled();
    expect(persistence.getEffort).not.toHaveBeenCalled();
    expect(persistence.getCodexEffort).not.toHaveBeenCalled();
  });

  it('runs a permission review on the selected CLI without a workspace or tools', async () => {
    const { router, grok } = createHarness();
    grok.start.mockImplementation((taskId, turnId) => {
      router.routeCliTaskTitleEvent('grok', taskId, turnId, {
        type: 'completed',
        finalText: 'ALLOW_ONCE',
      });
      return true;
    });
    expect(
      await router.generateCliText(
        { ...started, text: '{"operation":"read"}', taskId: 'task-grok' },
        'grok',
        'grok-test',
        'permission-review',
      ),
    ).toBe('ALLOW_ONCE');
    const call = grok.start.mock.calls[0]!;
    expect(call[2]).toContain('permission reviewer');
    expect(call[3]).toBeNull();
    expect(call[5].entries).toEqual([]);
    expect(call[9]).toBe('read-only');
    expect(authorizeGrokProviderEgress).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterVersion: 'runtime-protocol-v7:permission-review-v1',
        modelId: 'grok-test',
      }),
    );
  });

  it('cancels just the review CLI execution when its tool call stops', async () => {
    const { router, grok } = createHarness();
    const stop = new AbortController();
    const pending = router.generateCliText(
      { ...started, taskId: 'task-grok' },
      'grok',
      'grok-test',
      'permission-review',
      stop.signal,
    );
    const [taskId, executionId] = grok.start.mock.calls[0]!;
    stop.abort();
    expect(grok.cancel).toHaveBeenCalledExactlyOnceWith(taskId, executionId);
    router.routeCliTaskTitleEvent('grok', taskId, executionId, {
      type: 'completed',
      finalText: 'ALLOW_ONCE',
    });
    await expect(pending).resolves.toBeNull();
  });

  it('aborts a running provider review and cancels its execution before the stream completes', async () => {
    const { router, persistence } = createHarness();
    const stop = new AbortController();
    const connection = { id: 'connection', providerId: 'provider' };
    const cancel = vi.fn(async (_id: string) => undefined);
    let endStream!: () => void;
    const waitForEnd = new Promise<void>((resolve) => {
      endStream = resolve;
    });
    const execute = vi.fn(async function* (
      _connection: unknown,
      _request: { executionId: string },
      _signal: AbortSignal,
    ) {
      await waitForEnd;
      yield { type: 'output_delta', text: 'ALLOW_ONCE' };
      yield { type: 'completed' };
    });
    Object.assign(persistence, { getProviderConnection: () => connection });
    Object.assign(router, {
      taskTitleProviderAborts: { track: () => () => undefined },
      ensureProviderEndpointConsent: async () => connection,
      providerVerification: { requireVerifiedForExecution: async () => connection },
      providerEgressTrustForConnection: () => 'trusted-local',
      providerRegistry: { resolve: () => ({ cancel, execute }) },
    });
    const pending = router.generateProviderText(
      {
        ...started,
        taskId: 'task-grok',
        modelSelection: {
          connectionId: connection.id,
          requestedProvider: connection.providerId,
          requestedModel: 'model',
        },
      },
      connection.id,
      'permission-review',
      stop.signal,
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const [, { executionId }, transportSignal] = execute.mock.calls[0]!;
    stop.abort();
    expect(transportSignal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(executionId);
    endStream();
    await expect(pending).resolves.toBeNull();
  });
});

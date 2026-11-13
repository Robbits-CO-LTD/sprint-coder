import { TurnStreamingResources } from './turn-streaming-resources';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type PublicError, type RuntimeKind } from '@sprint-coder/contracts';
import type { ToolCatalogSnapshot } from '@sprint-coder/domain';
import { IpcRouter, teamUsageOfferAvailable } from './ipc';
import { createEmptyToolCatalogSnapshot, MANAGED_EXEC_COMMAND_TOOL } from './default-tools';
import type { StartedTurn } from './persistence';
import type { RuntimeHostClient } from './runtime-host';
import { BUILTIN_TEAM_SKILL_CONTENT } from './team-skill';
import { teamUsageGuidance } from './team-usage-mode';
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
vi.mock('./provider-egress', async (importOriginal) => {
  const passThrough = vi.fn((_input: unknown, dispatch: () => void) => {
    dispatch();
    return { allowed: true };
  });
  return {
    ...(await importOriginal<typeof ProviderEgressModule>()),
    dispatchAfterGrokProviderEgress: passThrough,
    dispatchAfterClaudeProviderEgress: passThrough,
    dispatchAfterCodexProviderEgress: passThrough,
  };
});

type CliKind = Exclude<RuntimeKind, 'mock'>;
type LeaderMcpOptions = { teamTurn: boolean; skillCreatorTurn: boolean; memoryTurn: boolean };
type LeaderMcpOption = {
  socketPath: string;
  token: string;
  guidance: string;
  toolNames: readonly string[];
};
type RouterProbe = {
  startSelectedRuntime(started: StartedTurn): Promise<void>;
  registerLeaderMcp(
    turnId: string,
    taskId: string,
    options: LeaderMcpOptions,
  ): LeaderMcpOption | undefined;
  handleRuntimeFailure(kind: CliKind, taskId: string, turnId: string, error: PublicError): void;
};

const streamingResources: TurnStreamingResources[] = [];

function createHarness(
  options: {
    teamSkillReady?: boolean;
    leaderMcp?: LeaderMcpOption | undefined;
  } = {},
) {
  const resources = new TurnStreamingResources(vi.fn());
  streamingResources.push(resources);
  const router = Object.create(IpcRouter.prototype) as RouterProbe;
  const host = () => ({
    start: vi.fn<RuntimeHostClient['start']>(() => true),
    cancel: vi.fn(async () => undefined),
  });
  const grok = host();
  const persistence = {
    getActiveTurnId: () => 'turn-1',
    getTask: () => ({ id: 'task-1', projectId: null }),
    getPermissionPolicy: () => ({ preset: 'ask', policyEpoch: 1 }),
    getEffort: () => 'high',
    getCodexEffort: () => '',
  };
  const catalog: ToolCatalogSnapshot = {
    ...createEmptyToolCatalogSnapshot('grok', null),
    entries: [MANAGED_EXEC_COMMAND_TOOL],
  };
  const leaderMcp =
    'leaderMcp' in options
      ? options.leaderMcp
      : {
          socketPath: '\\\\.\\pipe\\team-test',
          token: 'leader-token',
          guidance: 'leader guidance',
          toolNames: ['team_hire_worker'],
        };
  const registerLeaderMcp = vi.fn(() => leaderMcp);
  const registerManagedMcp = vi.fn(() => ({
    socketPath: '\\\\.\\pipe\\team-test',
    token: 'managed-token',
    guidance: 'Managed tools',
    toolNames: [],
    managedTools: [],
    toolCatalogDigest: catalog.digest,
  }));
  const prepareContext = vi.fn((_taskId: string, _turnId: string, _teamSkill?: boolean) => ({
    fragments: [],
    projectItems: [],
    projectSnapshotDigest: null,
    usageEvents: [],
    compacted: false,
  }));
  const handleRuntimeFailure = vi.fn();
  const mockRuntime = { start: vi.fn() };
  const teamRequiredTurns = new Set<string>();
  Object.assign(router, {
    turnStreamingResources: resources,
    persistence,
    grokRuntime: grok,
    canceledRuntimeTurns: new Set(),
    quarantinedRuntimeTasks: new Set(),
    quarantinedRuntimeKinds: new Set(),
    turnRuntimes: new Map(),
    turnWorkspaceByTurn: new Map(),
    runtimeDiagnosticContextByTurn: new Map(),
    attachmentCapabilityByTurn: new Map(),
    assertTurnWorkspaceHealthy: vi.fn(async () => undefined),
    pushRuntimeStatus: vi.fn(),
    prepareContext,
    managedCodingHarness: { startTurn: vi.fn(() => catalog) },
    registerLeaderMcp,
    registerManagedMcp,
    prepareTurnImageAttachments: async () => undefined,
    teamMcpBridge: { unregister: vi.fn(), attachManagedTools: vi.fn(() => true) },
    teamSkillReady: options.teamSkillReady ?? true,
    teamRequiredTurns,
    mockRuntime,
    handleRuntimeFailure,
  });
  return {
    router,
    grok,
    registerLeaderMcp,
    registerManagedMcp,
    prepareContext,
    handleRuntimeFailure,
    mockRuntime,
    teamRequiredTurns,
  };
}

function startedTurn(overrides: Partial<StartedTurn>): StartedTurn {
  return {
    turnId: 'turn-1',
    text: '認証まわりを直してテストも足して',
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
    sealId: 'seal-1',
    contextUsageEvents: [],
    workspaceSet: {
      roots: [],
      primaryRootId: null,
      digest: 'workspace-1',
      source: 'none',
      projectId: null,
    },
    event: {
      type: 'stage.changed',
      taskId: 'task-1',
      turnId: 'turn-1',
      seq: 1,
      stage: 'understanding',
    },
    ...overrides,
  };
}

/** A Turn the user asked Team for (unchanged by the setting). */
const requested = (text = 'チームで進めて') => startedTurn({ text, teamTurn: true });
/** A Turn only offered Team by 「Team の使い方」. */
const offered = (mode: 'auto' | 'proactive', text?: string) =>
  startedTurn({ ...(text === undefined ? {} : { text }), teamTurn: true, teamUsageOffer: mode });

afterEach(() => {
  for (const resources of streamingResources.splice(0)) resources.dispose();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('Team usage mode in dispatch', () => {
  it.each(['auto', 'proactive'] as const)(
    'gives the %s-offered Leader the Team tools and the sealed Skill, without requiring Workers',
    async (mode) => {
      const h = createHarness();
      // Even with wording that would demand Workers, an offered Turn never records the requirement.
      await h.router.startSelectedRuntime(offered(mode, '担当を雇ってください。'));
      expect(h.handleRuntimeFailure).not.toHaveBeenCalled();
      expect(h.registerLeaderMcp).toHaveBeenCalledWith('turn-1', 'task-1', {
        teamTurn: true,
        skillCreatorTurn: false,
        memoryTurn: false,
      });
      expect(h.prepareContext).toHaveBeenCalledWith('task-1', 'turn-1', true);
      expect(h.teamRequiredTurns.has('turn-1')).toBe(false);
      expect(h.mockRuntime.start).not.toHaveBeenCalled();
      expect(h.grok.start).toHaveBeenCalledTimes(1);
      expect(h.grok.start.mock.calls[0]?.[7]).toMatchObject({ token: 'leader-token' });
    },
  );

  it('still requires Workers on a Turn that asked for Team', async () => {
    const h = createHarness();
    await h.router.startSelectedRuntime(requested('担当を雇ってください。'));
    expect(h.handleRuntimeFailure).not.toHaveBeenCalled();
    expect(h.teamRequiredTurns.has('turn-1')).toBe(true);
    expect(h.grok.start).toHaveBeenCalledTimes(1);
  });

  // Not offered at all when the Skill is unverified at sealing (see teamUsageOfferAvailable); this is
  // the narrow case of the check changing after the seal, where the sealed tools are kept.
  it('does not fail an already offered Turn when the Team Skill check turns false, and keeps its Team tools', async () => {
    const h = createHarness({ teamSkillReady: false });
    await h.router.startSelectedRuntime(offered('auto'));
    expect(h.handleRuntimeFailure).not.toHaveBeenCalled();
    expect(h.registerLeaderMcp).toHaveBeenCalledWith('turn-1', 'task-1', {
      teamTurn: true,
      skillCreatorTurn: false,
      memoryTurn: false,
    });
    expect(h.grok.start).toHaveBeenCalledTimes(1);
  });

  it('keeps a skill-creator Turn (never offered by the seal) without Team tools', async () => {
    const h = createHarness();
    await h.router.startSelectedRuntime(
      startedTurn({
        skills: [
          {
            selection: {
              kind: 'chat',
              ref: { source: 'builtin', skillId: 'skill-creator', digest: 'c'.repeat(64) },
            },
            name: 'skill-creator',
            description: 'Create a Skill',
            content: 'CREATOR_BODY',
            packagePath: '/tmp/sprint-coder-skill-creator',
          },
        ],
      }),
    );
    expect(h.registerLeaderMcp).toHaveBeenCalledWith('turn-1', 'task-1', {
      teamTurn: false,
      skillCreatorTurn: true,
      memoryTurn: false,
    });
    expect(h.prepareContext).toHaveBeenCalledWith('task-1', 'turn-1', false);
  });

  it('fails a requested Team Turn when the Team Skill cannot be verified, as before', async () => {
    const h = createHarness({ teamSkillReady: false });
    await h.router.startSelectedRuntime(requested());
    expect(h.handleRuntimeFailure).toHaveBeenCalledWith('grok', 'task-1', 'turn-1', {
      code: 'RUNTIME_FAILED',
      userMessage: '組み込みTeam Skillを検証できないためTeamを開始できません。',
      retryable: true,
    });
    expect(h.grok.start).not.toHaveBeenCalled();
  });

  it('runs an offered Turn without Team when the Team MCP is unavailable', async () => {
    const h = createHarness({ leaderMcp: undefined });
    await h.router.startSelectedRuntime(offered('proactive'));
    expect(h.handleRuntimeFailure).not.toHaveBeenCalled();
    // The managed tools still reach Grok on their own registration.
    expect(h.registerManagedMcp).toHaveBeenCalledTimes(1);
    expect(h.grok.start).toHaveBeenCalledTimes(1);
    // The sealed Skill is still the expected acknowledgement.
    expect(h.prepareContext).toHaveBeenCalledWith('task-1', 'turn-1', true);
  });

  it('fails a requested Team Turn when the Team MCP is unavailable, as before', async () => {
    const h = createHarness({ leaderMcp: undefined });
    await h.router.startSelectedRuntime(requested());
    expect(h.handleRuntimeFailure).toHaveBeenCalledWith(
      'grok',
      'task-1',
      'turn-1',
      expect.objectContaining({ userMessage: 'Team MCPへ接続できないためTeamを開始できません。' }),
    );
    expect(h.grok.start).not.toHaveBeenCalled();
  });

  it('never falls back to the mock Leader for an offered Turn, only for a requested one', async () => {
    vi.stubEnv('SPRINT_CODER_LEADER_MCP', '0');
    const asked = createHarness();
    await asked.router.startSelectedRuntime(requested());
    expect(asked.mockRuntime.start).toHaveBeenCalledWith(
      'task-1',
      'turn-1',
      'チームで進めて',
      true,
    );
    expect(asked.grok.start).not.toHaveBeenCalled();

    const offeredHarness = createHarness();
    await offeredHarness.router.startSelectedRuntime(offered('auto'));
    expect(offeredHarness.mockRuntime.start).not.toHaveBeenCalled();
    expect(offeredHarness.registerLeaderMcp).not.toHaveBeenCalled();
    expect(offeredHarness.handleRuntimeFailure).not.toHaveBeenCalled();
    expect(offeredHarness.grok.start).toHaveBeenCalledTimes(1);
  });

  it('keeps the mock runtime as it was at every level', async () => {
    for (const turn of [
      startedTurn({ runtimeKind: 'mock' }),
      startedTurn({ runtimeKind: 'mock', text: 'チームで進めて', teamTurn: true }),
    ]) {
      const h = createHarness();
      await h.router.startSelectedRuntime(turn);
      expect(h.mockRuntime.start).toHaveBeenCalledWith(
        'task-1',
        'turn-1',
        turn.text,
        turn.teamTurn,
      );
      expect(h.registerLeaderMcp).not.toHaveBeenCalled();
    }
  });

  it('leaves an ordinary Turn without Team tools', async () => {
    const h = createHarness();
    await h.router.startSelectedRuntime(startedTurn({}));
    expect(h.registerLeaderMcp).not.toHaveBeenCalled();
    expect(h.prepareContext).toHaveBeenCalledWith('task-1', 'turn-1', false);
    expect(h.grok.start).toHaveBeenCalledTimes(1);
  });
});

describe('teamUsageOfferAvailable', () => {
  const ready = {
    leaderMcpEnabled: true,
    teamSkillReady: true,
    teamMcpBridgeReady: true,
    workspaceRepositoryReady: true,
  };
  const cli = (runtimeKind: RuntimeKind, connectionId: string, requestedProvider = 'openai') => ({
    runtimeKind,
    modelSelection: { connectionId, requestedProvider, requestedModel: 'm' },
  });

  it.each([
    ['codex', 'builtin:codex-cli', 'openai'],
    ['claude', 'builtin:claude-cli', 'anthropic'],
    ['grok', 'builtin:grok-cli', 'xai'],
  ] as const)('offers a %s CLI Leader', (kind, connectionId, provider) => {
    expect(teamUsageOfferAvailable({ ...ready, ...cli(kind, connectionId, provider) })).toBe(true);
    // A legacy selection with no Connection still runs the CLI.
    expect(
      teamUsageOfferAvailable({
        ...ready,
        runtimeKind: kind,
        modelSelection: { connectionId: null, requestedProvider: null, requestedModel: null },
      }),
    ).toBe(true);
  });

  it('answers false instead of throwing on a malformed selection', () => {
    expect(
      teamUsageOfferAvailable({
        ...ready,
        runtimeKind: 'codex',
        modelSelection: {
          connectionId: 'builtin:codex-cli',
          requestedProvider: 'openai',
          requestedModel: null,
        },
      }),
    ).toBe(false);
  });

  it('never offers the mock runtime or an API Leader', () => {
    expect(teamUsageOfferAvailable({ ...ready, ...cli('mock', 'builtin:mock') })).toBe(false);
    expect(
      teamUsageOfferAvailable({
        ...ready,
        runtimeKind: 'codex',
        modelSelection: {
          connectionId: 'profile:openrouter',
          requestedProvider: 'openrouter',
          requestedModel: 'some-model',
        },
      }),
    ).toBe(false);
  });

  // workspaceRepositoryReady: a Workspace where a writing Worker's assignment would fail (not a Git
  // repository, no commit, uncommitted changes) is never offered Team (issue #1241).
  it.each([
    'leaderMcpEnabled',
    'teamSkillReady',
    'teamMcpBridgeReady',
    'workspaceRepositoryReady',
  ] as const)('does not offer Team when %s is false', (missing) => {
    expect(
      teamUsageOfferAvailable({
        ...ready,
        [missing]: false,
        ...cli('codex', 'builtin:codex-cli'),
      }),
    ).toBe(false);
  });
});

describe('what an offered Leader is given', () => {
  it('registers the Team tools and the Team guidance for the offered Turn', () => {
    const router = Object.create(IpcRouter.prototype) as RouterProbe;
    const register = vi.fn();
    Object.assign(router, {
      teamMcpBridge: { socketPath: '\\\\.\\pipe\\team-test', register },
      teamCoordinator: { latestTeamMessageSeq: () => 0 },
      persistence: {
        getTeamModelResearchBeforeHiring: () => false,
        getTeamModelSelectionGuidance: () => '',
      },
    });
    const offeredMcp = router.registerLeaderMcp('turn-1', 'task-1', {
      teamTurn: true,
      skillCreatorTurn: false,
      memoryTurn: false,
    });
    const ordinaryMcp = router.registerLeaderMcp('turn-2', 'task-1', {
      teamTurn: false,
      skillCreatorTurn: false,
      memoryTurn: true,
    });
    const skillCreatorMcp = router.registerLeaderMcp('turn-3', 'task-1', {
      teamTurn: false,
      skillCreatorTurn: true,
      memoryTurn: false,
    });
    expect(skillCreatorMcp?.toolNames).toEqual(['skill_draft_create']);
    expect(skillCreatorMcp?.guidance).toContain('team_*ツールは使用しません');
    expect(offeredMcp?.toolNames).toContain('team_hire_worker');
    expect(offeredMcp?.toolNames).toContain('team_assign_tasks');
    expect(offeredMcp?.guidance).toContain(BUILTIN_TEAM_SKILL_CONTENT);
    expect(ordinaryMcp?.toolNames.some((name) => name.startsWith('team_'))).toBe(false);
    // Team limits stay in the registration the bridge enforces.
    expect(register.mock.calls[0]?.[1]).toMatchObject({ role: 'leader', allowTeamTools: true });
    expect(register.mock.calls[1]?.[1]).toMatchObject({ role: 'leader', allowTeamTools: false });
  });

  it('keeps the level guidance consistent with the built-in Team Skill', () => {
    for (const mode of ['auto', 'proactive'] as const) {
      const guidance = teamUsageGuidance(mode);
      // Same rules as the Skill's 「# 判断」: no Workers for questions, no more than needed.
      expect(guidance).toContain('Worker を雇わず自分で対応する');
      expect(guidance).toMatch(/必要な最小|必要以上に雇わない/);
      expect(guidance).toContain('1 文で伝えてから雇う');
      expect(guidance).toContain('利用枠');
      // Right even when the Team tools did not reach this Turn: the Skill's fail-closed report and
      // its "inspect Team state on questions" rule apply only once the Leader decides to use Team.
      expect(guidance).toContain('Team の道具（`team_*`）が使えるなら');
      expect(guidance).toContain('利用不能の報告もせずに、普通に対応する');
      expect(guidance).toContain('あなたが Team を使うと決めた時にだけ当てはまる');
      expect(guidance).toContain('`team_get_status` など）を呼ぶこともしない');
    }
    // 積極的に: small independent deliverables are still split, and the guidance says it takes
    // precedence over the Skill's 「# 判断」 for that decision (the Skill itself is not rewritten).
    const proactive = teamUsageGuidance('proactive');
    expect(proactive).toContain('2 つ以上なら、1 つずつが小さくても');
    expect(proactive).toContain('その成果物を自分で作らない');
    expect(proactive).toContain('質問・相談・説明と、1 つの成果物で済む依頼だけ');
    expect(proactive).toContain('Team を使わない理由を利用者に 1 文で伝える');
    expect(proactive).toContain('上限は Team の設定に従う');
    expect(proactive).toContain('この発言では、この案内を優先する');
    expect(proactive).not.toContain('ごく小さな修正');
    // おまかせ: still "when in doubt, don't", with a size-based (not time-based) point where it does
    // use Team, and the trivial cases spelled out — so it differs from both 言った時だけ and 積極的に.
    const auto = teamUsageGuidance('auto');
    expect(auto).toContain('迷ったら使わない');
    expect(auto).toContain('独立した成果物が 3 つ以上あり');
    expect(auto).toContain('1 つのファイル全体・1 つの画面・1 つの機能・1 つの調べもの');
    expect(auto).not.toContain('数分以上');
    expect(auto).toContain('成果物が 1〜2 つの依頼');
    expect(auto).toContain('1 つずつが数行で済むごく小さなもの');
    expect(auto).not.toContain('2 つ以上なら');
    for (const guidance of [auto, proactive]) {
      expect(guidance).toContain('この発言の依頼の一部として扱う');
      expect(guidance).toContain('Team を使わない理由を利用者に 1 文で伝える');
      expect(guidance).toContain('この発言では、この案内を優先する');
      // An offered Team must not strand the request when the Workspace refuses a writing Worker
      // (not Git, no commit, uncommitted changes): the Leader does it itself, and the user's
      // changes are never committed, stashed, or discarded to make room for Team (issue #1241).
      expect(guidance).toContain('Workspace の状態のために失敗した時');
      expect(guidance).toContain('commit していない変更がある');
      expect(guidance).toContain(
        '成果物を Worker に任せる、とした上の行より、この戻り方を優先する',
      );
      expect(guidance).toContain(
        '利用者の変更には触らない（Team を使うために commit・stash・破棄をしない）',
      );
    }
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('単発実行');
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain(
      '質問・相談: Teamの実状態を調べるためにMCPを使うが、Workerは採用しない。',
    );
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('人数指定を守り、必要以上に採用しない。');
  });
});

describe('the Workspace check before a Turn may be offered Team (issue #1241)', () => {
  type Handler = (
    input: Record<string, unknown>,
    event: unknown,
    envelope: unknown,
  ) => Promise<unknown>;
  type EntryProbe = {
    register(): void;
    refreshTeamOfferWorkspace(taskId: string): Promise<void>;
  };

  function entryRouter() {
    const router = Object.create(IpcRouter.prototype) as EntryProbe;
    const handlers = new Map<string, Handler>();
    const register = (channel: string, _input: unknown, _output: unknown, handler: Handler) =>
      handlers.set(channel, handler);
    const order: string[] = [];
    const runMutation = vi.fn(() => {
      order.push('start-transaction');
      return { executed: false, value: undefined };
    });
    Object.assign(router, {
      handle: register,
      handleMutation: register,
      window: { webContents: { once: vi.fn() } },
      persistence: {
        getTaskModelSelection: () => null,
        getOperationResult: () => ({ found: false }),
        getActiveTurnId: () => null,
        getTask: () => ({ goal: 'Finish the page' }),
      },
      reconcileTaskBuiltinModel: vi.fn(async () => undefined),
      resolveTurnSkills: vi.fn(async () => []),
      skillSettings: { resolveSelections: vi.fn(async () => []) },
      runMutation,
      refreshTeamOfferWorkspace: vi.fn(async (taskId: string) => {
        order.push(`refresh:${taskId}`);
      }),
    });
    router.register();
    return { handlers, order, runMutation };
  }

  it.each([
    [IPC_CHANNELS.turnsStart, { taskId: 'task-1', text: 'Write three pages', attachmentIds: [] }],
    [IPC_CHANNELS.turnsQueue, { taskId: 'task-1', text: 'Write three pages' }],
    [IPC_CHANNELS.turnsStopAndSend, { taskId: 'task-1', text: 'Write three pages' }],
    [IPC_CHANNELS.goalsStart, { taskId: 'task-1', objective: 'Write three pages' }],
    [IPC_CHANNELS.goalsResume, { taskId: 'task-1' }],
  ] as const)('asks Git on %s before the Turn start transaction', async (channel, input) => {
    const { handlers, order, runMutation } = entryRouter();
    await handlers.get(channel)!(input, {}, { operationId: 'op-1', payload: input });
    expect(runMutation).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['refresh:task-1', 'start-transaction']);
  });

  function offerRouter(mode: 'explicit' | 'auto' | 'proactive', ready: boolean) {
    const router = Object.create(IpcRouter.prototype) as EntryProbe;
    const refresh = vi.fn(async () => ready);
    Object.assign(router, {
      persistence: { getTeamUsageMode: () => mode },
      teamOfferWorkspace: { refresh },
    });
    return { router, refresh };
  }

  it('asks Git only at the levels that offer Team, and never fails the start', async () => {
    const explicit = offerRouter('explicit', true);
    await explicit.router.refreshTeamOfferWorkspace('task-1');
    expect(explicit.refresh).not.toHaveBeenCalled();
    for (const mode of ['auto', 'proactive'] as const) {
      const offered = offerRouter(mode, false);
      await offered.router.refreshTeamOfferWorkspace('task-1');
      expect(offered.refresh).toHaveBeenCalledWith('task-1');
    }
    const broken = Object.create(IpcRouter.prototype) as EntryProbe;
    Object.assign(broken, {
      persistence: {
        getTeamUsageMode: () => {
          throw new Error('settings unreadable');
        },
      },
    });
    await expect(broken.refreshTeamOfferWorkspace('task-1')).resolves.toBeUndefined();
  });
});

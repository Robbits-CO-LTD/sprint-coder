import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_CONTROL_TEAM_CURSORS_VARIABLE,
  desktopControlSupported,
} from './desktop-control-build';
import type { TeamCoordinator } from './team-coordinator';
import {
  BUILTIN_CLAUDE_CONNECTION_ID,
  BUILTIN_CODEX_CONNECTION_ID,
  BUILTIN_GROK_CONNECTION_ID,
} from './connection-identity';
import type { AgentRecord } from './persistence';
import {
  ProviderAwareTeamWorkerRuntime,
  type ProviderTeamWorkerRuntimeDeps,
} from './provider-team-worker-runtime';
import {
  configureDesktopControlTeamCursors,
  configureDesktopControlWorkerTool,
  desktopControlWorker,
  desktopControlWorkerToolOffer,
  resetDesktopControlSessions,
} from './desktop-control-session';
import {
  LEADER_DESKTOP_CONTROL_GUIDANCE,
  leaderDesktopControlGuidance,
  WORKER_DESKTOP_CONTROL_PROMPT,
  WORKER_MCP_SYSTEM_PROMPT,
  executeTeamTool,
} from './team-tools';
import { teamMcpDesktopHireProperty } from '../runtime-host/team-mcp-server-source';

afterEach(() => resetDesktopControlSessions());

/** The cursors on, in a Main whose harness offers its Turns the command tool (the sandbox is). */
function cursorsOn(): void {
  configureDesktopControlTeamCursors(true);
  configureDesktopControlWorkerTool(() => true);
}

type HireInput = {
  role: string;
  writeCapable: boolean;
  modelSelection?: {
    connectionId: string | null;
    requestedProvider: string | null;
    requestedModel: string | null;
  };
};

/** A Team that hires whoever is asked for, numbering them in order; `workers` is its state. */
function team() {
  let next = 0;
  const workers: ({ id: string; state: string } & NonNullable<HireInput['modelSelection']>)[] = [];
  const state = { team: 'active' };
  const hired = (input: HireInput) => {
    const worker = {
      id: `agent-${(next += 1)}`,
      role: input.role,
      state: 'ready',
      parentAgentId: null,
      depth: 1,
      canDelegate: false,
      writeCapable: input.writeCapable,
      managerPolicy: null,
      connectionId: input.modelSelection?.connectionId ?? null,
      requestedProvider: input.modelSelection?.requestedProvider ?? null,
      requestedModel: input.modelSelection?.requestedModel ?? null,
    };
    workers.push(worker);
    return worker;
  };
  const coordinator = {
    hireWorker: vi.fn(async (input: HireInput) => hired(input)),
    hireWorkerAs: vi.fn(async (input: HireInput) => hired(input)),
    get: () => ({ team: { state: state.team }, workers }),
    notifyDesktopControlMarked: vi.fn(),
  } as unknown as TeamCoordinator;
  return Object.assign(coordinator, { workers, state });
}

const hire = (
  coordinator: TeamCoordinator,
  args: Record<string, unknown>,
  requesterAgentId?: string,
) =>
  executeTeamTool(
    coordinator,
    'task-1',
    'team_hire_worker',
    { agentKind: 'worker', role: '確認係', objective: '窓を確かめる', ...args },
    requesterAgentId === undefined ? {} : { requesterAgentId },
  ) as Promise<Record<string, unknown>>;

describe('the Team’s desktop cursors as Main and the Runtime Host start', () => {
  // Where desktop control is not built (macOS, Linux), the cursors stay off whatever is given.
  const built = desktopControlSupported(process.platform, process.arch);
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each([
    ['unset (the default)', undefined, built],
    ['1', '1', built],
    ['another value', 'yes', built],
    ['0', '0', false],
  ] as const)(
    'with the variable %s, are on in Main, its hire tool and the Leader’s MCP tool alike, or off',
    async (_name, value, on) => {
      vi.stubEnv(DESKTOP_CONTROL_TEAM_CURSORS_VARIABLE, value);
      vi.resetModules();
      const session = await import('./desktop-control-session');
      const tools = await import('./team-tools');
      const source = await import('../runtime-host/team-mcp-server-source');
      expect(session.DESKTOP_CONTROL_TEAM_CURSORS_AT_START).toBe(on);
      const properties = (tools.TEAM_HIRE_WORKER_TOOL.inputSchema as { properties: object })
        .properties;
      expect(Object.hasOwn(properties, 'desktopControl')).toBe(on);
      expect(source.TEAM_MCP_SERVER_SOURCE.includes('desktopControl')).toBe(on);
    },
  );
});

describe('the Leader’s desktop mark on a hire', () => {
  it('is not offered, accepted or reported with the Team cursors off', async () => {
    // Off is what `SPRINT_CODER_DESKTOP_TEAM_CURSORS=0` gives Main (and what Main is before it
    // configures them): the MCP tool has no such field, and the hire refuses it as any unknown one.
    configureDesktopControlTeamCursors(false);
    configureDesktopControlWorkerTool(() => true);
    expect(teamMcpDesktopHireProperty(false)).toBe('');
    const coordinator = team();
    const plain = await hire(coordinator, {});
    expect(plain).toMatchObject({ ok: true, workerId: 'agent-1' });
    expect(plain).not.toHaveProperty('desktopControl');
    await expect(hire(coordinator, { desktopControl: true })).resolves.toMatchObject({
      ok: false,
    });
    expect(desktopControlWorker('task-1', 'agent-1')).toBeUndefined();
    expect(coordinator.notifyDesktopControlMarked).not.toHaveBeenCalled();
  });

  it('marks up to three leaf Workers the Leader hires, and says why not otherwise', async () => {
    cursorsOn();
    expect(teamMcpDesktopHireProperty(true)).toContain("desktopControl: { type: 'boolean'");
    const coordinator = team();
    for (let index = 1; index <= 3; index += 1)
      await expect(hire(coordinator, { desktopControl: true })).resolves.toMatchObject({
        ok: true,
        workerId: `agent-${index}`,
        desktopControl: true,
      });
    expect(desktopControlWorker('task-1', 'agent-3')).toMatchObject({
      label: '確認係',
      colorIndex: 2,
    });
    // Each mark publishes the Team, so the Team view shows the Worker's cursor color at once.
    expect(coordinator.notifyDesktopControlMarked).toHaveBeenCalledTimes(3);
    expect(coordinator.notifyDesktopControlMarked).toHaveBeenCalledWith('task-1');
    await expect(hire(coordinator, { desktopControl: true })).resolves.toMatchObject({
      desktopControl: false,
      desktopControlNote: expect.stringContaining('同時に 3 人まで'),
    });
    // Not by a Manager, not for a Manager, and not without asking.
    resetDesktopControlSessions();
    cursorsOn();
    await expect(hire(coordinator, { desktopControl: true }, 'manager-1')).resolves.toMatchObject({
      desktopControl: false,
    });
    await expect(
      hire(coordinator, {
        desktopControl: true,
        agentKind: 'manager',
        managerPolicy: { maxDelegationLevels: 1, allowManagerChildren: false },
      }),
    ).resolves.toMatchObject({ desktopControl: false });
    const plain = await hire(coordinator, {});
    expect(plain).not.toHaveProperty('desktopControl');
    for (const id of ['agent-5', 'agent-6', 'agent-7'])
      expect(desktopControlWorker('task-1', id)).toBeUndefined();
  });

  it('counts the Workers at work, not every Worker ever marked, and reuses a freed accent', async () => {
    cursorsOn();
    const coordinator = team();
    for (let index = 1; index <= 3; index += 1)
      await hire(coordinator, { desktopControl: true, role: `担当${index}` });
    // While three are at work, a fourth is refused.
    await expect(hire(coordinator, { desktopControl: true })).resolves.toMatchObject({
      desktopControl: false,
    });
    // One finishes (or fails, or is stopped): the next one gets its place and its accent.
    coordinator.workers.find(({ id }) => id === 'agent-2')!.state = 'done';
    await expect(hire(coordinator, { desktopControl: true })).resolves.toMatchObject({
      workerId: 'agent-5',
      desktopControl: true,
    });
    expect(desktopControlWorker('task-1', 'agent-5')).toMatchObject({ colorIndex: 1 });
    expect(desktopControlWorker('task-1', 'agent-2')).toBeUndefined();
    await expect(hire(coordinator, { desktopControl: true })).resolves.toMatchObject({
      desktopControl: false,
    });
    for (const id of ['agent-1', 'agent-3'])
      coordinator.workers.find((w) => w.id === id)!.state = id === 'agent-1' ? 'stopped' : 'failed';
    await expect(hire(coordinator, { desktopControl: true })).resolves.toMatchObject({
      desktopControl: true,
    });
    // A Team that ended frees every place.
    coordinator.state.team = 'completed';
    for (let index = 0; index < 3; index += 1)
      await expect(hire(coordinator, { desktopControl: true })).resolves.toMatchObject({
        desktopControl: true,
      });
  });

  it('marks no Worker, and holds no place, when the Worker cannot be given the command tool', async () => {
    // As Main without the command sandbox: the harness offers its Turns no `exec_command`.
    configureDesktopControlTeamCursors(true);
    let offered = false;
    configureDesktopControlWorkerTool(() => offered);
    const coordinator = team();
    for (let index = 0; index < 4; index += 1) {
      const refused = await hire(coordinator, { desktopControl: true });
      expect(refused).toMatchObject({
        ok: true,
        desktopControl: false,
        desktopControlNote: expect.stringContaining('デスクトップ操作の道具を渡せません'),
      });
      expect(desktopControlWorker('task-1', refused['workerId'] as string)).toBeUndefined();
    }
    // The refused Workers, still at work, hold no place: once the tool can be given, three fit.
    offered = true;
    for (let index = 0; index < 3; index += 1)
      await expect(hire(coordinator, { desktopControl: true })).resolves.toMatchObject({
        desktopControl: true,
      });
    await expect(hire(coordinator, { desktopControl: true })).resolves.toMatchObject({
      desktopControl: false,
      desktopControlNote: expect.stringContaining('同時に 3 人まで'),
    });
  });

  it('marks no Worker, and tells the Leader nothing of desktop Workers, without the executable', async () => {
    // As a development run that has not built the desktop-control executable.
    configureDesktopControlTeamCursors(true);
    configureDesktopControlWorkerTool(
      desktopControlWorkerToolOffer(
        () => true,
        () => null,
      ),
    );
    const coordinator = team();
    const refused = await hire(coordinator, { desktopControl: true });
    expect(refused).toMatchObject({
      ok: true,
      desktopControl: false,
      desktopControlNote: expect.stringContaining('デスクトップ操作の実行ファイルが使えない'),
    });
    expect(desktopControlWorker('task-1', refused['workerId'] as string)).toBeUndefined();
    expect(leaderDesktopControlGuidance(true)).toBeNull();
  });

  it('marks only a Worker that runs on a CLI', async () => {
    cursorsOn();
    const coordinator = team();
    const api = await hire(coordinator, {
      desktopControl: true,
      modelSelection: {
        connectionId: 'connection-api-1',
        requestedProvider: 'openai',
        requestedModel: 'gpt-test',
      },
    });
    expect(api).toMatchObject({
      ok: true,
      desktopControl: false,
      desktopControlNote: 'この種類の Worker は、デスクトップ操作を実行できません。',
    });
    expect(desktopControlWorker('task-1', api['workerId'] as string)).toBeUndefined();
    await expect(
      hire(coordinator, {
        desktopControl: true,
        modelSelection: {
          connectionId: BUILTIN_CODEX_CONNECTION_ID,
          requestedProvider: 'openai',
          requestedModel: 'gpt-test',
        },
      }),
    ).resolves.toMatchObject({ desktopControl: true });
    // The API Worker holds no place: two more fit beside the CLI one, and the next is refused.
    // A hire that names no Connection runs on the default CLI (the Worker runtime hands a Worker
    // without a Connection to its CLI runtime), so it is marked and holds a place too.
    const defaultCli = await hire(coordinator, { desktopControl: true });
    expect(defaultCli).toMatchObject({ desktopControl: true });
    expect(desktopControlWorker('task-1', defaultCli['workerId'] as string)).toBeDefined();
    await expect(hire(coordinator, { desktopControl: true })).resolves.toMatchObject({
      desktopControl: true,
    });
    await expect(hire(coordinator, { desktopControl: true })).resolves.toMatchObject({
      desktopControl: false,
    });
  });

  it('marks a Worker exactly when the Worker runtime hands it to the CLI runtime', async () => {
    cursorsOn();
    const cli = vi.fn(async () => ({ pid: 1 }));
    const runtime = new ProviderAwareTeamWorkerRuntime({
      fallback: { start: cli, execute: vi.fn(), stop: vi.fn() },
    } as unknown as ProviderTeamWorkerRuntimeDeps);
    const selections: (HireInput['modelSelection'] | undefined)[] = [
      // No Connection named: the default CLI.
      undefined,
      { connectionId: null, requestedProvider: null, requestedModel: null },
      {
        connectionId: BUILTIN_CODEX_CONNECTION_ID,
        requestedProvider: 'openai',
        requestedModel: 'm',
      },
      {
        connectionId: BUILTIN_CLAUDE_CONNECTION_ID,
        requestedProvider: 'anthropic',
        requestedModel: 'm',
      },
      { connectionId: BUILTIN_GROK_CONNECTION_ID, requestedProvider: 'xai', requestedModel: 'm' },
      // A built-in CLI's Connection with another provider, and an API Connection.
      { connectionId: BUILTIN_CODEX_CONNECTION_ID, requestedProvider: 'xai', requestedModel: 'm' },
      { connectionId: 'connection-api-1', requestedProvider: 'openai', requestedModel: 'm' },
    ];
    for (const modelSelection of selections) {
      resetDesktopControlSessions();
      cursorsOn();
      cli.mockClear();
      const coordinator = team();
      const hired = await hire(coordinator, {
        desktopControl: true,
        ...(modelSelection === undefined ? {} : { modelSelection }),
      });
      const worker = coordinator.workers.at(-1)!;
      await runtime.start({
        id: worker.id,
        modelSelection: {
          connectionId: worker.connectionId,
          requestedProvider: worker.requestedProvider,
          requestedModel: worker.requestedModel,
        },
      } as unknown as AgentRecord);
      const onCli = cli.mock.calls.length === 1;
      expect({ modelSelection, marked: hired['desktopControl'] }).toEqual({
        modelSelection,
        marked: onCli,
      });
      expect(desktopControlWorker('task-1', worker.id) !== undefined).toBe(onCli);
    }
  });

  it('judges a hire that names no Connection by the selection the Worker inherits, and counts only CLI Workers', async () => {
    cursorsOn();
    // As Main stores a hire that names no Connection (`persistence.ts`): with the Leader's selection.
    let inherited: NonNullable<HireInput['modelSelection']> = {
      connectionId: 'connection-api-1',
      requestedProvider: 'openai',
      requestedModel: 'gpt-test',
    };
    const coordinator = team();
    const hireWorker = coordinator.hireWorker as unknown as ReturnType<typeof vi.fn>;
    const original = hireWorker.getMockImplementation()!;
    hireWorker.mockImplementation(async (input: HireInput) =>
      original({ ...input, modelSelection: input.modelSelection ?? inherited }),
    );
    for (let index = 0; index < 4; index += 1)
      await expect(hire(coordinator, { desktopControl: true })).resolves.toMatchObject({
        desktopControl: false,
        desktopControlNote: 'この種類の Worker は、デスクトップ操作を実行できません。',
      });
    const apiWorkers = coordinator.workers.map(({ id }) => id);
    // The refused API Workers, still at work, hold no place: three CLI Workers still fit, and a
    // fourth does not.
    inherited = {
      connectionId: BUILTIN_GROK_CONNECTION_ID,
      requestedProvider: 'xai',
      requestedModel: 'grok-test',
    };
    for (let index = 0; index < 3; index += 1)
      await expect(hire(coordinator, { desktopControl: true })).resolves.toMatchObject({
        desktopControl: true,
      });
    await expect(hire(coordinator, { desktopControl: true })).resolves.toMatchObject({
      desktopControl: false,
      desktopControlNote: expect.stringContaining('同時に 3 人まで'),
    });
    for (const id of apiWorkers) expect(desktopControlWorker('task-1', id)).toBeUndefined();
  });

  it('gives the Leader the desktop guidance only on a Team Turn, with the cursors on and a Worker markable', () => {
    configureDesktopControlTeamCursors(true);
    let offered = true;
    configureDesktopControlWorkerTool(() => offered);
    expect(leaderDesktopControlGuidance(true)).toBe(LEADER_DESKTOP_CONTROL_GUIDANCE);
    expect(leaderDesktopControlGuidance(false)).toBeNull();
    // Without the command sandbox (or the executable), no Worker can be marked: nothing is said.
    offered = false;
    expect(leaderDesktopControlGuidance(true)).toBeNull();
    // With the cursors off (`=0`), as before the cursors existed.
    offered = true;
    configureDesktopControlTeamCursors(false);
    expect(leaderDesktopControlGuidance(true)).toBeNull();
  });

  it('tells only a marked Worker, and the Leader with the cursors on, how to share the desktop', () => {
    expect(WORKER_MCP_SYSTEM_PROMPT).not.toContain('デスクトップ');
    expect(WORKER_DESKTOP_CONTROL_PROMPT).toContain('--session と --agent-id は付けません');
    expect(WORKER_DESKTOP_CONTROL_PROMPT).toContain('set-value');
    expect(WORKER_DESKTOP_CONTROL_PROMPT).toContain('TIMEOUT');
    // Sent but not checked by the executable is not a failure: the Worker checks it and goes on,
    // on a snapshot that shows text and state, and does not send it twice first.
    expect(WORKER_DESKTOP_CONTROL_PROMPT).toContain(
      'delivered_unverified なら、操作は届いています（結果を自動では確かめていないだけで、失敗ではありません）',
    );
    expect(WORKER_DESKTOP_CONTROL_PROMPT).toContain('止まらずに -i なしの snapshot');
    expect(WORKER_DESKTOP_CONTROL_PROMPT).toContain('-i は操作できる部品を探す時だけ');
    expect(WORKER_DESKTOP_CONTROL_PROMPT).toContain('確かめる前に繰り返しません（2 回届きます）');
    for (const delivery of ['delivered_verified', 'not_delivered', 'delivery_uncertain', 'unknown'])
      expect(WORKER_DESKTOP_CONTROL_PROMPT).toContain(delivery);
    expect(LEADER_DESKTOP_CONTROL_GUIDANCE).toContain('desktopControl: true');
    expect(LEADER_DESKTOP_CONTROL_GUIDANCE).toContain('3人まで');
  });
});

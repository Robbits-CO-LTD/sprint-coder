import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamCoordinator } from './team-coordinator';
import { BUILTIN_CODEX_CONNECTION_ID } from './connection-identity';
import {
  configureDesktopControlTeamCursors,
  desktopControlWorker,
  resetDesktopControlSessions,
} from './desktop-control-session';
import {
  LEADER_DESKTOP_CONTROL_GUIDANCE,
  TEAM_HIRE_WORKER_TOOL,
  WORKER_DESKTOP_CONTROL_PROMPT,
  WORKER_MCP_SYSTEM_PROMPT,
  executeTeamTool,
} from './team-tools';
import {
  TEAM_MCP_SERVER_SOURCE,
  teamMcpDesktopHireProperty,
} from '../runtime-host/team-mcp-server-source';

afterEach(() => resetDesktopControlSessions());

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
  const workers: { id: string; state: string }[] = [];
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

describe('the Leader’s desktop mark on a hire', () => {
  it('is not offered, accepted or reported without the Team cursors', async () => {
    const properties = (TEAM_HIRE_WORKER_TOOL.inputSchema as { properties: object }).properties;
    expect(properties).not.toHaveProperty('desktopControl');
    expect(teamMcpDesktopHireProperty(false)).toBe('');
    expect(TEAM_MCP_SERVER_SOURCE).not.toContain('desktopControl');
    const coordinator = team();
    const plain = await hire(coordinator, {});
    expect(plain).toMatchObject({ ok: true, workerId: 'agent-1' });
    expect(plain).not.toHaveProperty('desktopControl');
    await expect(hire(coordinator, { desktopControl: true })).resolves.toMatchObject({
      ok: false,
    });
    expect(desktopControlWorker('task-1', 'agent-1')).toBeUndefined();
  });

  it('marks up to three leaf Workers the Leader hires, and says why not otherwise', async () => {
    configureDesktopControlTeamCursors(true);
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
    await expect(hire(coordinator, { desktopControl: true })).resolves.toMatchObject({
      desktopControl: false,
      desktopControlNote: expect.stringContaining('同時に 3 人まで'),
    });
    // Not by a Manager, not for a Manager, and not without asking.
    resetDesktopControlSessions();
    configureDesktopControlTeamCursors(true);
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
    configureDesktopControlTeamCursors(true);
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

  it('marks only a Worker that runs on a CLI', async () => {
    configureDesktopControlTeamCursors(true);
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

  it('tells only a marked Worker, and the Leader with the cursors on, how to share the desktop', () => {
    expect(WORKER_MCP_SYSTEM_PROMPT).not.toContain('デスクトップ');
    expect(WORKER_DESKTOP_CONTROL_PROMPT).toContain('--session と --agent-id は付けません');
    expect(WORKER_DESKTOP_CONTROL_PROMPT).toContain('set-value');
    expect(WORKER_DESKTOP_CONTROL_PROMPT).toContain('TIMEOUT');
    expect(LEADER_DESKTOP_CONTROL_GUIDANCE).toContain('desktopControl: true');
    expect(LEADER_DESKTOP_CONTROL_GUIDANCE).toContain('3人まで');
  });
});

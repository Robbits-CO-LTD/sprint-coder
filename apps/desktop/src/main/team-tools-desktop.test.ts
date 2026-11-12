import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamCoordinator } from './team-coordinator';
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

/** A Team that hires whoever is asked for, numbering them in order. */
function team() {
  let next = 0;
  const hired = (input: { role: string; writeCapable: boolean }) => ({
    id: `agent-${(next += 1)}`,
    role: input.role,
    state: 'ready',
    parentAgentId: null,
    depth: 1,
    canDelegate: false,
    writeCapable: input.writeCapable,
    managerPolicy: null,
  });
  const coordinator = {
    hireWorker: vi.fn(async (input: { role: string; writeCapable: boolean }) => hired(input)),
    hireWorkerAs: vi.fn(async (input: { role: string; writeCapable: boolean }) => hired(input)),
  } as unknown as TeamCoordinator;
  return coordinator;
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

  it('tells only a marked Worker, and the Leader with the cursors on, how to share the desktop', () => {
    expect(WORKER_MCP_SYSTEM_PROMPT).not.toContain('デスクトップ');
    expect(WORKER_DESKTOP_CONTROL_PROMPT).toContain('--session と --agent-id は付けません');
    expect(WORKER_DESKTOP_CONTROL_PROMPT).toContain('set-value');
    expect(WORKER_DESKTOP_CONTROL_PROMPT).toContain('TIMEOUT');
    expect(LEADER_DESKTOP_CONTROL_GUIDANCE).toContain('desktopControl: true');
    expect(LEADER_DESKTOP_CONTROL_GUIDANCE).toContain('3人まで');
  });
});

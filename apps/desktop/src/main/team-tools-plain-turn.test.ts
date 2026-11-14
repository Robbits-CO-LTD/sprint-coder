import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamCoordinator } from './team-coordinator';
import { ManagedCodingHarness, providerToolsFromSnapshot } from './provider-workspace-tools';
import {
  TeamMcpBridge as ProductionTeamMcpBridge,
  defaultSocketPathFactory,
  type TeamMcpRegistration,
} from './team-mcp-bridge';
import { queryNativeProcessIdentity } from './native-process-identity';
import {
  LEADER_PROVIDER_TOOLS,
  TEAM_TOOL_NAMES,
  TEAM_TOOLS,
  TEAM_TOOLS_UNAVAILABLE_MESSAGE,
} from './team-tools';
import { TEAM_CORE_MCP_TOOL_NAMES } from '../runtime-host/team-mcp-tool-contract';

// A Turn the user did not ask Team for (and was not offered Team) must not be able to use Team at
// all: no team_* tool in what the Leader is given, and a team_* call refused by the bridge even if
// one reached it. Found on a real claude Leader with 「Team の使い方」 = 言った時だけ, whose
// `--allowedTools` listed 13 team_* tools and whose team_get_status call succeeded.

class TeamMcpBridge extends ProductionTeamMcpBridge {
  override register(turnId: string, registration: TeamMcpRegistration): void {
    super.register(turnId, registration);
    const identity = queryNativeProcessIdentity(process.pid);
    if (identity === null || !this.bindRuntimeProcess(turnId, identity))
      throw new Error('Native process identity is required by Team MCP tests');
  }
}

function fakeCoordinator(): TeamCoordinator {
  return {
    get: vi.fn(() => null),
    hireWorker: vi.fn(async () => ({ id: 'worker-1', role: 'role', state: 'ready' })),
    hireWorkerAs: vi.fn(async () => ({ id: 'worker-1', role: 'role', state: 'ready' })),
    assignTask: vi.fn(async () => ({ executionId: 'execution-1', state: 'queued' })),
    assignTaskAs: vi.fn(async () => ({ executionId: 'execution-1', state: 'queued' })),
    assignTasks: vi.fn(async () => []),
    listWorkerReports: vi.fn(() => []),
    listAgentMessages: vi.fn(() => []),
    hasBusyWorkers: vi.fn(() => false),
    stopWorker: vi.fn(async () => ({ id: 'worker-1', state: 'stopped' })),
  } as unknown as TeamCoordinator;
}

const harnesses: ManagedCodingHarness[] = [];
const bridges: TeamMcpBridge[] = [];
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.dispose();
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

function managedHarness(coordinator: TeamCoordinator): ManagedCodingHarness {
  const harness = new ManagedCodingHarness({
    workspaceFor: () => null,
    rootIdentityFor: () => undefined,
    policyEpochFor: () => 1,
    authorizer: () => ({ decision: 'allow', reason: 'test' }),
    team: { coordinator },
    auxiliary: {
      projectMemoryTarget: () => ({ projectId: 'project-1', projectName: 'Project' }),
      queueProjectMemory: async () => ({ queued: true }),
      createSkillDraft: async () => ({}),
      activateSkill: async () => ({}),
    },
  });
  harnesses.push(harness);
  return harness;
}

const context = (turnId: string) =>
  ({ taskId: 'task-1', turnId, workspaceId: null, policyEpoch: 1 }) as const;

const teamNames = (names: readonly string[]) =>
  names.filter((name) => TEAM_TOOL_NAMES.has(name)).sort();
/** The Team tools a Leader's Team Turn has had all along (before and after this fix). */
const LEADER_TEAM_TOOL_NAMES = LEADER_PROVIDER_TOOLS.map(({ name }) => name).sort();

describe('what counts as a Team tool', () => {
  it('is every team_* tool the harness and the Team MCP know, from their own lists', () => {
    for (const { providerName } of TEAM_TOOLS) expect(TEAM_TOOL_NAMES.has(providerName)).toBe(true);
    for (const name of TEAM_CORE_MCP_TOOL_NAMES) expect(TEAM_TOOL_NAMES.has(name)).toBe(true);
    expect(TEAM_TOOL_NAMES.has('read_file')).toBe(false);
    expect(TEAM_TOOL_NAMES.has('project_memory_remember')).toBe(false);
    expect(TEAM_TOOL_NAMES.has('exec_command')).toBe(false);
  });
});

describe('the managed catalog of a Leader Turn', () => {
  // codex, claude, grok and an API Leader (an official provider id) all start their Turn here.
  it.each(['claude', 'grok', 'codex', 'openai'])(
    'has no Team tool on a plain %s Turn, and refuses a team_* call',
    async (providerId) => {
      const coordinator = fakeCoordinator();
      const harness = managedHarness(coordinator);
      const snapshot = harness.startTurn(context('turn-plain'), providerId, {
        projectMemory: true,
      });
      const names = snapshot.entries.map(({ providerName }) => providerName);
      expect(teamNames(names)).toEqual([]);
      // What a plain Turn needs is still there.
      expect(names).toEqual(expect.arrayContaining(['update_plan', 'project_memory_remember']));
      for (const providerName of ['team_get_status', 'team_hire_worker', 'team_assign_tasks'])
        await expect(
          harness.broker.dispatch({
            taskId: 'task-1',
            turnId: 'turn-plain',
            callId: `call-${providerName}`,
            providerName,
            input: {},
          }),
        ).rejects.toThrow();
      expect(coordinator.get).not.toHaveBeenCalled();
      expect(coordinator.hireWorker).not.toHaveBeenCalled();
      expect(coordinator.assignTasks).not.toHaveBeenCalled();
    },
  );

  it.each(['claude', 'grok', 'codex', 'openai'])(
    'keeps every Team tool on a %s Team Turn, and runs it',
    async (providerId) => {
      const coordinator = fakeCoordinator();
      const harness = managedHarness(coordinator);
      const snapshot = harness.startTurn(context('turn-team'), providerId, { teamTools: true });
      expect(teamNames(snapshot.entries.map(({ providerName }) => providerName))).toEqual(
        LEADER_TEAM_TOOL_NAMES,
      );
      await expect(
        harness.broker.dispatch({
          taskId: 'task-1',
          turnId: 'turn-team',
          callId: 'call-status',
          providerName: 'team_get_status',
          input: {},
        }),
      ).resolves.toMatchObject({ ok: true, team: null });
      expect(coordinator.get).toHaveBeenCalledWith('task-1');
    },
  );
});

const RESPONSE_TIMEOUT_MS = 5_000;
let nextRequestId = 1;

function call(
  socketPath: string,
  token: string,
  tool: string,
  args: unknown = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no response to ${tool}`));
    }, RESPONSE_TIMEOUT_MS);
    socket.once('connect', () =>
      socket.write(`${JSON.stringify({ requestId: `r-${nextRequestId++}`, token, tool, args })}\n`),
    );
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, index)) as Record<string, unknown>);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** The bridge wired to the harness the way IpcRouter wires it: a managed tool runs on the broker,
 * against the Turn's own catalog. */
async function wiredBridge(coordinator: TeamCoordinator, harness: ManagedCodingHarness) {
  const executeManaged = vi.fn(
    (
      input: unknown,
      managed: { taskId: string; turnId: string; callId: string; toolName: string },
    ) =>
      harness.broker.dispatch({
        taskId: managed.taskId,
        turnId: managed.turnId,
        callId: managed.callId,
        providerName: managed.toolName,
        input,
      }),
  );
  const bridge = new TeamMcpBridge(
    coordinator,
    defaultSocketPathFactory(tmpdir()),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    executeManaged,
  );
  bridges.push(bridge);
  const socketPath = await bridge.ensureStarted();
  if (socketPath === null) throw new Error('Team MCP bridge did not start');
  return { bridge, socketPath, executeManaged };
}

describe('the Team MCP bridge on a Turn without Team', () => {
  // The claude/grok plain Turn registration (`registerManagedMcp`): only the managed catalog.
  it.skipIf(process.platform === 'darwin')(
    'lists no Team tool and refuses team_get_status, team_hire_worker and team_assign_tasks',
    async () => {
      const coordinator = fakeCoordinator();
      const harness = managedHarness(coordinator);
      const snapshot = harness.startTurn(context('turn-plain'), 'claude', { projectMemory: true });
      const { bridge, socketPath, executeManaged } = await wiredBridge(coordinator, harness);
      const token = TeamMcpBridge.generateToken();
      bridge.register('turn-plain', {
        taskId: 'task-1',
        token,
        allowTeamTools: false,
        allowedTools: [],
        managedTools: providerToolsFromSnapshot(snapshot),
        managedToolCatalogDigest: snapshot.digest,
        contextOwner: { type: 'turn', id: 'turn-plain' },
      });
      const authentication = (await call(socketPath, token, '__authenticate__')) as {
        result: { allowedTools: string[]; managedTools: { name: string }[] };
      };
      expect(teamNames(authentication.result.allowedTools)).toEqual([]);
      expect(teamNames(authentication.result.managedTools.map(({ name }) => name))).toEqual([]);
      for (const [tool, args] of [
        ['team_get_status', {}],
        [
          'team_hire_worker',
          {
            agentKind: 'worker',
            role: 'coder',
            objective: 'write it',
            modelSelection: {
              connectionId: 'builtin:claude-cli',
              requestedProvider: 'anthropic',
              requestedModel: 'claude-test',
            },
            modelSelectionReason: 'test',
          },
        ],
        ['team_assign_tasks', { assignments: [{ workerId: 'worker-1', content: 'do it' }] }],
      ] as const)
        expect(await call(socketPath, token, tool, args)).toMatchObject({
          ok: false,
          error: TEAM_TOOLS_UNAVAILABLE_MESSAGE,
        });
      // A Team tool never reached the Team, through either path.
      expect(executeManaged).not.toHaveBeenCalled();
      expect(coordinator.get).not.toHaveBeenCalled();
      expect(coordinator.hireWorker).not.toHaveBeenCalled();
      expect(coordinator.hireWorkerAs).not.toHaveBeenCalled();
      expect(coordinator.assignTasks).not.toHaveBeenCalled();
      // The Turn's other managed tools still run.
      expect(await call(socketPath, token, 'update_plan', { plan: [] })).not.toMatchObject({
        error: TEAM_TOOLS_UNAVAILABLE_MESSAGE,
      });
      expect(executeManaged).toHaveBeenCalledTimes(1);
    },
  );

  // The second guard: even if a Team tool were attached to a registration that does not allow
  // Team, the bridge refuses it instead of running it.
  it.skipIf(process.platform === 'darwin')(
    'refuses a Team tool that was attached to a registration without Team',
    async () => {
      const coordinator = fakeCoordinator();
      const harness = managedHarness(coordinator);
      const snapshot = harness.startTurn(context('turn-leak'), 'grok', { teamTools: true });
      const { bridge, socketPath, executeManaged } = await wiredBridge(coordinator, harness);
      const token = TeamMcpBridge.generateToken();
      bridge.register('turn-leak', {
        taskId: 'task-1',
        token,
        role: 'leader',
        allowTeamTools: false,
        managedTools: providerToolsFromSnapshot(snapshot),
        managedToolCatalogDigest: snapshot.digest,
      });
      const authentication = (await call(socketPath, token, '__authenticate__')) as {
        result: { managedTools: { name: string }[] };
      };
      expect(teamNames(authentication.result.managedTools.map(({ name }) => name))).toEqual([]);
      expect(await call(socketPath, token, 'team_get_status')).toMatchObject({
        ok: false,
        error: TEAM_TOOLS_UNAVAILABLE_MESSAGE,
      });
      expect(executeManaged).not.toHaveBeenCalled();
      expect(coordinator.get).not.toHaveBeenCalled();
    },
  );

  // The codex Leader keeps the Team tools on the bridge's own path (`executeTeamTool`).
  it.skipIf(process.platform === 'darwin')(
    'refuses a native team_* call on a Leader registration without Team',
    async () => {
      const coordinator = fakeCoordinator();
      const harness = managedHarness(coordinator);
      const { bridge, socketPath } = await wiredBridge(coordinator, harness);
      const token = TeamMcpBridge.generateToken();
      bridge.register('turn-codex', {
        taskId: 'task-1',
        token,
        role: 'leader',
        allowTeamTools: false,
        allowProjectMemory: true,
      });
      expect(await call(socketPath, token, 'team_hire_worker', {})).toMatchObject({
        ok: false,
        error: TEAM_TOOLS_UNAVAILABLE_MESSAGE,
      });
      expect(coordinator.hireWorker).not.toHaveBeenCalled();
      expect(coordinator.hireWorkerAs).not.toHaveBeenCalled();
    },
  );
});

describe('the Team MCP bridge on a Team Turn', () => {
  it.skipIf(process.platform === 'darwin')(
    'lists and runs the managed Team tools of a Leader registration with Team',
    async () => {
      const coordinator = fakeCoordinator();
      const harness = managedHarness(coordinator);
      const snapshot = harness.startTurn(context('turn-team'), 'claude', { teamTools: true });
      const { bridge, socketPath, executeManaged } = await wiredBridge(coordinator, harness);
      const token = TeamMcpBridge.generateToken();
      bridge.register('turn-team', {
        taskId: 'task-1',
        token,
        role: 'leader',
        allowTeamTools: true,
        managedTools: providerToolsFromSnapshot(snapshot),
        managedToolCatalogDigest: snapshot.digest,
      });
      const authentication = (await call(socketPath, token, '__authenticate__')) as {
        result: { managedTools: { name: string }[] };
      };
      expect(teamNames(authentication.result.managedTools.map(({ name }) => name))).toEqual(
        LEADER_TEAM_TOOL_NAMES,
      );
      expect(await call(socketPath, token, 'team_get_status')).toMatchObject({
        ok: true,
        result: { ok: true, team: null },
      });
      expect(executeManaged).toHaveBeenCalledTimes(1);
      expect(coordinator.get).toHaveBeenCalledWith('task-1');
    },
  );
});

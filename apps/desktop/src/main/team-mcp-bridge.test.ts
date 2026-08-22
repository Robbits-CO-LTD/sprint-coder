import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TeamMcpBridge as ProductionTeamMcpBridge,
  defaultSocketPathFactory,
  type TeamMcpRegistration,
} from './team-mcp-bridge';
import type { TeamCoordinator } from './team-coordinator';
import { queryNativeProcessIdentity } from './native-process-identity';
import {
  PROJECT_MEMORY_MCP_TOOL_NAMES,
  WORKER_TEAM_MCP_TOOL_NAMES,
} from '../runtime-host/team-mcp-tool-contract';

class TeamMcpBridge extends ProductionTeamMcpBridge {
  override register(turnId: string, registration: TeamMcpRegistration): void {
    super.register(turnId, registration);
    const identity = queryNativeProcessIdentity(process.pid);
    if (identity === null || !this.bindRuntimeProcess(turnId, identity)) {
      throw new Error('Native process identity is required by Team MCP tests');
    }
  }
}

function fakeCoordinator(overrides: Partial<TeamCoordinator> = {}): TeamCoordinator {
  return {
    hireWorker: vi.fn(async () => ({ id: 'worker-1', role: 'role', state: 'ready' }) as never),
    hireWorkerAs: vi.fn(async () => ({ id: 'worker-1', role: 'role', state: 'ready' }) as never),
    sendToWorker: vi.fn(async () => {
      throw new Error('not used in this test');
    }),
    listWorkerReports: vi.fn(() => []),
    assignTaskAs: vi.fn(async () => ({ executionId: 'execution-1', state: 'queued' }) as never),
    listAgentMessages: vi.fn(() => []),
    hasBusyWorkers: vi.fn(() => false),
    stopWorker: vi.fn(async () => ({ id: 'worker-1', state: 'stopped' }) as never),
    ...overrides,
  } as unknown as TeamCoordinator;
}

const bridges: TeamMcpBridge[] = [];
let nextRequestId = 1;
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.dispose();
});

function testSocketPath(): () => string {
  return defaultSocketPathFactory(tmpdir());
}

function isExpectedWindowsPipeClose(error: Error & { code?: string }): boolean {
  return process.platform === 'win32' && ['EPIPE', 'ECONNRESET'].includes(error.code ?? '');
}

/** Sends one line and collects every line the server writes back before the socket closes (or a
 * short grace period elapses with no more data), then closes the connection. */
function roundTrip(
  socketPath: string,
  payload: unknown,
  graceMs = 300,
): Promise<{ lines: string[]; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    const lines: string[] = [];
    let closed = false;
    const finish = () => {
      clearTimeout(graceTimer);
      resolve({ lines, closed });
    };
    const graceTimer = setTimeout(() => {
      socket.destroy();
      finish();
    }, graceMs);
    const request =
      typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? { requestId: `test-${nextRequestId++}`, ...payload }
        : payload;
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        lines.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        // Every request in this suite has exactly one response. Resolve as soon as that framed
        // response arrives instead of relying on a 300ms grace window, which is too short under
        // parallel Windows CI load and can produce an empty `lines` array.
        socket.destroy();
        finish();
        return;
      }
    });
    socket.once('close', () => {
      closed = true;
      finish();
    });
    socket.once('error', (error: Error & { code?: string }) => {
      if (!isExpectedWindowsPipeClose(error)) {
        reject(error);
        return;
      }
      closed = true;
      finish();
    });
  });
}

describe('defaultSocketPathFactory', () => {
  it('only returns candidates whose byte length fits the platform sun_path limit', () => {
    const factory = defaultSocketPathFactory(
      '/some/long/looking/app-user-data/directory/path',
      'darwin',
    );
    const path = factory();
    expect(Buffer.byteLength(path, 'utf8')).toBeLessThanOrEqual(100);
  });

  it('returns a named-pipe endpoint on Windows', () => {
    const factory = defaultSocketPathFactory('C:\\ignored', 'win32');
    expect(factory()).toMatch(/^\\\\\.\\pipe\\sc-team-[0-9a-f]{32}$/);
  });

  it('generates a fresh path on every call', () => {
    const factory = defaultSocketPathFactory('/tmp');
    expect(factory()).not.toBe(factory());
  });
});

describe('TeamMcpBridge', () => {
  it('authenticates and dispatches a catalog-bound managed coding tool', async () => {
    const executeManaged = vi.fn(async (input, context) => ({ input, context }));
    const bridge = new TeamMcpBridge(
      fakeCoordinator(),
      testSocketPath(),
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
    const token = TeamMcpBridge.generateToken();
    bridge.register('turn-managed', {
      taskId: 'task-managed',
      token,
      allowTeamTools: false,
      allowedTools: [],
      managedTools: [
        {
          name: 'read_file',
          description: 'Read a managed file',
          inputSchema: { type: 'object' },
        },
      ],
      managedToolCatalogDigest: 'a'.repeat(64),
    });

    const authentication = await roundTrip(socketPath as string, {
      token,
      tool: '__authenticate__',
      args: {},
    });
    expect(JSON.parse(authentication.lines[0] as string)).toMatchObject({
      ok: true,
      result: {
        allowedTools: [],
        managedTools: [{ name: 'read_file' }],
        toolCatalogDigest: 'a'.repeat(64),
      },
    });

    const response = await roundTrip(socketPath as string, {
      token,
      tool: 'read_file',
      args: { path: 'README.md' },
    });
    expect(JSON.parse(response.lines[0] as string)).toMatchObject({
      ok: true,
      result: { input: { path: 'README.md' } },
    });
    expect(executeManaged).toHaveBeenCalledWith(
      { path: 'README.md' },
      expect.objectContaining({
        taskId: 'task-managed',
        turnId: 'turn-managed',
        toolName: 'read_file',
        catalogDigest: 'a'.repeat(64),
      }),
    );
  });

  it('rejects a copied bearer token until the runtime process is strongly bound', async () => {
    const coordinator = fakeCoordinator();
    const bridge = new ProductionTeamMcpBridge(coordinator, testSocketPath());
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    const token = ProductionTeamMcpBridge.generateToken();
    bridge.register('turn-unbound', { taskId: 'task-victim', token });

    const { lines, closed } = await roundTrip(
      socketPath as string,
      {
        token,
        tool: '__authenticate__',
        args: {},
      },
      1_000,
    );

    expect(lines).toHaveLength(0);
    expect(closed).toBe(true);
  });

  it('rejects a stolen token from outside the registered CLI process tree', async () => {
    const coordinator = fakeCoordinator();
    const bridge = new ProductionTeamMcpBridge(coordinator, testSocketPath());
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    const token = ProductionTeamMcpBridge.generateToken();
    const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      stdio: 'ignore',
    });
    await new Promise<void>((resolve, reject) => {
      victim.once('spawn', resolve);
      victim.once('error', reject);
    });
    try {
      const victimIdentity = queryNativeProcessIdentity(victim.pid!);
      expect(victimIdentity).not.toBeNull();
      bridge.register('turn-victim', { taskId: 'task-victim', token });
      expect(bridge.bindRuntimeProcess('turn-victim', victimIdentity!)).toBe(true);

      // The test process owns the copied settings/token but is the victim CLI's parent, not one
      // of its descendants. A token-only bridge would accept this request.
      const { lines, closed } = await roundTrip(socketPath as string, {
        token,
        tool: '__authenticate__',
        args: {},
      });
      expect(lines).toHaveLength(0);
      expect(closed).toBe(true);
    } finally {
      victim.kill();
      await new Promise<void>((resolve) => victim.once('exit', () => resolve()));
    }
  });

  it('rejects stale and PID-reused runtime identities before registration is activated', async () => {
    const bridge = new ProductionTeamMcpBridge(fakeCoordinator(), testSocketPath());
    bridges.push(bridge);
    const current = queryNativeProcessIdentity(process.pid);
    expect(current).not.toBeNull();
    bridge.register('turn-reused', {
      taskId: 'task-reused',
      token: ProductionTeamMcpBridge.generateToken(),
    });
    expect(
      bridge.bindRuntimeProcess('turn-reused', {
        ...current!,
        startIdentity: `${current!.startIdentity}-reused`,
      }),
    ).toBe(false);

    const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      exited.once('exit', () => resolve());
      exited.once('error', reject);
    });
    expect(
      bridge.bindRuntimeProcess('turn-reused', {
        pid: exited.pid!,
        parentPid: process.pid,
        startIdentity: 'already-exited',
      }),
    ).toBe(false);
  });

  it('accepts a legitimate MCP client that is a descendant of the bound CLI process', async () => {
    const bridge = new TeamMcpBridge(fakeCoordinator(), testSocketPath());
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    const token = TeamMcpBridge.generateToken();
    bridge.register('turn-child', { taskId: 'task-child', token });
    const script = String.raw`
const { createConnection } = require('node:net');
const socket = createConnection(process.env.TEST_TEAM_SOCKET);
const timer = setTimeout(() => process.exit(2), 5000);
socket.once('connect', () => socket.write(process.env.TEST_TEAM_REQUEST + '\n'));
socket.once('data', (chunk) => {
  clearTimeout(timer);
  process.stdout.write(chunk);
  socket.destroy();
});
socket.once('error', (error) => {
  clearTimeout(timer);
  process.stderr.write(error.message);
  process.exit(1);
});
`;
    const request = JSON.stringify({
      requestId: 'legitimate-child',
      token,
      tool: '__authenticate__',
      args: {},
    });
    const child = spawn(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        TEST_TEAM_SOCKET: socketPath as string,
        TEST_TEAM_REQUEST: request,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
        child.once('error', reject);
        child.once('exit', (code) => resolve({ code, stdout, stderr }));
      },
    );

    expect(result, result.stderr).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({
      requestId: 'legitimate-child',
      ok: true,
      result: { authenticated: true },
    });
  });

  it('returns registered tool capabilities during authentication', async () => {
    const bridge = new TeamMcpBridge(fakeCoordinator(), testSocketPath());
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    const token = TeamMcpBridge.generateToken();
    bridge.register('turn-project-memory', {
      taskId: 'task-1',
      token,
      allowProjectMemory: true,
      allowTeamTools: false,
    });

    const response = await roundTrip(socketPath as string, {
      token,
      tool: '__authenticate__',
      args: {},
    });

    expect(JSON.parse(response.lines[0] as string)).toMatchObject({
      ok: true,
      result: {
        authenticated: true,
        capabilities: { projectMemory: true, skillDrafts: false, teamTools: false },
        allowedTools: PROJECT_MEMORY_MCP_TOOL_NAMES,
      },
    });
  });

  it('returns the exact Worker role inventory without the Manager-only hire tool', async () => {
    const bridge = new TeamMcpBridge(fakeCoordinator(), testSocketPath());
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    const token = TeamMcpBridge.generateToken();
    bridge.register('turn-worker-inventory', {
      taskId: 'task-1',
      token,
      role: 'worker',
      allowTeamTools: true,
      allowedTools: WORKER_TEAM_MCP_TOOL_NAMES,
    });

    const response = await roundTrip(socketPath as string, {
      token,
      tool: '__authenticate__',
      args: {},
    });

    const result = JSON.parse(response.lines[0] as string).result as {
      allowedTools: string[];
    };
    expect(result.allowedTools).toEqual(WORKER_TEAM_MCP_TOOL_NAMES);
    expect(result.allowedTools).not.toContain('team_hire_worker');
  });

  it('closes accepted sockets during dispose instead of hanging app shutdown', async () => {
    const bridge = new TeamMcpBridge(fakeCoordinator(), testSocketPath());
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    expect(socketPath).not.toBeNull();
    const socket = createConnection(socketPath as string);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const clientClosed = new Promise<string>((resolve) =>
      socket.once('close', () => resolve('closed')),
    );

    await expect(
      Promise.race([
        bridge.dispose().then(() => 'disposed'),
        new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 500)),
      ]),
    ).resolves.toBe('disposed');
    await expect(
      Promise.race([
        clientClosed,
        new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 500)),
      ]),
    ).resolves.toBe('closed');
    expect(socket.destroyed).toBe(true);
  });

  it('closes an unauthenticated connection after a bounded grace period', async () => {
    const bridge = new TeamMcpBridge(fakeCoordinator(), testSocketPath(), 25);
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    expect(socketPath).not.toBeNull();

    const socket = createConnection(socketPath as string);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('connection was not closed')), 500);
      socket.once('error', (error: Error & { code?: string }) => {
        if (isExpectedWindowsPipeClose(error)) {
          clearTimeout(timeout);
          resolve();
        } else reject(error);
      });
      socket.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    expect(socket.destroyed).toBe(true);
  });

  it('closes a connection whose pending request exceeds the input limit', async () => {
    const bridge = new TeamMcpBridge(fakeCoordinator(), testSocketPath());
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    expect(socketPath).not.toBeNull();

    const socket = createConnection(socketPath as string);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('oversized connection was not closed')),
        500,
      );
      socket.once('connect', () => socket.write(Buffer.alloc(1024 * 1024 + 1, 'x')));
      socket.once('error', (error: Error & { code?: string }) => {
        if (isExpectedWindowsPipeClose(error)) {
          clearTimeout(timeout);
          resolve();
        } else reject(error);
      });
      socket.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    expect(socket.destroyed).toBe(true);
  });

  it('forwards a call authenticated with the registered token to executeTeamTool', async () => {
    // team_stop_worker (not team_hire_worker) deliberately: executeTeamTool's hire branch pauses
    // for HIRE_PACING_MS (production-default 1200ms, a deliberate anti-"instant burst" cadence —
    // see team-tools.ts) before resolving, which would make this a slow, timing-fragile test for
    // a property team-tools-execute.test.ts already covers directly. Auth/forwarding is
    // tool-agnostic, so any tool proves the same thing here.
    const coordinator = fakeCoordinator();
    const bridge = new TeamMcpBridge(coordinator, testSocketPath());
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    expect(socketPath).not.toBeNull();
    const token = TeamMcpBridge.generateToken();
    bridge.register('turn-1', { taskId: 'task-1', token });

    const { lines, closed } = await roundTrip(socketPath as string, {
      token,
      tool: 'team_stop_worker',
      args: { workerId: 'worker-1' },
    });
    expect(closed).toBe(false);
    expect(lines).toHaveLength(1);
    const response = JSON.parse(lines[0] as string) as {
      ok: boolean;
      result: { workerId: string };
    };
    expect(response.ok).toBe(true);
    expect(response.result.workerId).toBe('worker-1');
    expect(coordinator.stopWorker).toHaveBeenCalledWith('task-1', 'worker-1');
  });

  it('rejects a leaf Worker that calls hire directly through the bridge', async () => {
    const coordinator = fakeCoordinator();
    const bridge = new TeamMcpBridge(coordinator, testSocketPath());
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    const token = TeamMcpBridge.generateToken();
    bridge.register('turn-worker', {
      taskId: 'task-1',
      token,
      requesterAgentId: 'worker-1',
      role: 'worker',
      allowedTools: ['team_send_message', 'team_get_status'],
    });

    const { lines, closed } = await roundTrip(socketPath as string, {
      token,
      tool: 'team_hire_worker',
      args: { role: 'unauthorized', objective: 'escalate privileges' },
    });

    expect(closed).toBe(false);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      ok: false,
      error: 'Tool is not allowed for this Team MCP role',
    });
    expect(coordinator.hireWorker).not.toHaveBeenCalled();
    expect(coordinator.hireWorkerAs).not.toHaveBeenCalled();
  });

  it('fails closed when a registration omits its role', async () => {
    const coordinator = fakeCoordinator();
    const bridge = new TeamMcpBridge(coordinator, testSocketPath());
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    const token = TeamMcpBridge.generateToken();
    bridge.register('turn-missing-role', {
      taskId: 'task-1',
      token,
      requesterAgentId: 'worker-1',
      allowedTools: ['team_hire_worker', 'team_get_status'],
    });

    const { lines } = await roundTrip(socketPath as string, {
      token,
      tool: 'team_hire_worker',
      args: { role: 'unauthorized', objective: 'exploit a missing role' },
    });

    expect(JSON.parse(lines[0] as string)).toMatchObject({
      ok: false,
      error: 'Tool is not allowed for this Team MCP role',
    });
    expect(coordinator.hireWorkerAs).not.toHaveBeenCalled();
  });

  it('starts a new Turn report wait after the messages that already existed at registration', async () => {
    const listWorkerReports = vi.fn(
      () =>
        [
          {
            sourceAgentId: 'fresh-worker',
            seq: 8,
            content: 'fresh report',
            executionId: 'execution-2',
            attemptId: 'attempt-2',
          },
        ] as never,
    );
    const coordinator = fakeCoordinator({ listWorkerReports } as Partial<TeamCoordinator>);
    const bridge = new TeamMcpBridge(coordinator, testSocketPath());
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    const token = TeamMcpBridge.generateToken();
    bridge.register('turn-follow-up', {
      taskId: 'task-1',
      token,
      initialWaitCursor: 7,
    });

    await roundTrip(socketPath as string, {
      token,
      tool: 'team_wait_reports',
      args: {},
    });

    expect(listWorkerReports).toHaveBeenCalledWith('task-1', 7, undefined);
  });

  it('allows Draft creation only for a turn explicitly bound to skill-creator', async () => {
    const createSkillDraft = vi.fn(async (input: unknown) => ({
      id: 'draft-1',
      input,
    }));
    const bridge = new TeamMcpBridge(
      fakeCoordinator(),
      testSocketPath(),
      undefined,
      undefined,
      createSkillDraft,
    );
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    const deniedToken = TeamMcpBridge.generateToken();
    bridge.register('turn-denied', { taskId: 'task-1', token: deniedToken });
    const denied = await roundTrip(socketPath as string, {
      token: deniedToken,
      tool: 'skill_draft_create',
      args: { kind: 'chat', skillId: 'reviewer', files: [] },
    });
    expect(JSON.parse(denied.lines[0] as string)).toMatchObject({ ok: false });

    const allowedToken = TeamMcpBridge.generateToken();
    bridge.register('turn-allowed', {
      taskId: 'task-1',
      token: allowedToken,
      allowSkillDrafts: true,
    });
    const allowed = await roundTrip(socketPath as string, {
      token: allowedToken,
      tool: 'skill_draft_create',
      args: { kind: 'chat', skillId: 'reviewer', files: [{ path: 'SKILL.md', content: 'x' }] },
    });
    expect(JSON.parse(allowed.lines[0] as string)).toMatchObject({
      ok: true,
      result: { id: 'draft-1' },
    });
    expect(createSkillDraft).toHaveBeenCalledOnce();
  });

  it.skip('allows prepared Skill installation only for a turn explicitly bound to import-skill', async () => {
    const digest = 'a'.repeat(64);
    const installPreparedSkill = vi.fn(async (input: unknown) => ({
      enabled: true,
      input,
    }));
    const readImportSkillSource = vi.fn(async () => ({ digest, files: [] }));
    const bridge = new TeamMcpBridge(
      fakeCoordinator(),
      testSocketPath(),
      undefined,
      undefined,
      undefined,
      undefined,
      installPreparedSkill,
      readImportSkillSource,
    );
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    const deniedToken = TeamMcpBridge.generateToken();
    bridge.register('turn-denied', { taskId: 'task-1', token: deniedToken });
    const denied = await roundTrip(socketPath as string, {
      token: deniedToken,
      tool: 'skill_import_install',
      args: { kind: 'chat', skillId: 'writer', files: [] },
    });
    expect(JSON.parse(denied.lines[0] as string)).toMatchObject({ ok: false });

    const allowedToken = TeamMcpBridge.generateToken();
    bridge.register('turn-allowed', {
      taskId: 'task-1',
      token: allowedToken,
      // @ts-expect-error removed legacy capability fixture
      allowSkillImports: true,
      skillImportUserText: 'IMPORT_SKILL claude writer',
    });
    const read = await roundTrip(socketPath as string, {
      token: allowedToken,
      tool: 'skill_import_read',
      args: { cli: 'claude', skillId: 'writer' },
    });
    expect(JSON.parse(read.lines[0] as string)).toMatchObject({ ok: true });
    const mismatched = await roundTrip(socketPath as string, {
      token: allowedToken,
      tool: 'skill_import_install',
      args: {
        source: { cli: 'claude', skillId: 'writer', digest: 'f'.repeat(64) },
        kind: 'chat',
        skillId: 'writer',
        files: [{ path: 'SKILL.md', content: 'prepared' }],
      },
    });
    expect(JSON.parse(mismatched.lines[0] as string)).toMatchObject({ ok: false });
    const allowed = await roundTrip(socketPath as string, {
      token: allowedToken,
      tool: 'skill_import_install',
      args: {
        source: { cli: 'claude', skillId: 'writer', digest },
        kind: 'chat',
        skillId: 'writer',
        files: [{ path: 'SKILL.md', content: 'prepared' }],
      },
    });
    expect(JSON.parse(allowed.lines[0] as string)).toMatchObject({
      ok: true,
      result: { enabled: true },
    });
    const repeated = await roundTrip(socketPath as string, {
      token: allowedToken,
      tool: 'skill_import_install',
      args: {
        source: { cli: 'claude', skillId: 'writer', digest },
        kind: 'chat',
        skillId: 'another-writer',
        files: [{ path: 'SKILL.md', content: 'another prepared skill' }],
      },
    });
    expect(JSON.parse(repeated.lines[0] as string)).toMatchObject({ ok: false });
    expect(installPreparedSkill).toHaveBeenCalledOnce();
  });

  it.skip('allows safe source reading only for a turn explicitly bound to import-skill', async () => {
    const readImportSkillSource = vi.fn(async (input: unknown) => ({
      digest: 'b'.repeat(64),
      files: [],
      input,
    }));
    const bridge = new TeamMcpBridge(
      fakeCoordinator(),
      testSocketPath(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      readImportSkillSource,
    );
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    const token = TeamMcpBridge.generateToken();
    bridge.register('turn-import', {
      taskId: 'task-1',
      token,
      // @ts-expect-error removed legacy capability fixture
      allowSkillImports: true,
      skillImportUserText: 'IMPORT_SKILL claude writer',
    });

    const response = await roundTrip(socketPath as string, {
      token,
      tool: 'skill_import_read',
      args: { cli: 'claude', skillId: 'writer' },
    });

    expect(JSON.parse(response.lines[0] as string)).toMatchObject({
      ok: true,
      result: { files: [] },
    });
    expect(readImportSkillSource).toHaveBeenCalledWith(
      { cli: 'claude', skillId: 'writer' },
      { taskId: 'task-1', turnId: 'turn-import' },
    );
    const repeated = await roundTrip(socketPath as string, {
      token,
      tool: 'skill_import_read',
      args: { cli: 'claude', skillId: 'writer' },
    });
    expect(JSON.parse(repeated.lines[0] as string)).toMatchObject({ ok: false });
    expect(readImportSkillSource).toHaveBeenCalledOnce();
  });

  it('rejects Skill source access when the current user message is ambiguous', async () => {
    const readImportSkillSource = vi.fn(async () => ({ digest: 'c'.repeat(64), files: [] }));
    const bridge = new TeamMcpBridge(
      fakeCoordinator(),
      testSocketPath(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      readImportSkillSource,
    );
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    const token = TeamMcpBridge.generateToken();
    bridge.register('turn-import', {
      taskId: 'task-1',
      token,
      // @ts-expect-error removed legacy capability fixture
      allowSkillImports: true,
      skillImportUserText: 'Claude の skill は import しないで',
    });

    const response = await roundTrip(socketPath as string, {
      token,
      tool: 'skill_import_read',
      args: { cli: 'claude', skillId: 'skill' },
    });

    expect(JSON.parse(response.lines[0] as string)).toMatchObject({ ok: false });
    expect(readImportSkillSource).not.toHaveBeenCalled();
  });

  it('allows Project memory candidates only for an explicitly eligible Leader turn', async () => {
    const queueCandidate = vi.fn(async () => ({ queued: true }));
    const bridge = new TeamMcpBridge(
      fakeCoordinator(),
      testSocketPath(),
      undefined,
      undefined,
      undefined,
      queueCandidate,
    );
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    const deniedToken = TeamMcpBridge.generateToken();
    bridge.register('turn-denied', { taskId: 'task-1', token: deniedToken });
    const denied = await roundTrip(socketPath as string, {
      token: deniedToken,
      tool: 'project_memory_remember',
      args: { content: 'stable fact' },
    });
    expect(JSON.parse(denied.lines[0] as string)).toMatchObject({ ok: false });

    const allowedToken = TeamMcpBridge.generateToken();
    bridge.register('turn-allowed', {
      taskId: 'task-1',
      token: allowedToken,
      allowProjectMemory: true,
      allowTeamTools: false,
    });
    const allowed = await roundTrip(socketPath as string, {
      token: allowedToken,
      tool: 'project_memory_remember',
      args: { content: 'stable fact' },
    });
    expect(JSON.parse(allowed.lines[0] as string)).toMatchObject({
      ok: true,
      result: { queued: true },
    });
    expect(queueCandidate).toHaveBeenCalledWith(
      { content: 'stable fact' },
      { taskId: 'task-1', turnId: 'turn-allowed' },
    );
  });

  it('does not expose Team tools to a Skill Creator-only turn', async () => {
    const coordinator = fakeCoordinator();
    const bridge = new TeamMcpBridge(coordinator, testSocketPath());
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    const token = TeamMcpBridge.generateToken();
    bridge.register('turn-skill-creator', {
      taskId: 'task-1',
      token,
      allowSkillDrafts: true,
      allowTeamTools: false,
    });
    const response = await roundTrip(socketPath as string, {
      token,
      tool: 'team_stop_worker',
      args: { workerId: 'worker-1' },
    });
    expect(JSON.parse(response.lines[0] as string)).toMatchObject({ ok: false });
    expect(coordinator.stopWorker).not.toHaveBeenCalled();
  });

  it('binds model catalog lookup to the registered Task instead of model arguments', async () => {
    const listModelCandidates = vi.fn(async (input: unknown) => ({
      revision: 1,
      total: 1,
      items: [{ connectionId: 'builtin:codex-cli', modelId: 'gpt-5.6-sol' }],
      nextCursor: null,
      query: input,
    }));
    const bridge = new TeamMcpBridge(
      fakeCoordinator(),
      testSocketPath(),
      undefined,
      listModelCandidates,
    );
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    const token = TeamMcpBridge.generateToken();
    bridge.register('turn-models', { taskId: 'task-trusted', token });

    const { lines } = await roundTrip(socketPath as string, {
      token,
      tool: 'team_list_models',
      args: { capabilities: ['reasoning'], limit: 20 },
    });

    expect(JSON.parse(lines[0] as string)).toMatchObject({
      ok: true,
      result: { total: 1 },
    });
    expect(listModelCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-trusted',
        capabilities: ['reasoning'],
        limit: 20,
      }),
    );
  });

  it('binds Manager authority to the registered token rather than request arguments', async () => {
    const coordinator = fakeCoordinator();
    const bridge = new TeamMcpBridge(coordinator, testSocketPath());
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    const token = TeamMcpBridge.generateToken();
    bridge.register('turn-manager', {
      taskId: 'task-1',
      token,
      requesterAgentId: 'manager-1',
      contextOwner: { type: 'team_execution', id: 'parent-execution-1' },
    });

    const { lines } = await roundTrip(socketPath as string, {
      token,
      tool: 'team_assign_task',
      args: { workerId: 'worker-1', objective: '実装する', doneCriteria: ['完了'] },
    });
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      ok: true,
      result: { executionId: 'execution-1', state: 'queued' },
    });
    expect(coordinator.assignTaskAs).toHaveBeenCalledWith(
      {
        taskId: 'task-1',
        targetAgentId: 'worker-1',
        content: '実装する',
        doneCriteria: ['完了'],
        accessMode: 'read-only',
      },
      'manager-1',
      { type: 'team_execution', id: 'parent-execution-1' },
    );

    const blockedWrite = await roundTrip(socketPath as string, {
      token,
      tool: 'team_assign_task',
      args: {
        workerId: 'worker-1',
        objective: '書き込む',
        doneCriteria: ['完了'],
        access: 'workspace-write',
      },
    });
    expect(JSON.parse(blockedWrite.lines[0] as string)).toMatchObject({
      ok: true,
      result: { ok: false, message: expect.stringContaining('read-only') },
    });
    expect(coordinator.assignTaskAs).toHaveBeenCalledTimes(1);
  });

  it('closes the connection without responding to an unknown token', async () => {
    const coordinator = fakeCoordinator();
    const bridge = new TeamMcpBridge(coordinator, testSocketPath());
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    bridge.register('turn-1', { taskId: 'task-1', token: TeamMcpBridge.generateToken() });

    const { lines, closed } = await roundTrip(socketPath as string, {
      token: 'attacker-guessed-token-that-is-wrong',
      tool: 'team_hire_worker',
      args: { role: 'x', objective: 'y' },
    });
    expect(lines).toHaveLength(0);
    expect(closed).toBe(true);
    expect(coordinator.hireWorker).not.toHaveBeenCalled();
  });

  it('rejects a token whose length differs from any registered token (no timingSafeEqual crash)', async () => {
    const coordinator = fakeCoordinator();
    const bridge = new TeamMcpBridge(coordinator, testSocketPath());
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    bridge.register('turn-1', { taskId: 'task-1', token: TeamMcpBridge.generateToken() });

    const { lines, closed } = await roundTrip(socketPath as string, {
      token: 'short',
      tool: 'team_hire_worker',
      args: {},
    });
    expect(lines).toHaveLength(0);
    expect(closed).toBe(true);
  });

  it('rejects calls for a turn that was already unregistered', async () => {
    const coordinator = fakeCoordinator();
    const bridge = new TeamMcpBridge(coordinator, testSocketPath());
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    const token = TeamMcpBridge.generateToken();
    bridge.register('turn-1', { taskId: 'task-1', token });
    bridge.unregister('turn-1');

    const { lines, closed } = await roundTrip(socketPath as string, {
      token,
      tool: 'team_hire_worker',
      args: { role: 'x', objective: 'y' },
    });
    expect(lines).toHaveLength(0);
    expect(closed).toBe(true);
    expect(coordinator.hireWorker).not.toHaveBeenCalled();
  });

  it('reports an unregistered tool as {ok:false} rather than crashing the connection', async () => {
    const coordinator = fakeCoordinator();
    const bridge = new TeamMcpBridge(coordinator, testSocketPath());
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    const token = TeamMcpBridge.generateToken();
    bridge.register('turn-1', { taskId: 'task-1', token });

    const { lines, closed } = await roundTrip(socketPath as string, {
      token,
      tool: 'team_not_a_real_tool',
      args: {},
    });
    expect(closed).toBe(false);
    const response = JSON.parse(lines[0] as string) as { ok: false; error: string };
    expect(response.ok).toBe(false);
    expect(response.error).toContain('Tool is not allowed');
  });

  it('ensureStarted is idempotent and returns the same socket across calls', async () => {
    const bridge = new TeamMcpBridge(fakeCoordinator(), testSocketPath());
    bridges.push(bridge);
    const first = await bridge.ensureStarted();
    const second = await bridge.ensureStarted();
    expect(first).toBe(second);
  });
});

describe.runIf(process.platform === 'win32')('TeamMcpBridge Windows DACL', () => {
  it('serves authenticated requests through the user-scoped named pipe', async () => {
    const bridge = new TeamMcpBridge(
      fakeCoordinator(),
      defaultSocketPathFactory('C:\\ignored', 'win32'),
    );
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    expect(socketPath).not.toBeNull();
    const token = TeamMcpBridge.generateToken();
    bridge.register('turn-windows', { taskId: 'task-windows', token });
    const response = await roundTrip(socketPath as string, {
      token,
      tool: '__authenticate__',
      args: {},
    });
    expect(response.lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({ authenticated: true }),
      }),
    );
  });

  it('accepts rapid sequential reconnects on the same named pipe', async () => {
    const bridge = new TeamMcpBridge(
      fakeCoordinator(),
      defaultSocketPathFactory('C:\\ignored', 'win32'),
    );
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    const token = TeamMcpBridge.generateToken();
    bridge.register('turn-windows-reconnect', { taskId: 'task-windows', token });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await roundTrip(socketPath as string, {
        token,
        tool: '__authenticate__',
        args: {},
      });
      expect(response.lines.map((line) => JSON.parse(line))).toContainEqual(
        expect.objectContaining({
          ok: true,
          result: expect.objectContaining({ authenticated: true }),
        }),
      );
    }
  });

  it('accepts a Leader and three Workers concurrently', async () => {
    const bridge = new TeamMcpBridge(
      fakeCoordinator(),
      defaultSocketPathFactory('C:\\ignored', 'win32'),
    );
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    const registrations = ['leader', 'worker-1', 'worker-2', 'worker-3'].map((name) => {
      const token = TeamMcpBridge.generateToken();
      bridge.register(`turn-${name}`, {
        taskId: 'task-windows',
        token,
        ...(name === 'leader' ? {} : { requesterAgentId: name }),
      });
      return token;
    });

    const responses = await Promise.all(
      registrations.map((token) =>
        roundTrip(socketPath as string, {
          token,
          tool: '__authenticate__',
          args: {},
        }),
      ),
    );
    for (const response of responses)
      expect(JSON.parse(response.lines[0] as string)).toMatchObject({
        ok: true,
        result: { authenticated: true },
      });
  });

  it('caps active pipe instances and accepts another client after a slot is released', async () => {
    const bridge = new TeamMcpBridge(
      fakeCoordinator(),
      defaultSocketPathFactory('C:\\ignored', 'win32'),
    );
    bridges.push(bridge);
    const socketPath = (await bridge.ensureStarted()) as string;
    const token = TeamMcpBridge.generateToken();
    bridge.register('turn-windows-capacity', { taskId: 'task-windows', token });
    const sockets: ReturnType<typeof createConnection>[] = [];

    try {
      for (let index = 0; index < 16; index += 1) {
        const socket = createConnection(socketPath);
        await new Promise<void>((resolve, reject) => {
          socket.once('connect', resolve);
          socket.once('error', reject);
        });
        sockets.push(socket);
      }

      const waitingSocket = createConnection(socketPath);
      sockets.push(waitingSocket);
      let connected = false;
      const connectedAfterRelease = new Promise<void>((resolve, reject) => {
        waitingSocket.once('connect', () => {
          connected = true;
          resolve();
        });
        waitingSocket.once('error', reject);
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(connected).toBe(false);

      sockets[0]?.destroy();
      await Promise.race([
        connectedAfterRelease,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('waiting pipe client was not accepted')), 2_000),
        ),
      ]);

      const response = new Promise<string>((resolve, reject) => {
        let buffer = '';
        waitingSocket.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const newline = buffer.indexOf('\n');
          if (newline >= 0) resolve(buffer.slice(0, newline));
        });
        waitingSocket.once('error', reject);
      });
      waitingSocket.write(
        `${JSON.stringify({
          requestId: 'windows-capacity',
          token,
          tool: '__authenticate__',
          args: {},
        })}\n`,
      );
      await expect(response.then((line) => JSON.parse(line))).resolves.toMatchObject({
        ok: true,
        result: { authenticated: true },
      });
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  });

  it('invalidates and restarts the named-pipe broker after an unexpected exit', async () => {
    const bridge = new TeamMcpBridge(
      fakeCoordinator(),
      defaultSocketPathFactory('C:\\ignored', 'win32'),
    );
    bridges.push(bridge);
    const firstSocketPath = await bridge.ensureStarted();
    const firstBroker = (bridge as unknown as { windowsBroker: ChildProcess | null }).windowsBroker;
    expect(firstBroker).not.toBeNull();
    const exited = new Promise<void>((resolve) => firstBroker?.once('exit', () => resolve()));
    firstBroker?.kill();
    await exited;

    expect(bridge.socketPath).toBeNull();
    const secondSocketPath = await bridge.ensureStarted();
    expect(secondSocketPath).not.toBeNull();
    expect(secondSocketPath).not.toBe(firstSocketPath);
    const token = TeamMcpBridge.generateToken();
    bridge.register('turn-windows-restarted', { taskId: 'task-windows', token });
    const response = await roundTrip(secondSocketPath as string, {
      token,
      tool: '__authenticate__',
      args: {},
    });
    expect(JSON.parse(response.lines[0] as string)).toMatchObject({
      ok: true,
      result: { authenticated: true },
    });
  });

  it('does not let a disposed broker close connections owned by its replacement', async () => {
    const bridge = new TeamMcpBridge(
      fakeCoordinator(),
      defaultSocketPathFactory('C:\\ignored', 'win32'),
    );
    bridges.push(bridge);
    const firstSocketPath = await bridge.ensureStarted();
    const firstBroker = (bridge as unknown as { windowsBroker: ChildProcess | null }).windowsBroker;
    if (firstBroker === null) throw new Error('expected the first Windows pipe broker');
    const killFirstBroker = firstBroker.kill.bind(firstBroker);
    vi.spyOn(firstBroker, 'kill').mockReturnValue(true);
    const firstBrokerExited = new Promise<void>((resolve) =>
      firstBroker.once('exit', () => resolve()),
    );

    await bridge.dispose();
    const staleSocket = createConnection(firstSocketPath as string);
    await new Promise<void>((resolve, reject) => {
      staleSocket.once('connect', resolve);
      staleSocket.once('error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const staleConnectionCount = (bridge as unknown as { windowsConnections: Map<string, unknown> })
      .windowsConnections.size;
    staleSocket.destroy();

    const secondSocketPath = await bridge.ensureStarted();
    const socket = createConnection(secondSocketPath as string);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });

      killFirstBroker();
      await firstBrokerExited;
      expect(staleConnectionCount).toBe(0);

      const token = TeamMcpBridge.generateToken();
      bridge.register('turn-windows-replacement', { taskId: 'task-windows', token });
      const response = new Promise<string>((resolve, reject) => {
        let buffer = '';
        socket.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const newline = buffer.indexOf('\n');
          if (newline >= 0) resolve(buffer.slice(0, newline));
        });
        socket.once('close', () => reject(new Error('replacement broker connection closed')));
        socket.once('error', reject);
      });
      socket.write(
        `${JSON.stringify({
          requestId: 'windows-replacement',
          token,
          tool: '__authenticate__',
          args: {},
        })}\n`,
      );
      await expect(response.then((line) => JSON.parse(line))).resolves.toMatchObject({
        ok: true,
        result: { authenticated: true },
      });
    } finally {
      socket.destroy();
    }
  });

  it('serves Worker messages while the Leader is waiting for reports', async () => {
    let busy = true;
    const coordinator = fakeCoordinator({
      hasBusyWorkers: vi.fn(() => busy),
      listAgentMessages: vi.fn(() => []),
    });
    const bridge = new TeamMcpBridge(coordinator, defaultSocketPathFactory('C:\\ignored', 'win32'));
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    const leaderToken = TeamMcpBridge.generateToken();
    const workerToken = TeamMcpBridge.generateToken();
    bridge.register('turn-leader-wait', { taskId: 'task-windows', token: leaderToken });
    bridge.register('turn-worker-read', {
      taskId: 'task-windows',
      token: workerToken,
      requesterAgentId: 'worker-1',
    });

    const leaderWait = roundTrip(
      socketPath as string,
      {
        token: leaderToken,
        tool: 'team_wait_reports',
        args: {},
      },
      1_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const workerRead = await roundTrip(socketPath as string, {
      token: workerToken,
      tool: 'team_read_messages',
      args: {},
    });
    expect(JSON.parse(workerRead.lines[0] as string)).toMatchObject({
      ok: true,
      result: { ok: true, messages: [] },
    });
    busy = false;
    await expect(leaderWait).resolves.toMatchObject({ lines: [expect.any(String)] });
  });
});

import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamMcpBridge, defaultSocketPathFactory } from './team-mcp-bridge';
import type { TeamCoordinator } from './team-coordinator';

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

  it('reports a coordinator/tool error as {ok:false} rather than crashing the connection', async () => {
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
    expect(response.error).toContain('Unknown team tool');
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
      expect.objectContaining({ ok: true, result: { authenticated: true } }),
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
        expect.objectContaining({ ok: true, result: { authenticated: true } }),
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

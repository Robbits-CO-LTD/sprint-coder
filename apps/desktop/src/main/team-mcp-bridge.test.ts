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
    hasBusyWorkers: vi.fn(() => false),
    stopWorker: vi.fn(async () => ({ id: 'worker-1', state: 'stopped' }) as never),
    ...overrides,
  } as unknown as TeamCoordinator;
}

const bridges: TeamMcpBridge[] = [];
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.dispose();
});

function testSocketPath(): () => string {
  return defaultSocketPathFactory(tmpdir());
}

/** Sends one line and collects every line the server writes back before the socket closes (or a
 * short grace period elapses with no more data), then closes the connection. */
function roundTrip(
  socketPath: string,
  payload: unknown,
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
    }, 300);
    socket.once('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
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
    socket.once('error', reject);
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
  it('closes an unauthenticated connection after a bounded grace period', async () => {
    const bridge = new TeamMcpBridge(fakeCoordinator(), testSocketPath(), 25);
    bridges.push(bridge);
    const socketPath = await bridge.ensureStarted();
    expect(socketPath).not.toBeNull();

    const socket = createConnection(socketPath as string);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('connection was not closed')), 500);
      socket.once('error', reject);
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
      socket.once('error', reject);
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
      },
      'manager-1',
    );
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
    expect(response.lines.map((line) => JSON.parse(line))).toContainEqual({
      ok: true,
      result: { authenticated: true },
    });
  });
});

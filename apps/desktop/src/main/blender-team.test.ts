import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BlenderTeamConnection,
  blenderEditInputSchema,
  blenderObserveInputSchema,
} from './blender-team';

import { TeamMcpBridge, defaultSocketPathFactory } from './team-mcp-bridge';
import { queryNativeProcessIdentity } from './native-process-identity';
import type { TeamCoordinator } from './team-coordinator';
import type { BlenderTeamToolName } from '../runtime-host/team-mcp-tool-contract';

async function callMcp(path: string, token: string, tool: BlenderTeamToolName, args: unknown) {
  const socket = createConnection(path);
  const lines = createInterface({ input: socket });
  try {
    return await new Promise<{
      ok: boolean;
      error?: string;
      result?: { target: string; observation?: string; face_count?: number; dataUrl?: string };
    }>((resolve, reject) => {
      socket.setTimeout(12_000, () => reject(new Error('Team MCP timed out')));
      socket.once('error', reject);
      socket.once('close', () => reject(new Error('Team MCP disconnected')));
      socket.once('connect', () =>
        socket.write(JSON.stringify({ requestId: 'blender-test', token, tool, args }) + '\n'),
      );
      lines.once('line', (line) => {
        try {
          resolve(JSON.parse(line));
        } catch (error) {
          reject(error);
        }
      });
    });
  } finally {
    lines.close();
    socket.destroy();
  }
}

describe('Blender Team tools', () => {
  it('allows only the target-independent observation parameters and bounded mesh operations', () => {
    expect(blenderObserveInputSchema.safeParse({ azimuth: 30, elevation: 45 }).success).toBe(true);
    expect(
      blenderObserveInputSchema.safeParse({ azimuth: 30, elevation: 45, slot: 2 }).success,
    ).toBe(false);
    const edit = { observation: 'a'.repeat(32), operation: 'move' };
    expect(blenderEditInputSchema.safeParse({ ...edit, value: [1, 0, 0] }).success).toBe(true);
    expect(blenderEditInputSchema.safeParse({ ...edit, value: [1000, 0, 0] }).success).toBe(false);
    expect(
      blenderEditInputSchema.safeParse({ ...edit, value: [1, 0, 0], worker: 'other' }).success,
    ).toBe(false);
  });
});

const blenderExecutable = process.env['SPRINT_CODER_TEST_BLENDER_EXECUTABLE'];
const fixture = resolve(
  import.meta.dirname,
  '../../../../integrations/blender/tests/bridge_fixture.py',
);
let processHandle: ChildProcess | undefined;
let tempDir: string | undefined;
let connection: BlenderTeamConnection | undefined;
let mcp: TeamMcpBridge | undefined;

afterEach(async () => {
  connection?.close();
  await mcp?.dispose();
  if (processHandle?.exitCode === null && processHandle.signalCode === null) {
    const child = processHandle;
    await new Promise<void>((done) => {
      child.once('exit', () => done());
      child.kill();
    });
  }
  if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
});

it.skipIf(blenderExecutable === undefined)(
  'pairs with Blender and returns ten separate editable GPU views',
  async () => {
    if (blenderExecutable === undefined) throw new Error('Blender is required');
    tempDir = await mkdtemp(join(tmpdir(), 'sc-blender-test-'));
    const pairingPath = join(tempDir, 'pairing-code');
    processHandle = spawn(
      blenderExecutable,
      ['--factory-startup', '--python-exit-code', '1', '--python', fixture, '--', pairingPath],
      { stdio: 'ignore' },
    );

    await expect
      .poll(
        async () => {
          try {
            return (await readFile(pairingPath, 'utf8')).startsWith('blender1:');
          } catch {
            return false;
          }
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    const code = await readFile(pairingPath, 'utf8');
    const signal = AbortSignal.timeout(35_000);
    const team = await BlenderTeamConnection.pair(code, signal);
    connection = team;
    expect(team.targets).toHaveLength(10);
    await expect(BlenderTeamConnection.pair(code, signal)).rejects.toThrow(
      'pairing code or session',
    );

    mcp = new TeamMcpBridge({} as TeamCoordinator, defaultSocketPathFactory(tempDir));
    const path = await mcp.ensureStarted();
    if (path === null) throw new Error('The Team MCP bridge did not start');
    const identity = queryNativeProcessIdentity(process.pid);
    if (identity === null) throw new Error('The native Team identity module is required');
    const workers = Array.from({ length: 10 }, (_, index) => {
      const worker = `worker-${index}`;
      const token = TeamMcpBridge.generateToken();
      mcp!.register(worker, {
        taskId: 'blender-test-team',
        role: 'worker',
        requesterAgentId: worker,
        token,
        blenderEnabled: true,
        blenderConnection: team,
      });
      expect(mcp!.bindRuntimeProcess(worker, identity)).toBe(true);
      return { worker, token };
    });
    const outsider = TeamMcpBridge.generateToken();
    mcp.register('other-team', {
      taskId: 'other-team',
      role: 'worker',
      requesterAgentId: 'outsider',
      token: outsider,
    });
    expect(mcp.bindRuntimeProcess('other-team', identity)).toBe(true);
    expect(
      await callMcp(path, outsider, 'blender_observe', { azimuth: 30, elevation: 24 }),
    ).toMatchObject({ ok: false });

    const first = await Promise.all(
      workers.map(({ token }, index) =>
        callMcp(path, token, 'blender_observe', {
          azimuth: index * 36,
          elevation: 24,
          faceIndex: 2,
        }),
      ),
    );
    expect(first.every((reply) => reply.ok && reply.result?.dataUrl !== undefined)).toBe(true);
    expect(new Set(first.map(({ result }) => result?.dataUrl)).size).toBe(10);
    expect(new Set(first.map(({ result }) => result?.target)).size).toBe(10);
    const wrongWorker = await callMcp(path, workers[1]!.token, 'blender_edit', {
      operation: 'move',
      value: [0, 0, 1],
      observation: first[0]?.result?.observation,
    });
    expect(wrongWorker).toMatchObject({
      ok: false,
      error: 'Observation expired or belongs to a different Worker or Turn',
    });

    const edits = await Promise.all(
      workers.map(({ token }, index) =>
        callMcp(path, token, 'blender_edit', {
          operation: 'extrude',
          value: (index + 1) / 10,
          observation: first[index]?.result?.observation,
        }),
      ),
    );
    expect(edits.every(({ ok }) => ok)).toBe(true);
    const updated = await Promise.all(
      workers.map(({ token }, index) =>
        callMcp(path, token, 'blender_observe', { azimuth: index * 36, elevation: 24 }),
      ),
    );
    expect(updated.every(({ ok, result }) => ok && result?.face_count === 10)).toBe(true);
    expect(
      updated.every(({ result }, index) => result?.dataUrl !== first[index]?.result?.dataUrl),
    ).toBe(true);
    mcp.unregister(workers[0]!.worker);
    await expect(
      callMcp(path, workers[0]!.token, 'blender_edit', {
        operation: 'move',
        value: [0, 0, 1],
        observation: updated[0]?.result?.observation,
      }),
    ).rejects.toThrow();
    team.close();
    await expect(
      team.call('worker-0', 'blender_observe', { azimuth: 0, elevation: 24 }, signal),
    ).rejects.toThrow();
    await expect.poll(() => team.isAvailable()).toBe(false);
  },
  45_000,
);

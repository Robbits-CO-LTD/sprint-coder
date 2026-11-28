import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection, createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BlenderTeamConnection,
  blenderEditInputSchema,
  blenderObserveInputSchema,
} from './blender-team';

import { TeamMcpBridge, defaultSocketPathFactory } from './team-mcp-bridge';
import { queryNativeProcessIdentity } from './native-process-identity';
import { TeamCoordinator } from './team-coordinator';
import {
  BLENDER_TEAM_MCP_TOOLS,
  type BlenderTeamToolName,
} from '../runtime-host/team-mcp-tool-contract';
import { CodexRuntimeAdapter } from '../runtime-host/codex-adapter';

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
  it('allows named mesh requests and bounded edit parameters', () => {
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

it('retries release before a replacement claims the same Blender target', async () => {
  let attempts = 0;
  let bound: string | undefined;
  const server = createServer((socket) => {
    const lines = createInterface({ input: socket });
    lines.once('line', (line) => {
      const request = JSON.parse(line) as { method: string; worker: string };
      let result: unknown;
      switch (request.method) {
        case 'pair':
          result = { token: 't'.repeat(43), targets: ['Roof'] };
          break;
        case 'bind':
          if (bound !== undefined && bound !== request.worker) {
            socket.end(
              JSON.stringify({ ok: false, error: 'Slot already belongs to a Worker' }) + '\n',
            );
            return;
          }
          bound = request.worker;
          result = { bound: true };
          break;
        case 'release':
          if (++attempts === 1) {
            socket.destroy();
            return;
          }
          bound = undefined;
          result = { released: true };
          break;
        case 'observe':
          result = {
            observation: 'q'.repeat(32),
            target: 'Roof',
            location: [0, 0, 0],
            face_count: 0,
            faces: [],
            face_index: null,
            dataUrl: 'data:image/png;base64,QUFB',
          };
          break;
      }
      socket.end(JSON.stringify({ ok: true, result }) + '\n');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const endpoint = server.address();
    if (endpoint === null || typeof endpoint === 'string')
      throw new Error('Listening port required');
    const signal = AbortSignal.timeout(5_000);
    const team = await BlenderTeamConnection.pair(
      `blender1:${endpoint.port}:${'t'.repeat(43)}`,
      signal,
    );
    const observe = { azimuth: 0, elevation: 20, target: 'Roof' };
    await team.call('before', 'blender_observe', observe, signal);
    await expect(team.releaseWorker('before')).rejects.toThrow('Blender disconnected');
    await expect(team.call('after', 'blender_observe', observe, signal)).resolves.toMatchObject({
      target: 'Roof',
    });
    expect(attempts).toBe(2);
    expect(bound).toBe('after');
  } finally {
    await new Promise<void>((done, reject) =>
      server.close((error) => (error === undefined ? done() : reject(error))),
    );
  }
});

it.each(['done', 'failed'])(
  'waits for Blender release when stopping a %s Worker',
  async (state) => {
    const worker = { id: 'worker', kind: 'worker', state };
    const publish = vi.fn();
    const release = vi
      .fn()
      .mockRejectedValueOnce(new Error('Blender Worker stop is unconfirmed'))
      .mockResolvedValueOnce(undefined);
    const coordinator = Object.create(TeamCoordinator.prototype) as TeamCoordinator;
    Object.assign(coordinator, {
      enqueue: (_task: string, work: () => Promise<unknown>) => work(),
      cancelWorkerExecutions: async () => undefined,
      releaseBlenderWorker: release,
      workerSummary: () => worker,
      now: () => new Date(0),
      emit: publish,
      persistence: {
        getTeamByTask: () => ({ id: 'team' }),
        getTeamSnapshot: () => ({ agents: [worker] }),
        setWorkerCurrentActivity: () => undefined,
      },
    });
    await expect(coordinator.stopWorker('task', worker.id)).rejects.toThrow(
      'Blender Worker stop is unconfirmed',
    );
    expect(publish).not.toHaveBeenCalled();
    await expect(coordinator.stopWorker('task', worker.id)).resolves.toMatchObject({ state });
    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenLastCalledWith('task', worker.id);
    expect(publish).toHaveBeenCalledOnce();
  },
);

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

async function startBlender(visualWorker = false) {
  if (blenderExecutable === undefined) throw new Error('Blender is required');
  tempDir = await mkdtemp(join(tmpdir(), 'sc-blender-test-'));
  const pairingPath = join(tempDir, 'pairing-code');
  processHandle = spawn(
    blenderExecutable,
    [
      '--factory-startup',
      '--python-exit-code',
      '1',
      '--python',
      fixture,
      '--',
      ...(visualWorker ? ['--visual-worker'] : []),
      pairingPath,
    ],
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
  return { code, directory: tempDir };
}

it.skipIf(blenderExecutable === undefined)(
  'pairs with Blender and returns ten separate editable GPU views',
  async () => {
    const { code, directory } = await startBlender();
    const signal = AbortSignal.timeout(35_000);
    const team = await BlenderTeamConnection.pair(code, signal);
    connection = team;
    expect(team.targets).toHaveLength(10);
    await expect(BlenderTeamConnection.pair(code, signal)).rejects.toThrow(
      'pairing code or session',
    );

    mcp = new TeamMcpBridge({} as TeamCoordinator, defaultSocketPathFactory(directory));
    const path = await mcp.ensureStarted();
    if (path === null) throw new Error('The Team MCP bridge did not start');
    const identity = queryNativeProcessIdentity(process.pid);
    if (identity === null) throw new Error('The native Team identity module is required');
    let allowImage = false;
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
        approveBlenderObservation: async () => allowImage,
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

    expect(
      await callMcp(path, workers[0]!.token, 'blender_observe', { azimuth: 30, elevation: 24 }),
    ).toMatchObject({ ok: false, error: 'Sending the Blender view was not approved' });
    allowImage = true;
    expect(
      await callMcp(path, workers[1]!.token, 'blender_observe', {
        azimuth: 30,
        elevation: 24,
        target: 'Outside selected scope',
      }),
    ).toMatchObject({ ok: false, error: 'Target is outside the paired Blender meshes' });

    const first = await Promise.all(
      workers.map(({ token }, index) =>
        callMcp(path, token, 'blender_observe', {
          azimuth: index * 36,
          elevation: 24,
          faceIndex: 2,
          target: team.targets[index],
        }),
      ),
    );
    expect(first.every((reply) => reply.ok && reply.result?.dataUrl !== undefined)).toBe(true);
    expect(new Set(first.map(({ result }) => result?.dataUrl)).size).toBe(10);
    expect(new Set(first.map(({ result }) => result?.target)).size).toBe(10);
    expect(
      await callMcp(path, workers[1]!.token, 'blender_observe', {
        azimuth: 30,
        elevation: 24,
        target: team.targets[0],
      }),
    ).toMatchObject({ ok: false, error: 'This Worker already has a different Blender target' });
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
    await team.releaseWorker(workers[0]!.worker);
    await expect(
      team.call(workers[0]!.worker, 'blender_observe', { azimuth: 0, elevation: 24 }, signal),
    ).rejects.toThrow('This Blender Worker was stopped');
    const replacement = await team.call(
      'replacement',
      'blender_observe',
      {
        azimuth: 0,
        elevation: 24,
        target: team.targets[0],
      },
      signal,
    );
    expect(replacement.target).toBe(team.targets[0]);
    team.close();
    await expect(
      team.call('worker-0', 'blender_observe', { azimuth: 0, elevation: 24 }, signal),
    ).rejects.toThrow();
    await expect.poll(() => team.isAvailable()).toBe(false);
  },
  45_000,
);

it.skipIf(blenderExecutable === undefined)(
  'keeps the assigned mesh visible when another mesh is closer to the camera',
  async () => {
    const { code } = await startBlender(true);
    const signal = AbortSignal.timeout(10_000);
    const blender = await BlenderTeamConnection.pair(code, signal);
    connection = blender;
    await blender.call('first', 'blender_observe', { azimuth: 45, elevation: 25 }, signal);
    await blender.call('second', 'blender_observe', { azimuth: 45, elevation: 25 }, signal);
    const image = await blender.call(
      'third',
      'blender_observe',
      { azimuth: 0, elevation: 0 },
      signal,
    );
    if (!('dataUrl' in image)) throw new Error('Blender returned no image');
    expect(image.target).toBe('Team demo 03');
    const pixel = await sharp(Buffer.from(image.dataUrl.split(',')[1]!, 'base64'))
      .extract({ left: 128, top: 72, width: 1, height: 1 })
      .raw()
      .toBuffer();
    expect(pixel[2]).toBeGreaterThan(pixel[0]!);
  },
);

const codexExecutable = process.env['SPRINT_CODER_TEST_BLENDER_CODEX'];

it.skipIf(blenderExecutable === undefined || !codexExecutable)(
  'runs ten real Codex Worker Turns that use different Blender images to decide and verify their edits',
  async () => {
    if (!codexExecutable) throw new Error('Codex CLI is required');
    const { code, directory } = await startBlender(true);
    const signal = AbortSignal.timeout(260_000);
    const team = await BlenderTeamConnection.pair(code, signal);
    connection = team;
    const bridge = new TeamMcpBridge({} as TeamCoordinator, defaultSocketPathFactory(directory));
    mcp = bridge;
    const socketPath = await bridge.ensureStarted();
    if (socketPath === null) throw new Error('Team MCP failed to start');
    const adapter = new CodexRuntimeAdapter(220_000, codexExecutable, [], directory);
    const pictures = new Map<string, string[]>();
    const edits = new Map<string, { count: number; z?: number }>();
    const call = team.call.bind(team);
    vi.spyOn(team, 'call').mockImplementation(async (worker, tool, input, caller) => {
      const result = await call(worker, tool, input, caller);
      const witness = edits.get(worker) ?? { count: 0 };
      if ('location' in result) witness.z = result.location[2];
      else witness.count++;
      edits.set(worker, witness);
      return result;
    });
    const workerIds = team.targets.map((_, index) => `codex-blender-worker-${index + 1}`);
    let releaseFirstPicture = (): void => undefined;
    const firstPicture = new Promise<void>((done) => {
      releaseFirstPicture = done;
    });
    const runs: Promise<{ code: number; completed: boolean; error: string | null }>[] = [];
    const toolNames = BLENDER_TEAM_MCP_TOOLS.map(({ name }) => name);
    function runWorker(index: number) {
      const worker = workerIds[index]!;
      const token = TeamMcpBridge.generateToken();
      bridge.register(worker, {
        taskId: 'codex-blender-acceptance',
        role: 'worker',
        requesterAgentId: worker,
        token,
        blenderEnabled: true,
        allowedTools: toolNames,
        blenderConnection: team,
        approveBlenderObservation: async (view) => {
          const hashes = pictures.get(worker) ?? [];
          hashes.push(createHash('sha256').update(view.dataUrl).digest('hex'));
          pictures.set(worker, hashes);
          if (index === 0) releaseFirstPicture();
          return true; // The user opted in to these synthetic images and this CLI test.
        },
      });
      return new Promise<{ code: number; completed: boolean; error: string | null }>((resolve) => {
        let completed = false;
        let error: string | null = null;
        adapter.start(
          worker,
          `Use blender_observe for target "${team.targets[index]}" at azimuth ${25 + index * 30} and elevation 25. Look only at the color of the large object at the center of the image. If the center object is red, move the object up 0.25 units; if blue, move it up 0.50 units. Use blender_edit with operation move, XYZ value and the exact observation token. Perform one successful edit, then observe again at the same angle and report the new Z coordinate. Do not edit a second time after a successful move.`,
          [],
          () => undefined,
          null,
          process.env['SPRINT_CODER_TEST_BLENDER_CODEX_MODEL'] ?? 'gpt-6.2-sol',
          (event) => {
            if (event.type === 'completed') completed = true;
          },
          (failure, diagnostic) => {
            error = [failure.code, diagnostic?.failureStage].filter(Boolean).join(':');
            resolve({ code: 1, completed, error });
          },
          (exitCode) => resolve({ code: exitCode, completed, error }),
          {
            socketPath: socketPath!,
            token,
            toolNames,
            guidance:
              'Use the Blender tools to perform this one task. Use only this synthetic Blender scene. The user authorized these test images.',
          },
          'low',
          'read-only',
          [],
          [],
          undefined,
          undefined,
          (pid) => {
            const identity = queryNativeProcessIdentity(pid);
            return identity !== null && bridge.bindRuntimeProcess(worker, identity);
          },
        );
      });
    }
    try {
      runs.push(runWorker(0));
      await Promise.race([
        firstPicture,
        runs[0]!.then((outcome) => {
          throw new Error(
            `First Worker ended before any Blender image: ${JSON.stringify(outcome)}`,
          );
        }),
      ]);
      for (let index = 1; index < workerIds.length; index++) runs.push(runWorker(index));
      const outcomes = await Promise.all(runs);
      const witnesses = workerIds.map((worker, index) => ({
        index,
        outcome: outcomes[index],
        edits: edits.get(worker)?.count ?? 0,
        actualZ: Number(edits.get(worker)?.z?.toFixed(4)),
        expectedZ: [0, 3, 4, 7, 9].includes(index) ? 0.7 : 0.95,
        pictures: pictures.get(worker)?.length ?? 0,
      }));
      console.info('Codex + Blender acceptance', JSON.stringify(witnesses));
      expect(new Set(workerIds.map((worker) => pictures.get(worker)?.[0])).size).toBe(10);
      expect(
        witnesses.filter(
          ({ outcome, edits, actualZ, expectedZ, pictures }) =>
            outcome?.error !== null ||
            !outcome.completed ||
            edits !== 1 ||
            pictures < 2 ||
            actualZ !== expectedZ,
        ),
      ).toEqual([]);
    } finally {
      await Promise.allSettled(workerIds.map((worker) => adapter.cancel(worker)));
    }
  },
  270_000,
);

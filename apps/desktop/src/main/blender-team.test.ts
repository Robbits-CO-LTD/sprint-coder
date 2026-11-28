import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

it('confirms stop once the paired Blender listener has closed', async () => {
  const server = createServer((socket) => {
    createInterface({ input: socket }).once('line', (line) => {
      const { method } = JSON.parse(line) as { method: string };
      const result =
        method === 'pair'
          ? { token: 't'.repeat(43), targets: ['Roof'] }
          : method === 'bind'
            ? { bound: true }
            : {
                observation: 'q'.repeat(32),
                target: 'Roof',
                location: [0, 0, 0],
                face_count: 0,
                faces: [],
                face_index: null,
                dataUrl: 'data:image/png;base64,QUFB',
              };
      socket.end(JSON.stringify({ ok: true, result }) + '\n');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const closeServer = () =>
    new Promise<void>((done, reject) =>
      server.close((error) => (error === undefined ? done() : reject(error))),
    );
  let team: BlenderTeamConnection;
  try {
    const endpoint = server.address();
    if (endpoint === null || typeof endpoint === 'string')
      throw new Error('Listening port required');
    const signal = AbortSignal.timeout(5_000);
    team = await BlenderTeamConnection.pair(`blender1:${endpoint.port}:${'t'.repeat(43)}`, signal);
    await team.call('one', 'blender_observe', { azimuth: 0, elevation: 20 }, signal);
  } finally {
    await closeServer();
  }
  await expect(team.releaseWorker('one')).resolves.toBeUndefined();
  expect(team.active).toBe(false);
  expect(await team.isAvailable()).toBe(false);
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

async function startBlender(visualWorker = false, recordingDirectory?: string) {
  if (blenderExecutable === undefined) throw new Error('Blender is required');
  tempDir = await mkdtemp(join(tmpdir(), 'sc-blender-test-'));
  const pairingPath = join(recordingDirectory ?? tempDir, 'pairing-code');
  processHandle = spawn(
    blenderExecutable,
    [
      recordingDirectory === undefined ? '--factory-startup' : '--disable-autoexec',
      '--python-exit-code',
      '1',
      '--python',
      recordingDirectory === undefined ? fixture : resolve(fixture, '../record_city_fixture.py'),
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
    const { code, directory } = await startBlender(true);
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
          azimuth: 25 + index * 30,
          elevation: 75,
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

    for (const action of ['move', 'select'] as const) {
      const clicks = await Promise.all(
        workers.map(({ token }, index) =>
          callMcp(path, token, 'blender_pointer', {
            observation: first[index]?.result?.observation,
            x: 0.5,
            y: 0.5,
            kind: 'face',
            action,
          }),
        ),
      );
      for (const click of clicks)
        expect(click).toMatchObject({ ok: true, result: { hit: { kind: 'face' } } });
    }
    const edits = await Promise.all(
      workers.map(({ token }, index) =>
        callMcp(path, token, 'blender_edit', {
          operation: 'extrude_selected',
          value: (index + 1) / 10,
          observation: first[index]?.result?.observation,
        }),
      ),
    );
    expect(edits.every(({ ok }) => ok)).toBe(true);
    const updated = await Promise.all(
      workers.map(({ token }, index) =>
        callMcp(path, token, 'blender_observe', { azimuth: 25 + index * 30, elevation: 75 }),
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
  'runs ten real Codex Worker Turns that point, click and edit their own Blender meshes',
  async () => {
    if (!codexExecutable) throw new Error('Codex CLI is required');
    const recordingDirectory = process.env['SPRINT_CODER_TEST_BLENDER_RECORD_DIR'];
    const { code, directory } = await startBlender(true, recordingDirectory);
    const signal = AbortSignal.timeout(260_000);
    const team = await BlenderTeamConnection.pair(code, signal);
    connection = team;
    const bridge = new TeamMcpBridge({} as TeamCoordinator, defaultSocketPathFactory(directory));
    mcp = bridge;
    const socketPath = await bridge.ensureStarted();
    if (socketPath === null) throw new Error('Team MCP failed to start');
    const adapter = new CodexRuntimeAdapter(220_000, codexExecutable, [], directory);
    const attempts = new Map<string, string[]>();
    const diagnostics = new Map<string, string>();
    const pictures = new Map<string, string[]>();
    const actions = new Map<
      string,
      { selects: number; moves: number; edits: string[]; faces?: number }
    >();
    const call = team.call.bind(team);
    vi.spyOn(team, 'call').mockImplementation(async (worker, tool, input, caller) => {
      const trace = attempts.get(worker) ?? [];
      attempts.set(worker, trace);
      const args = input as { action?: string; operation?: string };
      trace.push(`${tool}:${args.action ?? args.operation ?? 'request'}`);
      const result = await call(worker, tool, input, caller).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : '';
        const rejected = message.includes('different Worker or Turn')
          ? 'stale token'
          : message.includes('empty, unshared')
            ? 'mesh already initialized'
            : message.includes('observation')
              ? 'invalid observation input'
              : message.includes('width and depth') || message.includes('"value"')
                ? 'invalid edit value'
                : 'rejected';
        trace.push(rejected);
        throw error;
      });
      trace.push('hit' in result && result.hit === null ? 'miss' : 'ok');
      const witness = actions.get(worker) ?? { selects: 0, moves: 0, edits: [] };
      if ('face_count' in result) witness.faces = result.face_count;
      else if ('hit' in result && result.hit !== null) {
        if (args.action === 'move') witness.moves++;
        if (args.action === 'select') witness.selects++;
      } else if ('revision' in result && args.operation !== undefined)
        witness.edits.push(args.operation);
      actions.set(worker, witness);
      return result;
    });
    const configuredIndexes = process.env['SPRINT_CODER_TEST_BLENDER_WORKER_INDEXES'];
    const indexes =
      configuredIndexes?.split(',').map(Number) ?? team.targets.map((_, index) => index);
    if (
      new Set(indexes).size !== indexes.length ||
      indexes.some((i) => !Number.isInteger(i) || i < 0 || i >= team.targets.length)
    )
      throw new Error('Use distinct zero-based Blender Worker indexes');
    const firstIndex = indexes[0]!;
    const workerIds = team.targets.map((_, index) => `codex-blender-worker-${index + 1}`);
    let releaseFirstPicture = (): void => undefined;
    const firstPicture = new Promise<void>((done) => {
      releaseFirstPicture = done;
    });
    const runs: Promise<{ code: number; completed: boolean; error: string | null }>[] = [];
    const toolNames = BLENDER_TEAM_MCP_TOOLS.map(({ name }) => name);
    function runWorker(index: number, retry = false) {
      const worker = workerIds[index]!;
      if (retry) bridge.unregister(worker);
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
          if (index === firstIndex) releaseFirstPicture();
          return true; // The user opted in to these synthetic images and this CLI test.
        },
      });
      const kind = index % 2 === 0 ? 'face' : 'vertex';
      const operation = kind === 'face' ? 'extrude_selected' : 'move_vertex';
      const editValue = kind === 'face' ? '0.25' : '[0,0,0.25]';
      const azimuth = 25 + index * 30;
      const buildInstruction =
        index === 9
          ? 'Build the street with a [28,3.6] base and extrude the selected face by 0.14.'
          : `Build a distinctive building with a base roughly [${3.3 + (index % 3) * 0.2},3.3] and extrude its selected face by about ${2.6 + (index % 4) * 0.6} units.`;
      const roofInstruction =
        index % 2 === 1 && index < 9
          ? ' Then observe again, move your cursor to a visible upper vertex, click to select it with kind vertex, and use move_vertex with value [0,0,0.6] to raise that corner before a final observation.'
          : '';
      const completedOperations = actions.get(worker)?.edits ?? [];
      const resumeInstructions = retry
        ? `You are reconnecting to the SAME mesh in the SAME recording. Already applied operations: ${completedOperations.join(', ') || 'none'}. Your first call must be blender_observe. Only perform missing operations in order (create_base, extrude_selected${roofInstruction ? ', move_vertex' : ''}), followed by verification, to avoid repeating edits. `
        : '';
      const buildingPrompt = `${resumeInstructions}Build only "${team.targets[index]}" in the shared street. ${buildInstruction} Observe your assigned mesh at azimuth ${azimuth}, elevation 72. If face_count is 0, use blender_edit operation create_base and value [width,depth]. Copy the exact observation token string from the most recent tool result. Observe. Move your cursor to the visible face and click select using blender_pointer with kind face, then use blender_edit extrude_selected with the same token. If you get an error, observe afresh and copy the entire newest token. If the pointer misses, try another point on the visible surface. ${roofInstruction} Finish with an observation after the edit; perform the tool calls before reporting. Up to three attempts if a step is rejected.`;
      return new Promise<{ code: number; completed: boolean; error: string | null }>((resolve) => {
        let completed = false;
        let error: string | null = null;
        let syntheticResponse = '';
        adapter.start(
          worker,
          recordingDirectory !== undefined
            ? buildingPrompt
            : `Observe only "${team.targets[index]}" with blender_observe at azimuth ${azimuth} and elevation 75 (no faceIndex). The assigned object is the cube in the center. From its image choose a visible ${kind}. For a vertex, aim just inside a visible top corner, and try a nearby position if the hit is null. Use blender_pointer first with action move, kind ${kind} and normalized image coordinates, then again with action select at the hit coordinates. Use the same observation token for those calls and for blender_edit with operation ${operation} and value ${editValue}. After exactly one successful edit, observe again from the same angle and briefly report the result.`,
          [],
          () => undefined,
          null,
          process.env['SPRINT_CODER_TEST_BLENDER_CODEX_MODEL'] ?? 'gpt-6.2-sol',
          (event) => {
            if (event.type === 'delta')
              syntheticResponse = (syntheticResponse + event.delta).slice(-4000);
            if (event.type === 'completed') {
              completed = true;
              const markers = [
                [
                  'image delivery refused',
                  /(?:view|image|picture).{0,60}(?:not be delivered|could not see|unavailable|did not receive|not available)|could not (?:see|receive|deliver) (?:an?|the) (?:image|picture)/i,
                ],
                ['tool issue', /tool.{0,45}(?:fail|timeout|unavailable|error)/i],
                [
                  'no operation performed',
                  /(?:no edit|not perform|unable to edit|could not edit|did not edit)/i,
                ],
              ] as const;
              diagnostics.set(
                worker,
                markers
                  .filter(([, match]) => match.test(syntheticResponse))
                  .map(([label]) => label)
                  .join(', '),
              );
            }
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
      runs.push(runWorker(firstIndex));
      await Promise.race([
        firstPicture,
        runs[0]!.then((outcome) => {
          throw new Error(
            `First Worker ended before any Blender image: ${JSON.stringify(outcome)}`,
          );
        }),
      ]);
      for (const index of indexes.slice(1)) runs.push(runWorker(index));
      const outcomes = await Promise.all(runs);
      if (recordingDirectory !== undefined) {
        for (const [run, index] of indexes.entries()) {
          const worker = workerIds[index]!;
          const expected = index % 2 === 1 && index < 9 ? 3 : 2;
          if (
            (actions.get(worker)?.edits.length ?? 0) !== expected ||
            outcomes[run]?.error !== null
          ) {
            console.info('Continuing in the same scene for Worker', index + 1);
            await adapter.cancel(worker);
            outcomes[run] = await runWorker(index, true);
          }
        }
      }
      const witnesses = indexes.map((index, run) => {
        const worker = workerIds[index]!;
        return {
          index,
          outcome: outcomes[run],
          actions: actions.get(worker),
          attempts: attempts.get(worker),
          diagnostic: diagnostics.get(worker),
          expectedEdit:
            recordingDirectory !== undefined
              ? [
                  'create_base',
                  'extrude_selected',
                  ...(index % 2 === 1 && index < 9 ? ['move_vertex'] : []),
                ]
              : [index % 2 === 0 ? 'extrude_selected' : 'move_vertex'],
          expectedFaces: recordingDirectory !== undefined ? 5 : index % 2 === 0 ? 10 : 6,
          imageChanged: pictures.get(worker)?.[0] !== pictures.get(worker)?.at(-1),
          pictures: pictures.get(worker)?.length ?? 0,
        };
      });
      console.info('Codex + Blender acceptance', JSON.stringify(witnesses));
      if (recordingDirectory !== undefined) {
        await writeFile(join(recordingDirectory, 'finish-request'), '');
        await expect
          .poll(
            async () => {
              try {
                await readFile(join(recordingDirectory, 'finish-result.json'));
                return true;
              } catch {
                return false;
              }
            },
            { timeout: 15_000 },
          )
          .toBe(true);
      }
      const hashes = indexes.map((index) => pictures.get(workerIds[index]!));
      expect(
        new Set(
          hashes.map((items) => (recordingDirectory === undefined ? items?.[0] : items?.at(-1))),
        ).size,
      ).toBe(indexes.length);
      expect(
        witnesses.filter(
          ({ outcome, actions, expectedEdit, expectedFaces, imageChanged, pictures }) =>
            outcome?.error !== null ||
            !outcome.completed ||
            !actions ||
            actions.selects < 1 ||
            actions.moves < 1 ||
            actions.edits.join(',') !== expectedEdit.join(',') ||
            actions.faces !== expectedFaces ||
            !imageChanged ||
            pictures < 2,
        ),
      ).toEqual([]);
    } finally {
      await Promise.allSettled(workerIds.map((worker) => adapter.cancel(worker)));
    }
  },
  270_000,
);

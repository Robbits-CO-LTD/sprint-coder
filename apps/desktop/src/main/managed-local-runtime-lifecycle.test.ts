import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalHardwareSnapshot } from '@sprint-coder/contracts';
import {
  ManagedLocalLifecycleError,
  ManagedLocalRuntimeLifecycle,
  type ManagedLocalModelDescriptor,
} from './managed-local-runtime-lifecycle';
import {
  ManagedLocalRuntimeSupervisor,
  type ManagedLocalRuntimeSession,
  type ManagedLocalRuntimeSnapshot as SupervisorSnapshot,
  type ManagedLocalRuntimeStartInput,
} from './managed-local-runtime-supervisor';
import type { VerifiedManagedLocalSidecarBundle } from './managed-local-sidecar-bundle';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function bundle(): VerifiedManagedLocalSidecarBundle {
  return {
    target: 'darwin-arm64',
    rootPath: '/fixture/managed-local',
    manifest: {
      schemaVersion: 1,
      runtime: 'llama.cpp',
      runtimeVersion: 'b10516',
      upstreamRepository: 'https://github.com/ggml-org/llama.cpp',
      upstreamRevision: 'a'.repeat(40),
      platform: 'darwin',
      architecture: 'arm64',
      candidateBackends: ['cpu', 'metal'],
      artifacts: [],
    },
    manifestSha256: 'b'.repeat(64),
    serverPath: '/fixture/managed-local/bin/llama-server',
    licensePath: '/fixture/managed-local/licenses/LICENSE',
    artifactPaths: {},
  };
}

function hardware(
  input: { availableBytes?: number | null; backends?: LocalHardwareSnapshot['backends'] } = {},
): LocalHardwareSnapshot {
  const availableBytes = input.availableBytes === undefined ? 16 * 1024 ** 3 : input.availableBytes;
  return {
    version: 1,
    status: availableBytes === null ? 'partial' : 'complete',
    observedAt: '2026-08-24T00:00:00.000Z',
    platform: 'darwin',
    architecture: 'arm64',
    memory: {
      totalBytes: 32 * 1024 ** 3,
      availableBytes,
      topology: 'unified',
    },
    cpu: {
      model: 'Apple M4',
      logicalCores: 10,
      features: ['neon'],
      featuresStatus: 'known',
    },
    gpuDevicesStatus: 'known',
    gpus: [
      {
        id: 'gpu-0',
        active: true,
        vendorId: null,
        deviceId: null,
        vendorName: 'Apple',
        deviceName: 'Integrated GPU',
        memory: {
          dedicatedTotalBytes: null,
          dedicatedAvailableBytes: null,
          sharedTotalBytes: null,
          unifiedTotalBytes: 32 * 1024 ** 3,
        },
      },
    ],
    backends: input.backends ?? [
      { kind: 'cpu', status: 'available' },
      { kind: 'metal', status: 'available' },
    ],
    unknownComponents: availableBytes === null ? ['system_memory'] : [],
  };
}

class FakeSession {
  state: SupervisorSnapshot['state'] = 'running';
  stopCount = 0;
  readonly snapshotValue: SupervisorSnapshot = {
    state: 'running',
    target: 'darwin-arm64',
    runtimeVersion: 'b10516',
    baseUrl: 'http://127.0.0.1:43210/v1',
    backend: 'metal',
    gpuLayers: 99,
    contextTokens: 4096,
    batchSize: 512,
    startedAt: '2026-08-24T00:00:00.000Z',
    stoppedAt: null,
    exitCode: null,
    signal: null,
  };

  session(): ManagedLocalRuntimeSession {
    return {
      baseUrl: this.snapshotValue.baseUrl!,
      snapshot: () => ({ ...this.snapshotValue, state: this.state }),
      diagnostics: () => '',
      authenticatedFetch: async () => new Response('{}', { status: 200 }),
      stop: async () => {
        this.stopCount += 1;
        this.state = 'stopped';
        return { ...this.snapshotValue, state: 'stopped', stoppedAt: '2026-08-24T00:00:01.000Z' };
      },
    };
  }
}

class FakeSupervisor extends ManagedLocalRuntimeSupervisor {
  readonly starts: ManagedLocalRuntimeStartInput[] = [];
  readonly sessions: FakeSession[] = [];
  startError: Error | null = null;

  constructor() {
    super({ loadBundle: async () => bundle() });
  }

  override async start(input: ManagedLocalRuntimeStartInput): Promise<ManagedLocalRuntimeSession> {
    if (this.startError !== null) throw this.startError;
    this.starts.push(input);
    const session = new FakeSession();
    this.sessions.push(session);
    return session.session();
  }
}

async function descriptor(
  idCharacter: string,
  overrides: Partial<ManagedLocalModelDescriptor> = {},
): Promise<ManagedLocalModelDescriptor> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sprint-coder-local-lifecycle-')));
  roots.push(root);
  const modelRoot = join(root, 'models');
  const scratchRoot = join(root, 'scratch');
  await mkdir(modelRoot);
  await mkdir(scratchRoot);
  const modelPath = join(modelRoot, `${idCharacter}.gguf`);
  await writeFile(modelPath, 'fixture');
  return {
    id: idCharacter.repeat(64),
    modelRoot,
    modelPath,
    scratchRoot,
    backend: 'metal',
    gpuLayers: 99,
    contextTokens: 4096,
    batchSize: 512,
    fit: {
      weightsBytes: 2 * 1024 ** 3,
      contextTokens: 4096,
      kvBytesPerToken: 128 * 1024,
      scratchBytes: 256 * 1024 ** 2,
      runtimeReserveBytes: 512 * 1024 ** 2,
      safetyFactor: 1.2,
      gpuOffloadRatio: 0.75,
      runtimeCompatibility: 'supported',
    },
    ...overrides,
  };
}

function lifecycle(
  input: {
    supervisor?: FakeSupervisor;
    hardware?: LocalHardwareSnapshot;
    drainTimeoutMs?: number;
    onDrainRequested?: (
      modelId: string,
      active: number,
      reason: 'switch' | 'memory_pressure' | 'dispose',
    ) => void | Promise<void>;
    memory?: () => { availableBytes: number; totalBytes: number };
  } = {},
) {
  const supervisor = input.supervisor ?? new FakeSupervisor();
  const subject = new ManagedLocalRuntimeLifecycle({
    bundle: bundle(),
    supervisor,
    collectHardware: async () => input.hardware ?? hardware(),
    ...(input.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: input.drainTimeoutMs }),
    ...(input.onDrainRequested === undefined ? {} : { onDrainRequested: input.onDrainRequested }),
    ...(input.memory === undefined ? {} : { memory: input.memory }),
  });
  return { subject, supervisor };
}

describe('ManagedLocalRuntimeLifecycle', () => {
  it('shares one loaded model and honors pending automatic release after the final lease', async () => {
    const model = await descriptor('a');
    const { subject, supervisor } = lifecycle();

    const first = await subject.acquire(model, true);
    const second = await subject.acquire(model, false);

    expect(supervisor.starts).toHaveLength(1);
    expect(supervisor.starts[0]).toMatchObject({
      backend: 'metal',
      gpuLayers: 99,
      contextTokens: 4096,
      batchSize: 512,
    });
    expect(subject.snapshot()).toMatchObject({
      state: 'running',
      backend: 'metal',
      gpuLayers: 99,
      contextTokens: 4096,
      batchSize: 512,
      runtimeVersion: 'b10516',
    });
    expect(subject.activeLeaseCount(model.id)).toBe(2);
    await first.release();
    expect(supervisor.sessions[0]?.stopCount).toBe(0);
    await second.release();
    expect(supervisor.sessions[0]?.stopCount).toBe(1);
    expect(subject.snapshot()).toMatchObject({ state: 'stopped', activeLeaseCount: 0 });
  });

  it('drains the active model before switching and never overlaps two sessions', async () => {
    const firstModel = await descriptor('a');
    const secondModel = await descriptor('b');
    const onDrainRequested = vi.fn();
    const { subject, supervisor } = lifecycle({ onDrainRequested });
    const first = await subject.acquire(firstModel, false);

    const switching = subject.acquire(secondModel, false);
    await new Promise((resolve) => setImmediate(resolve));
    expect(onDrainRequested).toHaveBeenCalledWith(firstModel.id, 1, 'switch');
    expect(supervisor.starts).toHaveLength(1);
    await first.release();

    const second = await switching;
    expect(supervisor.sessions[0]?.stopCount).toBe(1);
    expect(supervisor.starts).toHaveLength(2);
    expect(second.modelId).toBe(secondModel.id);
    await second.release();
  });

  it('fails closed on insufficient or unknown memory and returns bounded recovery guidance', async () => {
    const tooLarge = await descriptor('c', {
      fit: {
        weightsBytes: 64 * 1024 ** 3,
        contextTokens: 4096,
        kvBytesPerToken: 128 * 1024,
        scratchBytes: 1024,
        runtimeReserveBytes: 1024,
        safetyFactor: 1.2,
        gpuOffloadRatio: 0.75,
        runtimeCompatibility: 'supported',
      },
    });
    const insufficient = lifecycle();
    await expect(insufficient.subject.acquire(tooLarge, false)).rejects.toMatchObject({
      code: 'memory_insufficient',
      recovery: { lowerContextTokens: 2048, useCpuOnly: true },
    });
    expect(insufficient.supervisor.starts).toHaveLength(0);
    expect(insufficient.subject.snapshot()).toMatchObject({
      failureCode: 'memory_insufficient',
      recovery: { lowerContextTokens: 2048 },
    });

    const unknown = lifecycle({ hardware: hardware({ availableBytes: null }) });
    await expect(unknown.subject.acquire(await descriptor('d'), false)).rejects.toMatchObject({
      code: 'memory_unknown',
    });
    expect(unknown.supervisor.starts).toHaveLength(0);
  });

  it('rejects a descriptor whose backend is absent from the verified bundle', async () => {
    const { subject, supervisor } = lifecycle();
    const model = await descriptor('8', { backend: 'cuda' });

    await expect(subject.acquire(model, false)).rejects.toMatchObject({
      code: 'backend_unavailable',
    });
    expect(supervisor.starts).toHaveLength(0);
  });

  it('keeps active and loaded models undeletable', async () => {
    const model = await descriptor('e');
    const { subject } = lifecycle();
    const lease = await subject.acquire(model, false);
    expect(() => subject.assertDeletable(model.id)).toThrow(ManagedLocalLifecycleError);
    await lease.release();
    expect(() => subject.assertDeletable(model.id)).toThrow(ManagedLocalLifecycleError);
    await subject.stopModel(model.id);
    expect(() => subject.assertDeletable(model.id)).not.toThrow();
  });

  it('refuses an explicit stop while a model lease is active', async () => {
    const model = await descriptor('4');
    const { subject } = lifecycle();
    const lease = await subject.acquire(model, false);

    await expect(subject.stopModel(model.id)).rejects.toMatchObject({ code: 'model_busy' });
    await lease.release();
    await expect(subject.stopModel(model.id)).resolves.toBeUndefined();
  });

  it('drains and stops on critical memory pressure', async () => {
    const model = await descriptor('f');
    const onDrainRequested = vi.fn();
    const { subject, supervisor } = lifecycle({
      onDrainRequested,
      memory: () => ({ availableBytes: 128 * 1024 ** 2, totalBytes: 32 * 1024 ** 3 }),
    });
    const lease = await subject.acquire(model, false);

    const pressure = subject.pollMemoryPressure();
    await new Promise((resolve) => setImmediate(resolve));
    expect(onDrainRequested).toHaveBeenCalledWith(model.id, 1, 'memory_pressure');
    await lease.release();

    await expect(pressure).resolves.toBe(true);
    expect(supervisor.sessions[0]?.stopCount).toBe(1);
    expect(subject.snapshot()).toMatchObject({
      state: 'stopped',
      failureCode: 'memory_insufficient',
      recovery: { lowerContextTokens: 2048, useCpuOnly: true },
    });
  });

  it('stops after the bounded dispose drain and rejects later leases', async () => {
    const model = await descriptor('1');
    const { subject, supervisor } = lifecycle({ drainTimeoutMs: 5 });
    await subject.acquire(model, false);

    await subject.dispose();

    expect(supervisor.sessions[0]?.stopCount).toBe(1);
    await expect(subject.acquire(model, false)).rejects.toMatchObject({ code: 'disposed' });
  });

  it('publishes crashes without leaking the loopback endpoint', async () => {
    const model = await descriptor('2');
    const { subject, supervisor } = lifecycle();
    await subject.acquire(model, false);
    supervisor.sessions[0]!.state = 'crashed';

    const snapshot = subject.snapshot();

    expect(snapshot).toMatchObject({ state: 'crashed', failureCode: 'crashed' });
    expect(snapshot).not.toHaveProperty('baseUrl');
    expect(snapshot).not.toHaveProperty('modelPath');
  });

  it('records startup failure and does not publish a loaded model', async () => {
    const supervisor = new FakeSupervisor();
    supervisor.startError = new Error('failed');
    const { subject } = lifecycle({ supervisor });

    await expect(subject.acquire(await descriptor('3'), false)).rejects.toMatchObject({
      code: 'startup_failed',
    });
    expect(subject.snapshot()).toMatchObject({ state: 'stopped', failureCode: 'startup_failed' });
  });
});

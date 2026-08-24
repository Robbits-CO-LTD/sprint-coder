import { freemem, totalmem } from 'node:os';
import {
  managedLocalRuntimeSnapshotSchema,
  type LocalFitAssessment,
  type LocalHardwareSnapshot,
  type ManagedLocalRuntimeSnapshot,
} from '@sprint-coder/contracts';
import { estimateLocalModelFit, type LocalFitEstimateInput } from './local-fit-estimator';
import { collectLocalHardwareSnapshot } from './local-hardware-inventory';
import {
  ManagedLocalRuntimeSupervisor,
  type ManagedLocalRuntimeSession,
} from './managed-local-runtime-supervisor';
import type {
  ManagedLocalBackend,
  VerifiedManagedLocalSidecarBundle,
} from './managed-local-sidecar-bundle';

const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const CRITICAL_MEMORY_FLOOR_BYTES = 512 * 1024 * 1024;
const CRITICAL_MEMORY_RATIO = 0.05;

export type ManagedLocalModelDescriptor = Readonly<{
  id: string;
  modelRoot: string;
  modelPath: string;
  scratchRoot: string;
  backend: ManagedLocalBackend;
  gpuLayers: number;
  contextTokens: number;
  batchSize: number;
  fit: Omit<LocalFitEstimateInput, 'acceleratorBackend' | 'cpuBackend'>;
}>;

export type ManagedLocalModelLease = Readonly<{
  modelId: string;
  session: ManagedLocalRuntimeSession;
  prepare(signal: AbortSignal): Promise<void>;
  release(): Promise<void>;
}>;

export class ManagedLocalLifecycleError extends Error {
  constructor(
    readonly code:
      | 'model_busy'
      | 'memory_unknown'
      | 'memory_insufficient'
      | 'backend_unavailable'
      | 'startup_failed'
      | 'disposed',
    readonly fit: LocalFitAssessment | null,
    readonly recovery: ManagedLocalRuntimeSnapshot['recovery'],
    message: string,
  ) {
    super(message);
    this.name = 'ManagedLocalLifecycleError';
  }
}

type CurrentModel = {
  descriptor: ManagedLocalModelDescriptor;
  session: ManagedLocalRuntimeSession;
  fit: LocalFitAssessment;
  leases: Map<symbol, boolean>;
  pendingStop: boolean;
};

type LifecycleDependencies = Readonly<{
  bundle: VerifiedManagedLocalSidecarBundle;
  supervisor?: ManagedLocalRuntimeSupervisor;
  collectHardware?: () => Promise<LocalHardwareSnapshot>;
  now?: () => Date;
  nowMs?: () => number;
  drainTimeoutMs?: number;
  onDrainRequested?: (
    modelId: string,
    activeLeases: number,
    reason: 'switch' | 'memory_pressure' | 'dispose',
  ) => void | Promise<void>;
  memory?: () => Readonly<{ availableBytes: number; totalBytes: number }>;
}>;

export class ManagedLocalRuntimeLifecycle {
  private readonly bundle: VerifiedManagedLocalSidecarBundle;
  private readonly supervisor: ManagedLocalRuntimeSupervisor;
  private readonly collectHardware: () => Promise<LocalHardwareSnapshot>;
  private readonly now: () => Date;
  private readonly nowMs: () => number;
  private readonly drainTimeoutMs: number;
  private readonly onDrainRequested: NonNullable<LifecycleDependencies['onDrainRequested']>;
  private readonly memory: () => Readonly<{ availableBytes: number; totalBytes: number }>;
  private current: CurrentModel | null = null;
  private phase: 'open' | 'draining' | 'disposed' = 'open';
  private tail: Promise<void> = Promise.resolve();
  private readonly changed = new Set<() => void>();
  private lastFailure: Readonly<{
    code: Exclude<ManagedLocalRuntimeSnapshot['failureCode'], null>;
    fit: LocalFitAssessment | null;
    recovery: NonNullable<ManagedLocalRuntimeSnapshot['recovery']>;
  }> | null = null;

  constructor(dependencies: LifecycleDependencies) {
    this.bundle = dependencies.bundle;
    this.supervisor =
      dependencies.supervisor ??
      new ManagedLocalRuntimeSupervisor({ loadBundle: async () => dependencies.bundle });
    const backends = dependencies.bundle.manifest.candidateBackends.map((kind) => ({
      kind,
      status: 'available' as const,
    }));
    this.collectHardware =
      dependencies.collectHardware ??
      (() => collectLocalHardwareSnapshot({ backends: async () => backends }));
    this.now = dependencies.now ?? (() => new Date());
    this.nowMs = dependencies.nowMs ?? Date.now;
    this.drainTimeoutMs = boundedTimeout(dependencies.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
    this.onDrainRequested = dependencies.onDrainRequested ?? (() => undefined);
    this.memory =
      dependencies.memory ?? (() => ({ availableBytes: freemem(), totalBytes: totalmem() }));
  }

  snapshot(): ManagedLocalRuntimeSnapshot {
    const current = this.current;
    if (current === null) return this.emptySnapshot();
    const runtime = current.session.snapshot();
    const crashed = runtime.state === 'crashed';
    const failure = crashed
      ? {
          code: 'crashed' as const,
          recovery: recovery(
            current.descriptor,
            'Managed Localが異常終了しました。再起動してください。',
          ),
        }
      : null;
    return managedLocalRuntimeSnapshotSchema.parse({
      state: crashed ? 'crashed' : this.phase === 'draining' ? 'stopping' : runtime.state,
      target: this.bundle.target,
      runtimeVersion: this.bundle.manifest.runtimeVersion,
      modelId: current.descriptor.id,
      backend: current.descriptor.backend,
      activeLeaseCount: current.leases.size,
      fit: current.fit,
      failureCode: failure?.code ?? null,
      recovery: failure?.recovery ?? null,
      observedAt: this.now().toISOString(),
    });
  }

  async acquire(
    descriptor: ManagedLocalModelDescriptor,
    automaticRelease: boolean,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ManagedLocalModelLease> {
    validateDescriptor(descriptor);
    for (;;) {
      if (signal.aborted) throw canceled();
      const result = await this.exclusive(async () => {
        if (this.phase === 'disposed') throw disposedError();
        if (this.phase === 'draining') return null;
        this.reconcileCrash();
        if (this.current !== null && this.current.descriptor.id === descriptor.id)
          return this.createLease(this.current, automaticRelease);
        if (this.current !== null && this.current.leases.size > 0) {
          void this.onDrainRequested(
            this.current.descriptor.id,
            this.current.leases.size,
            'switch',
          );
          return null;
        }
        if (this.current !== null) await this.stopCurrent();
        const hardware = await this.collectHardware();
        const fit = this.assess(descriptor, hardware);
        this.assertStartable(descriptor, fit);
        let session: ManagedLocalRuntimeSession;
        try {
          session = await this.supervisor.start({
            kind: 'model',
            modelRoot: descriptor.modelRoot,
            modelPath: descriptor.modelPath,
            modelAlias: descriptor.id,
            scratchRoot: descriptor.scratchRoot,
            contextTokens: descriptor.contextTokens,
            batchSize: descriptor.batchSize,
            gpuLayers: descriptor.gpuLayers,
          });
        } catch {
          const guidance = recovery(
            descriptor,
            'Managed Localを起動できませんでした。診断を確認して再試行してください。',
          );
          this.lastFailure = { code: 'startup_failed', fit, recovery: guidance };
          throw new ManagedLocalLifecycleError(
            'startup_failed',
            fit,
            guidance,
            'Managed Local startup failed',
          );
        }
        const current: CurrentModel = {
          descriptor,
          session,
          fit,
          leases: new Map(),
          pendingStop: false,
        };
        this.current = current;
        this.lastFailure = null;
        this.notifyChanged();
        return this.createLease(current, automaticRelease);
      });
      if (result !== null) return result;
      await this.waitForChange(signal);
    }
  }

  activeLeaseCount(modelId?: string): number {
    if (this.current === null || (modelId !== undefined && this.current.descriptor.id !== modelId))
      return 0;
    return this.current.leases.size;
  }

  assertDeletable(modelId: string): void {
    if (this.current?.descriptor.id === modelId)
      throw new ManagedLocalLifecycleError(
        'model_busy',
        this.current.fit,
        recovery(
          this.current.descriptor,
          '実行中のTurnを完了し、モデルを停止してから削除してください。',
        ),
        'Managed Local model is active',
      );
  }

  async stopModel(modelId: string): Promise<void> {
    await this.exclusive(async () => {
      if (this.current?.descriptor.id !== modelId) return;
      if (this.current.leases.size > 0)
        throw new ManagedLocalLifecycleError(
          'model_busy',
          this.current.fit,
          recovery(this.current.descriptor, '実行中のTurnを完了してからモデルを停止してください。'),
          'Managed Local model has active leases',
        );
      await this.stopCurrent();
    });
  }

  async pollMemoryPressure(): Promise<boolean> {
    if (this.phase !== 'open' || this.current === null) return false;
    const memory = this.memory();
    if (
      !Number.isSafeInteger(memory.availableBytes) ||
      !Number.isSafeInteger(memory.totalBytes) ||
      memory.availableBytes < 0 ||
      memory.totalBytes <= 0
    )
      return false;
    const critical = Math.max(
      CRITICAL_MEMORY_FLOOR_BYTES,
      Math.floor(memory.totalBytes * CRITICAL_MEMORY_RATIO),
    );
    if (memory.availableBytes >= critical) return false;
    const descriptor = this.current.descriptor;
    this.lastFailure = {
      code: 'memory_insufficient',
      fit: this.current.fit,
      recovery: recovery(
        descriptor,
        '空きメモリがcritical水準まで低下したため、モデルを安全に停止しました。',
      ),
    };
    await this.drainAndStop('memory_pressure');
    return true;
  }

  async dispose(): Promise<void> {
    if (this.phase === 'disposed') return;
    await this.drainAndStop('dispose');
    this.phase = 'disposed';
    this.notifyChanged();
  }

  private assess(
    descriptor: ManagedLocalModelDescriptor,
    hardware: LocalHardwareSnapshot,
  ): LocalFitAssessment {
    const status = (kind: ManagedLocalBackend): 'available' | 'unavailable' | 'unknown' =>
      hardware.backends.find((backend) => backend.kind === kind)?.status ?? 'unknown';
    return estimateLocalModelFit(
      {
        ...descriptor.fit,
        acceleratorBackend:
          descriptor.backend === 'cpu' ? 'unavailable' : status(descriptor.backend),
        cpuBackend: status('cpu'),
      },
      hardware,
    );
  }

  private assertStartable(descriptor: ManagedLocalModelDescriptor, fit: LocalFitAssessment): void {
    let code: ManagedLocalLifecycleError['code'] | null = null;
    let detail = '';
    if (fit.state === 'unknown') {
      code = 'memory_unknown';
      detail = '空きメモリまたはモデルmetadataを確認できないため、安全に起動できません。';
    } else if (fit.state === 'unsupported') {
      code = 'backend_unavailable';
      detail = '選択したbackendではこのモデルを起動できません。';
    } else if (fit.state === 'estimated_insufficient') {
      code = 'memory_insufficient';
      detail = '推定必要メモリが現在の空き容量を超えています。';
    } else if (fit.state === 'estimated_cpu' && descriptor.backend !== 'cpu') {
      code = 'memory_insufficient';
      detail = 'GPU条件を満たしません。CPU実行へ変更してください。';
    }
    if (code === null) return;
    const guidance = recovery(descriptor, detail);
    this.lastFailure = { code, fit, recovery: guidance };
    throw new ManagedLocalLifecycleError(code, fit, guidance, detail);
  }

  private createLease(current: CurrentModel, automaticRelease: boolean): ManagedLocalModelLease {
    const id = Symbol(current.descriptor.id);
    current.leases.set(id, automaticRelease);
    this.notifyChanged();
    let released = false;
    return Object.freeze({
      modelId: current.descriptor.id,
      session: current.session,
      prepare: async (signal: AbortSignal) => {
        if (released || signal.aborted) throw canceled();
        if (this.current !== current || current.session.snapshot().state !== 'running')
          throw new ManagedLocalLifecycleError(
            'model_busy',
            current.fit,
            recovery(current.descriptor, 'モデルを再起動してから再試行してください。'),
            'Managed Local lease is no longer prepared',
          );
      },
      release: async () => {
        if (released) return;
        released = true;
        await this.exclusive(async () => {
          if (this.current !== current || !current.leases.has(id)) return;
          current.pendingStop ||= current.leases.get(id) === true;
          current.leases.delete(id);
          this.notifyChanged();
          if (current.leases.size === 0 && current.pendingStop && this.phase === 'open')
            await this.stopCurrent();
        });
      },
    });
  }

  private async drainAndStop(reason: 'memory_pressure' | 'dispose'): Promise<void> {
    if (this.phase === 'disposed') return;
    this.phase = 'draining';
    const current = this.current;
    if (current !== null && current.leases.size > 0)
      await this.onDrainRequested(current.descriptor.id, current.leases.size, reason);
    const deadline = this.nowMs() + this.drainTimeoutMs;
    while (this.current !== null && this.current.leases.size > 0 && this.nowMs() < deadline)
      await this.waitForChange(undefined, Math.max(1, deadline - this.nowMs()));
    await this.exclusive(() => this.stopCurrent());
    if (reason === 'memory_pressure') this.phase = 'open';
    this.notifyChanged();
  }

  private async stopCurrent(): Promise<void> {
    const current = this.current;
    if (current === null) return;
    this.current = null;
    this.notifyChanged();
    await current.session.stop();
  }

  private reconcileCrash(): void {
    if (this.current?.session.snapshot().state !== 'crashed') return;
    this.current = null;
    this.notifyChanged();
  }

  private emptySnapshot(): ManagedLocalRuntimeSnapshot {
    return managedLocalRuntimeSnapshotSchema.parse({
      state: this.phase === 'draining' ? 'stopping' : 'stopped',
      target: this.bundle.target,
      runtimeVersion: this.bundle.manifest.runtimeVersion,
      modelId: null,
      backend: null,
      activeLeaseCount: 0,
      fit: this.lastFailure?.fit ?? null,
      failureCode: this.lastFailure?.code ?? null,
      recovery: this.lastFailure?.recovery ?? null,
      observedAt: this.now().toISOString(),
    });
  }

  private exclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private waitForChange(signal?: AbortSignal, timeoutMs?: number): Promise<void> {
    if (signal?.aborted) return Promise.reject(canceled());
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        this.changed.delete(done);
        resolve();
      };
      const aborted = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        this.changed.delete(done);
        reject(canceled());
      };
      this.changed.add(done);
      signal?.addEventListener('abort', aborted, { once: true });
      if (timeoutMs !== undefined) timer = setTimeout(done, timeoutMs);
    });
  }

  private notifyChanged(): void {
    for (const changed of [...this.changed]) changed();
  }
}

function validateDescriptor(descriptor: ManagedLocalModelDescriptor): void {
  if (
    !/^[a-f0-9]{64}$/u.test(descriptor.id) ||
    !['cpu', 'metal', 'cuda', 'vulkan'].includes(descriptor.backend) ||
    !Number.isInteger(descriptor.gpuLayers) ||
    descriptor.gpuLayers < 0 ||
    !Number.isInteger(descriptor.contextTokens) ||
    descriptor.contextTokens < 256 ||
    !Number.isInteger(descriptor.batchSize) ||
    descriptor.batchSize < 1 ||
    descriptor.fit.contextTokens !== descriptor.contextTokens ||
    (descriptor.backend === 'cpu' &&
      (descriptor.gpuLayers !== 0 || descriptor.fit.gpuOffloadRatio !== 0)) ||
    (descriptor.backend !== 'cpu' && descriptor.gpuLayers === 0)
  )
    throw new ManagedLocalLifecycleError(
      'backend_unavailable',
      null,
      recovery(descriptor, 'モデル実行設定を確認してください。'),
      'Invalid Managed Local descriptor',
    );
}

function recovery(
  descriptor: Pick<ManagedLocalModelDescriptor, 'contextTokens' | 'backend'>,
  detail: string,
): NonNullable<ManagedLocalRuntimeSnapshot['recovery']> {
  const lower =
    descriptor.contextTokens > 256 ? Math.max(256, Math.floor(descriptor.contextTokens / 2)) : null;
  return {
    lowerContextTokens: lower,
    useCpuOnly: descriptor.backend !== 'cpu',
    detail,
  };
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000)
    throw new RangeError('Managed Local drain timeout is invalid');
  return value;
}

function canceled(): Error {
  const error = new Error('Managed Local lease was canceled');
  error.name = 'AbortError';
  return error;
}

function disposedError(): ManagedLocalLifecycleError {
  return new ManagedLocalLifecycleError(
    'disposed',
    null,
    {
      lowerContextTokens: null,
      useCpuOnly: false,
      detail: 'アプリを再起動してください。',
    },
    'Managed Local lifecycle is disposed',
  );
}

import type {
  InstalledLocalModel,
  LocalDownloadJob,
  LocalHardwareSnapshot,
  LocalModelInstallInput,
  ManagedLocalRuntimeSnapshot,
  ProviderModel,
  PublicModelCatalogDetail,
  PublicModelCatalogDetailInput,
  PublicModelCatalogPage,
  PublicModelCatalogQuery,
} from '@sprint-coder/contracts';
import { managedLocalRuntimeSnapshotSchema } from '@sprint-coder/contracts';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { collectLocalHardwareSnapshot } from './local-hardware-inventory';
import {
  LocalModelDownloadManager,
  LocalModelDownloadRepository,
  LocalModelStore,
  type LocalModelInstallPlan,
} from './local-model-download-manager';
import { PublicModelCatalogService } from './public-model-catalog';
import type { ManagedLocalRuntimeLifecycle } from './managed-local-runtime-lifecycle';
import type { ManagedLocalModelLease } from './managed-local-runtime-lifecycle';
import type { VerifiedManagedLocalSidecarBundle } from './managed-local-sidecar-bundle';

type ControllerDependencies = Readonly<{
  databasePath: string;
  storeRoot: string;
  lifecycle: ManagedLocalRuntimeLifecycle | null;
  bundle: VerifiedManagedLocalSidecarBundle | null;
  fetch?: typeof globalThis.fetch;
  catalog?: PublicModelCatalogService;
  collectHardware?: () => Promise<LocalHardwareSnapshot>;
}>;

export class ManagedLocalController {
  private readonly repository: LocalModelDownloadRepository;
  private readonly manager: LocalModelDownloadManager;
  private readonly catalog: PublicModelCatalogService;
  private readonly collectHardware: () => Promise<LocalHardwareSnapshot>;
  private readonly plans = new Map<string, LocalModelInstallPlan>();
  private readonly requested = new Set<string>();
  private pumpPromise: Promise<void> | null = null;

  private constructor(
    private readonly lifecycle: ManagedLocalRuntimeLifecycle | null,
    private readonly bundle: VerifiedManagedLocalSidecarBundle | null,
    private readonly store: LocalModelStore,
    repository: LocalModelDownloadRepository,
    manager: LocalModelDownloadManager,
    catalog: PublicModelCatalogService,
    collectHardware: () => Promise<LocalHardwareSnapshot>,
  ) {
    this.repository = repository;
    this.manager = manager;
    this.catalog = catalog;
    this.collectHardware = collectHardware;
  }

  static async create(dependencies: ControllerDependencies): Promise<ManagedLocalController> {
    const repository = new LocalModelDownloadRepository(dependencies.databasePath);
    const store = await LocalModelStore.open(dependencies.storeRoot);
    await mkdir(join(store.rootPath, 'scratch'), { recursive: true, mode: 0o700 });
    const manager = new LocalModelDownloadManager(
      repository,
      store,
      (modelId) => dependencies.lifecycle?.assertDeletable(modelId),
      dependencies.fetch ?? globalThis.fetch,
    );
    manager.recoverInterrupted();
    const candidateBackends = dependencies.bundle?.manifest.candidateBackends ?? [];
    return new ManagedLocalController(
      dependencies.lifecycle,
      dependencies.bundle,
      store,
      repository,
      manager,
      dependencies.catalog ?? new PublicModelCatalogService(dependencies.fetch ?? globalThis.fetch),
      dependencies.collectHardware ??
        (() =>
          collectLocalHardwareSnapshot({
            backends: async () =>
              candidateBackends.map((kind) => ({ kind, status: 'available' as const })),
          })),
    );
  }

  hardware(): Promise<LocalHardwareSnapshot> {
    return this.collectHardware();
  }

  runtime(): ManagedLocalRuntimeSnapshot {
    if (this.lifecycle !== null) return this.lifecycle.snapshot();
    return managedLocalRuntimeSnapshotSchema.parse({
      state: 'unavailable',
      target: this.bundle?.target ?? null,
      runtimeVersion: this.bundle?.manifest.runtimeVersion ?? null,
      modelId: null,
      backend: null,
      activeLeaseCount: 0,
      fit: null,
      failureCode: 'unsupported_target',
      recovery: {
        lowerContextTokens: null,
        useCpuOnly: false,
        detail: 'この環境向けのManaged Local runtimeは利用できません。',
      },
      observedAt: new Date().toISOString(),
    });
  }

  query(input: PublicModelCatalogQuery): Promise<PublicModelCatalogPage> {
    return this.catalog.query(input);
  }

  detail(input: PublicModelCatalogDetailInput): Promise<PublicModelCatalogDetail> {
    return this.catalog.detail(input);
  }

  listJobs(): readonly LocalDownloadJob[] {
    return this.manager.listJobs();
  }

  listInstalled(): readonly InstalledLocalModel[] {
    return this.manager.listInstalledModels();
  }

  listProviderModels(connectionId: string, providerId: string): readonly ProviderModel[] {
    const observedAt = new Date().toISOString();
    const unknown = { value: null, source: 'unknown' as const };
    return this.manager
      .listInstalledModels()
      .filter(({ state, artifactCount }) => state === 'installed' && artifactCount === 1)
      .map((model) => ({
        connectionId,
        connectionDisplayName: 'Managed Local',
        providerId,
        providerDisplayName: 'Managed Local',
        modelAuthor: { value: model.sourceId.split('/')[0] ?? null, source: 'runtime_metadata' },
        modelId: model.id,
        displayName: `${model.sourceId} · ${model.quantization}`,
        available: this.lifecycle !== null && this.bundle !== null,
        availabilityCheckedAt: observedAt,
        contextWindow: { value: 8_192, source: 'runtime_metadata', observedAt },
        maxOutputTokens: unknown,
        // A successful G2 tool self-test promotes this capability. Merely being GGUF is not proof
        // that its embedded chat template can emit valid function calls.
        toolCalling: unknown,
        structuredOutput: unknown,
        multimodalInput: { value: false, source: 'runtime_metadata', observedAt },
        reasoning: unknown,
      }));
  }

  async acquireRuntime(
    modelId: string,
    automaticRelease: boolean,
    signal: AbortSignal,
  ): Promise<ManagedLocalModelLease> {
    if (this.lifecycle === null || this.bundle === null)
      throw new Error('Managed Local runtime is unavailable');
    const model = this.manager
      .listInstalledModels()
      .find((candidate) => candidate.id === modelId && candidate.state === 'installed');
    if (model === undefined || model.artifactCount !== 1)
      throw new Error('Managed Local model is not startable');
    const hardware = await this.collectHardware();
    const available = new Set(
      hardware.backends.filter(({ status }) => status === 'available').map(({ kind }) => kind),
    );
    const backend =
      this.bundle.manifest.candidateBackends.find(
        (candidate) => candidate !== 'cpu' && available.has(candidate),
      ) ?? 'cpu';
    if (!available.has(backend)) throw new Error('Managed Local backend is unavailable');
    const contextTokens = 8_192;
    return this.lifecycle.acquire(
      {
        id: model.id,
        modelRoot: join(this.store.rootPath, 'models', model.id),
        modelPath: join(this.store.rootPath, 'models', model.id, '001.gguf'),
        scratchRoot: join(this.store.rootPath, 'scratch'),
        backend,
        gpuLayers: backend === 'cpu' ? 0 : 999,
        contextTokens,
        batchSize: 512,
        fit: {
          weightsBytes: model.totalBytes,
          contextTokens,
          kvBytesPerToken: 128 * 1_024,
          scratchBytes: Math.max(256 * 1_024 * 1_024, Math.ceil(model.totalBytes * 0.1)),
          runtimeReserveBytes: 768 * 1_024 * 1_024,
          safetyFactor: 1.15,
          gpuOffloadRatio: backend === 'cpu' ? 0 : 0.8,
          runtimeCompatibility: 'supported',
        },
      },
      automaticRelease,
      signal,
    );
  }

  async install(input: LocalModelInstallInput): Promise<LocalDownloadJob> {
    if (input.confirmed !== true) throw new Error('Install confirmation is required');
    const detail = await this.catalog.detail({ source: input.source, sourceId: input.sourceId });
    const plan = installPlan(detail, input.artifactIds, input.quantization);
    const job = this.manager.enqueue(plan);
    this.plans.set(job.id, plan);
    this.schedule(job.id);
    return job;
  }

  pause(jobId: string): LocalDownloadJob {
    this.requested.delete(jobId);
    return this.manager.pause(jobId);
  }

  async resume(jobId: string): Promise<LocalDownloadJob> {
    const job = this.manager.getJob(jobId);
    if (!['paused', 'interrupted', 'failed'].includes(job.state)) return job;
    const plan = this.plans.get(jobId) ?? (await this.rebuildPlan(job.modelId));
    this.plans.set(jobId, plan);
    this.schedule(jobId);
    return this.manager.getJob(jobId);
  }

  cancel(jobId: string, confirmed: true): Promise<LocalDownloadJob> {
    this.requested.delete(jobId);
    return this.manager.cancel(jobId, confirmed);
  }

  async delete(modelId: string): Promise<void> {
    await this.lifecycle?.stopModel(modelId);
    await this.manager.deleteInstalled(modelId);
  }

  async dispose(): Promise<void> {
    for (const job of this.manager.listJobs())
      if (job.state === 'downloading') this.manager.pause(job.id);
    this.requested.clear();
    await this.pumpPromise;
    this.repository.close();
  }

  private schedule(jobId: string): void {
    this.requested.add(jobId);
    if (this.pumpPromise !== null) return;
    this.pumpPromise = this.pump().finally(() => {
      this.pumpPromise = null;
      if (this.requested.size > 0) this.schedule([...this.requested][0]!);
    });
  }

  private async pump(): Promise<void> {
    while (this.requested.size > 0) {
      const jobId = [...this.requested][0]!;
      this.requested.delete(jobId);
      const job = this.manager.getJob(jobId);
      if (!['queued', 'paused', 'interrupted', 'failed'].includes(job.state)) continue;
      const plan = this.plans.get(jobId) ?? (await this.rebuildPlan(job.modelId));
      this.plans.set(jobId, plan);
      await this.manager.run(jobId, plan);
    }
  }

  private async rebuildPlan(modelId: string): Promise<LocalModelInstallPlan> {
    const record = this.manager.modelRecord(modelId);
    const expected = this.manager.artifactExpectations(modelId);
    const detail = await this.catalog.detail({
      source: record.source,
      sourceId: record.sourceId,
    });
    // The store deliberately persists only a safe leaf filename. Recover the original catalog
    // artifact by its immutable size+digest identity, then let installPlan recompute and check the
    // full model id (which also binds the original path) before any byte is resumed.
    const selected = expected.map((item) => {
      const matches = detail.artifacts.filter(
        (artifact) => artifact.sizeBytes === item.sizeBytes && artifact.sha256 === item.sha256,
      );
      if (matches.length !== 1) throw new Error('Public catalog artifact identity is ambiguous');
      return matches[0]!;
    });
    if (new Set(selected.map(({ id }) => id)).size !== expected.length)
      throw new Error('Public catalog no longer matches the interrupted download');
    return installPlan(
      detail,
      selected.map(({ id }) => id),
      record.quantization,
      record.immutableRevision,
    );
  }
}

export function installPlan(
  detail: PublicModelCatalogDetail,
  artifactIds: readonly string[],
  quantization: string,
  expectedRevision?: string,
): LocalModelInstallPlan {
  if (detail.item.source !== 'hugging_face')
    throw new Error('LocalAI Gallery references require immutable resolution before install');
  const revision = detail.item.immutableRevision;
  if (revision === null || (expectedRevision !== undefined && revision !== expectedRevision))
    throw new Error('Immutable Hugging Face revision is required');
  const selected = artifactIds.map((id) => {
    const artifact = detail.artifacts.find((candidate) => candidate.id === id);
    if (
      artifact === undefined ||
      artifact.installability.state !== 'installable' ||
      artifact.format !== 'gguf' ||
      artifact.sizeBytes === null ||
      artifact.sha256 === null ||
      artifact.sourceUrl === null ||
      (artifact.quantization !== null && artifact.quantization !== quantization)
    )
      throw new Error('Selected public model artifact is not installable');
    return {
      filename: artifact.filename,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      sourceUrl: huggingFaceResolveUrl(
        artifact.sourceUrl,
        detail.item.sourceId,
        revision,
        artifact.filename,
      ),
    };
  });
  return {
    source: detail.item.source,
    sourceId: detail.item.sourceId,
    immutableRevision: revision,
    quantization,
    artifacts: selected,
  };
}

function huggingFaceResolveUrl(
  sourceUrl: string,
  sourceId: string,
  revision: string,
  filename: string,
): string {
  const view = new URL(sourceUrl);
  if (view.origin !== 'https://huggingface.co') throw new Error('Unexpected artifact origin');
  const expectedView = `/${sourceId}/blob/${revision}/${filename
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
  if (view.pathname !== expectedView) throw new Error('Artifact view URL identity changed');
  return `https://huggingface.co/${sourceId}/resolve/${revision}/${filename
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

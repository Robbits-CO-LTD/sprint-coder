import type {
  InstalledLocalModel,
  LocalDownloadJob,
  LocalHardwareSnapshot,
  LocalModelInstallInput,
  ManagedLocalRuntimeSnapshot,
  PublicModelCatalogDetail,
  PublicModelCatalogDetailInput,
  PublicModelCatalogPage,
  PublicModelCatalogQuery,
} from '@sprint-coder/contracts';
import { managedLocalRuntimeSnapshotSchema } from '@sprint-coder/contracts';
import { collectLocalHardwareSnapshot } from './local-hardware-inventory';
import {
  LocalModelDownloadManager,
  LocalModelDownloadRepository,
  LocalModelStore,
  type LocalModelInstallPlan,
} from './local-model-download-manager';
import { PublicModelCatalogService } from './public-model-catalog';
import type { ManagedLocalRuntimeLifecycle } from './managed-local-runtime-lifecycle';
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

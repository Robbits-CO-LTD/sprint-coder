import {
  MANAGED_LOCAL_TOOL_MAX_OUTPUT_TOKENS,
  managedLocalEffectiveLaunchSettingsSchema,
  managedLocalInferenceSettingsSchema,
  managedLocalLaunchSettingsSchema,
  managedLocalLaunchSettingsViewSchema,
  managedLocalInferenceSettingsViewSchema,
  managedLocalRuntimeSnapshotSchema,
  type ManagedLocalEffectiveLaunchSettings,
  type ManagedLocalInferenceSettings,
  type ManagedLocalInferenceSettingsView,
  type ManagedLocalLaunchSettings,
  type ManagedLocalLaunchSettingsView,
} from '@sprint-coder/contracts';
import type {
  InstalledLocalModel,
  LocalDownloadJob,
  LocalHardwareSnapshot,
  LocalFitAssessment,
  LocalVerificationBinding,
  LocalModelInstallInput,
  LocalModelFitInput,
  ManagedLocalRuntimeSnapshot,
  ProviderModel,
  PublicModelArtifact,
  PublicModelCatalogDetail,
  PublicModelCatalogDetailInput,
  PublicModelCatalogPage,
  PublicModelCatalogQuery,
} from '@sprint-coder/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { collectLocalHardwareSnapshot } from './local-hardware-inventory';
import { applyReusableLocalVerification, estimateLocalModelFit } from './local-fit-estimator';
import {
  LocalModelDownloadManager,
  LocalModelDownloadRepository,
  LocalModelStore,
  type LocalModelInstallPlan,
} from './local-model-download-manager';
import { PublicModelCatalogService } from './public-model-catalog';
import {
  ManagedLocalLifecycleError,
  type ManagedLocalModelLease,
  type ManagedLocalRuntimeLifecycle,
} from './managed-local-runtime-lifecycle';
import type { VerifiedManagedLocalSidecarBundle } from './managed-local-sidecar-bundle';
import { runManagedLocalSelfTest } from './managed-local-self-test';

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
      gpuLayers: null,
      contextTokens: null,
      batchSize: null,
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

  getInferenceSettings(modelId: string): ManagedLocalInferenceSettingsView {
    return managedLocalInferenceSettingsView(modelId, this.manager.getInferenceSettings(modelId));
  }

  setInferenceSettings(
    modelId: string,
    input: ManagedLocalInferenceSettings,
  ): ManagedLocalInferenceSettingsView {
    const settings = managedLocalInferenceSettingsSchema.parse(input);
    return managedLocalInferenceSettingsView(
      modelId,
      this.manager.setInferenceSettings(modelId, settings),
    );
  }

  async getLaunchSettings(modelId: string): Promise<ManagedLocalLaunchSettingsView> {
    const configured = this.manager.getLaunchSettings(modelId);
    const hardware = await this.collectHardware();
    return managedLocalLaunchSettingsView(
      modelId,
      configured,
      resolveManagedLocalLaunchSettings(configured, hardware, this.bundle),
    );
  }

  async setLaunchSettings(
    modelId: string,
    input: ManagedLocalLaunchSettings,
  ): Promise<ManagedLocalLaunchSettingsView> {
    const settings = managedLocalLaunchSettingsSchema.parse(input);
    this.assertLaunchSettingsEditable(modelId);
    const hardware = await this.collectHardware();
    const effective = resolveManagedLocalLaunchSettings(settings, hardware, this.bundle);
    if (effective === null)
      throw new Error('Managed Local backend is unavailable on this device and runtime bundle');
    const configured = this.manager.setLaunchSettings(modelId, settings);
    return managedLocalLaunchSettingsView(modelId, configured, effective);
  }

  async listProviderModels(
    connectionId: string,
    providerId: string,
  ): Promise<readonly ProviderModel[]> {
    const observedAt = new Date().toISOString();
    const unknown = { value: null, source: 'unknown' as const };
    const hardware = await this.collectHardware();
    const models = await Promise.all(
      this.manager
        .listInstalledModels()
        .filter(({ state }) => state === 'installed')
        .map(async (model): Promise<ProviderModel | null> => {
          const artifacts = this.manager.artifactExpectations(model.id);
          const modelArtifacts = artifacts.filter(({ role }) => role === 'model');
          const mmprojArtifacts = artifacts.filter(({ role }) => role === 'mmproj');
          if (modelArtifacts.length !== 1 || mmprojArtifacts.length > 1) return null;
          const configured = this.manager.getLaunchSettings(model.id);
          const effective = resolveManagedLocalLaunchSettings(configured, hardware, this.bundle);
          const verified =
            effective === null
              ? null
              : applyReusableLocalVerification(
                  {
                    state: 'unknown',
                    label: '未判定',
                    detail: 'Model Pickerでは保存済み実測の完全一致だけを確認します。',
                    breakdown: null,
                    verification: null,
                  },
                  this.verificationBinding(model.id, hardware, effective),
                  this.manager.verification(model.id),
                );
          return {
            connectionId,
            connectionDisplayName: 'Managed Local',
            providerId,
            providerDisplayName: 'Managed Local',
            modelAuthor: {
              value: model.sourceId.split('/')[0] ?? null,
              source: 'runtime_metadata',
            },
            modelId: model.id,
            displayName: `${model.sourceId} · ${model.quantization}`,
            available: this.lifecycle !== null && effective !== null,
            availabilityCheckedAt: observedAt,
            contextWindow: {
              value: effective?.contextTokens ?? configured.contextTokens,
              source: 'runtime_metadata',
              observedAt,
            },
            maxOutputTokens: unknown,
            // A successful G2 tool self-test promotes this capability. Merely being GGUF is not proof
            // that its embedded chat template can emit valid function calls.
            toolCalling:
              verified?.state === 'verified_tools'
                ? { value: true, source: 'runtime_metadata' as const, observedAt }
                : unknown,
            structuredOutput: unknown,
            multimodalInput: {
              value: mmprojArtifacts.length === 1,
              source: 'runtime_metadata',
              observedAt,
            },
            reasoning: unknown,
          };
        }),
    );
    return models.filter((model): model is ProviderModel => model !== null);
  }

  async acquireRuntime(
    modelId: string,
    automaticRelease: boolean,
    signal: AbortSignal,
    contextOverride?: number,
  ): Promise<ManagedLocalModelLease> {
    if (this.lifecycle === null || this.bundle === null)
      throw new Error('Managed Local runtime is unavailable');
    const model = this.manager
      .listInstalledModels()
      .find((candidate) => candidate.id === modelId && candidate.state === 'installed');
    if (model === undefined) throw new Error('Managed Local model is not startable');
    const artifacts = this.manager.artifactExpectations(model.id);
    const modelArtifacts = artifacts.filter(({ role }) => role === 'model');
    const mmprojArtifacts = artifacts.filter(({ role }) => role === 'mmproj');
    if (modelArtifacts.length !== 1 || mmprojArtifacts.length > 1)
      throw new Error('Managed Local model is not startable');
    const active = this.lifecycle.snapshot();
    const reusesLoadedModel = managedLocalReusesLoadedModel(active, model.id);
    if (!reusesLoadedModel) await this.manager.assertInstalledIntegrity(model.id);
    const hardware = await this.collectHardware();
    const configured = this.manager.getLaunchSettings(modelId);
    const launch = resolveManagedLocalLaunchSettings(configured, hardware, this.bundle);
    if (launch === null) throw new Error('Managed Local launch settings are unavailable');
    const contextTokens = contextOverride ?? launch.contextTokens;
    return this.lifecycle.acquire(
      {
        id: model.id,
        modelRoot: join(this.store.rootPath, 'models', model.id),
        modelPath: this.store.installedPath(model.id, this.artifactOrdinal(model.id, 'model')),
        mmprojPath:
          mmprojArtifacts.length === 1
            ? this.store.installedPath(model.id, this.artifactOrdinal(model.id, 'mmproj'))
            : null,
        scratchRoot: join(this.store.rootPath, 'scratch'),
        backend: launch.backend,
        gpuLayers: launch.gpuLayers,
        contextTokens,
        batchSize: launch.batchSize,
        fit: {
          weightsBytes: model.totalBytes,
          contextTokens,
          kvBytesPerToken: 128 * 1_024,
          scratchBytes: Math.max(256 * 1_024 * 1_024, Math.ceil(model.totalBytes * 0.1)),
          runtimeReserveBytes: 768 * 1_024 * 1_024,
          safetyFactor: 1.15,
          gpuOffloadRatio: launch.backend === 'cpu' ? 0 : 0.8,
          runtimeCompatibility: 'supported',
        },
      },
      automaticRelease,
      signal,
    );
  }

  async verify(modelId: string): Promise<LocalFitAssessment> {
    if (this.bundle === null) throw new Error('Managed Local runtime is unavailable');
    let lease: ManagedLocalModelLease | null = null;
    for (const candidate of [8_192, 4_096, 2_048, 1_024, 512, 256]) {
      try {
        lease = await this.acquireRuntime(modelId, false, new AbortController().signal, candidate);
        break;
      } catch (error) {
        if (
          !(error instanceof ManagedLocalLifecycleError) ||
          !['memory_insufficient', 'memory_unknown'].includes(error.code)
        )
          throw error;
      }
    }
    if (lease === null) throw new Error('Managed Local has insufficient memory at minimum context');
    try {
      const snapshot = this.lifecycle?.snapshot();
      if (
        snapshot?.fit === null ||
        snapshot?.fit === undefined ||
        snapshot.backend === null ||
        snapshot.contextTokens === null ||
        snapshot.batchSize === null ||
        snapshot.gpuLayers === null
      )
        throw new Error('Managed Local fit evidence is unavailable');
      const hardware = await this.collectHardware();
      const binding = this.verificationBinding(modelId, hardware, {
        backend: snapshot.backend,
        gpuLayers: snapshot.gpuLayers,
        contextTokens: snapshot.contextTokens,
        batchSize: snapshot.batchSize,
      });
      const save = (level: 'loaded' | 'tools') =>
        this.manager.saveVerification(modelId, {
          level,
          verifiedAt: new Date().toISOString(),
          binding,
        });
      await runManagedLocalSelfTest({
        session: lease.session,
        modelId,
        scratchRoot: join(this.store.rootPath, 'scratch'),
        nonce: randomUUID(),
        onLoaded: () => void save('loaded'),
      });
      const record = save('tools');
      return applyReusableLocalVerification(snapshot.fit, binding, record);
    } finally {
      await lease.release();
    }
  }

  async fit(input: LocalModelFitInput): Promise<LocalFitAssessment> {
    const detail = await this.catalog.detail({ source: input.source, sourceId: input.sourceId });
    const artifact = detail.artifacts.find(({ id }) => id === input.artifactId);
    if (artifact === undefined || artifact.role !== 'model')
      throw new Error('Public model artifact was not found');
    const mmproj =
      input.mmprojArtifactId === undefined
        ? null
        : (detail.artifacts.find(({ id }) => id === input.mmprojArtifactId) ?? null);
    if (input.mmprojArtifactId !== undefined && !compatibleMultimodalPair(artifact, mmproj))
      throw new Error('Public mmproj artifact is not compatible with the selected model');
    const weightsBytes =
      artifact.sizeBytes === null || (mmproj !== null && mmproj.sizeBytes === null)
        ? null
        : artifact.sizeBytes + (mmproj?.sizeBytes ?? 0);
    const hardware = await this.collectHardware();
    const backend = this.availableBackend(hardware);
    return estimateLocalModelFit(
      {
        weightsBytes,
        contextTokens: input.contextTokens,
        kvBytesPerToken: 128 * 1_024,
        scratchBytes:
          weightsBytes === null
            ? null
            : Math.max(256 * 1_024 * 1_024, Math.ceil(weightsBytes * 0.1)),
        runtimeReserveBytes: 768 * 1_024 * 1_024,
        safetyFactor: 1.15,
        gpuOffloadRatio: backend === null || backend === 'cpu' ? 0 : 0.8,
        runtimeCompatibility:
          artifact.format === 'gguf' &&
          artifact.installability.state === 'installable' &&
          (mmproj === null || mmproj.installability.state === 'installable')
            ? 'supported'
            : artifact.format === 'other'
              ? 'unsupported'
              : 'unknown',
        acceleratorBackend:
          backend === null ? 'unknown' : backend === 'cpu' ? 'unavailable' : 'available',
        cpuBackend: hardware.backends.find(({ kind }) => kind === 'cpu')?.status ?? 'unknown',
      },
      hardware,
    );
  }

  private availableBackend(
    hardware: LocalHardwareSnapshot,
  ): LocalVerificationBinding['backend'] | null {
    if (this.bundle === null) return null;
    const available = new Set(
      hardware.backends.filter(({ status }) => status === 'available').map(({ kind }) => kind),
    );
    const backend =
      this.bundle.manifest.candidateBackends.find(
        (candidate) => candidate !== 'cpu' && available.has(candidate),
      ) ?? 'cpu';
    return available.has(backend) ? backend : null;
  }

  private assertLaunchSettingsEditable(modelId: string): void {
    const runtime = this.lifecycle?.snapshot();
    if (runtime?.modelId === modelId && ['starting', 'running', 'stopping'].includes(runtime.state))
      throw new Error('Managed Local launch settings apply after the model is stopped');
  }

  private verificationBinding(
    modelId: string,
    hardware: LocalHardwareSnapshot,
    launch: Pick<
      ManagedLocalEffectiveLaunchSettings,
      'backend' | 'gpuLayers' | 'contextTokens' | 'batchSize'
    >,
  ): LocalVerificationBinding {
    if (this.bundle === null) throw new Error('Managed Local runtime is unavailable');
    const model = this.manager.modelRecord(modelId);
    return {
      hostCapabilityFingerprint: hardwareFingerprint(hardware),
      modelRepo: model.sourceId,
      immutableRevision: model.immutableRevision,
      artifactHashes: this.manager.artifactExpectations(modelId).map(({ sha256 }) => sha256),
      quantization: model.quantization,
      contextTokens: launch.contextTokens,
      kvCacheType: 'f16',
      batchSize: launch.batchSize,
      gpuLayers: launch.gpuLayers,
      gpuOffloadRatio: launch.backend === 'cpu' ? 0 : 0.8,
      sidecarVersion: this.bundle.manifest.runtimeVersion,
      backend: launch.backend,
    };
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
        (artifact) =>
          artifact.sizeBytes === item.sizeBytes &&
          artifact.sha256 === item.sha256 &&
          artifact.role === item.role,
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

  private artifactOrdinal(modelId: string, role: 'model' | 'mmproj'): number {
    const ordinal = this.manager
      .artifactExpectations(modelId)
      .findIndex((artifact) => artifact.role === role);
    if (ordinal < 0) throw new Error(`Managed Local ${role} artifact is missing`);
    return ordinal + 1;
  }
}

export function resolveManagedLocalLaunchSettings(
  configuredInput: ManagedLocalLaunchSettings,
  hardware: LocalHardwareSnapshot,
  bundle: VerifiedManagedLocalSidecarBundle | null,
): ManagedLocalEffectiveLaunchSettings | null {
  const configured = managedLocalLaunchSettingsSchema.safeParse(configuredInput);
  if (!configured.success || bundle === null) return null;
  const available = new Set(
    hardware.backends.filter(({ status }) => status === 'available').map(({ kind }) => kind),
  );
  const backend =
    configured.data.backend === 'auto'
      ? configured.data.gpuLayers === 0
        ? 'cpu'
        : (bundle.manifest.candidateBackends.find(
            (candidate) => candidate !== 'cpu' && available.has(candidate),
          ) ?? 'cpu')
      : configured.data.backend;
  if (!bundle.manifest.candidateBackends.includes(backend) || !available.has(backend)) return null;
  const effective = managedLocalEffectiveLaunchSettingsSchema.safeParse({
    backend,
    gpuLayers: backend === 'cpu' ? 0 : configured.data.gpuLayers,
    contextTokens: configured.data.contextTokens,
    batchSize: configured.data.batchSize,
    runtimeVersion: bundle.manifest.runtimeVersion,
  });
  return effective.success ? effective.data : null;
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
  if (new Set(artifactIds).size !== artifactIds.length)
    throw new Error('Duplicate public model artifact');
  const selectedCatalog = artifactIds.map((id) => {
    const artifact = detail.artifacts.find((candidate) => candidate.id === id);
    if (
      artifact === undefined ||
      artifact.installability.state !== 'installable' ||
      artifact.format !== 'gguf' ||
      artifact.sizeBytes === null ||
      artifact.sha256 === null ||
      artifact.sourceUrl === null ||
      (artifact.role === 'model' &&
        artifact.quantization !== null &&
        artifact.quantization !== quantization) ||
      (artifact.role === 'mmproj' && !isMmprojFilename(artifact.filename))
    )
      throw new Error('Selected public model artifact is not installable');
    return artifact;
  });
  const selectedModels = selectedCatalog.filter(({ role }) => role === 'model');
  const selectedMmproj = selectedCatalog.filter(({ role }) => role === 'mmproj');
  if (selectedModels.length === 0) throw new Error('A model GGUF artifact is required');
  if (selectedMmproj.length > 1) throw new Error('Only one mmproj artifact is supported');
  if (
    selectedMmproj.length === 1 &&
    (selectedModels.length !== 1 ||
      !compatibleMultimodalPair(selectedModels[0]!, selectedMmproj[0]))
  )
    throw new Error('Selected mmproj is not compatible with the model GGUF');
  const selected = selectedCatalog.map((artifact) => {
    return {
      role: artifact.role,
      filename: artifact.filename,
      sizeBytes: artifact.sizeBytes!,
      sha256: artifact.sha256!,
      sourceUrl: huggingFaceResolveUrl(
        artifact.sourceUrl!,
        detail.item.sourceId,
        revision,
        artifact.filename,
      ),
    };
  });
  const modelArtifacts = selected.filter(({ role }) => role === 'model');
  const mmprojArtifacts = selected.filter(({ role }) => role === 'mmproj');
  // The model is always ordinal 1 and the projector follows it. This makes the persisted bundle
  // self-describing even after a restart, while allowing callers to select the projector first.
  const ordered = [...modelArtifacts, ...mmprojArtifacts];
  return {
    source: detail.item.source,
    sourceId: detail.item.sourceId,
    immutableRevision: revision,
    quantization,
    artifacts: ordered,
  };
}

export function managedLocalReusesLoadedModel(
  snapshot: Pick<ManagedLocalRuntimeSnapshot, 'state' | 'modelId'>,
  modelId: string,
): boolean {
  return snapshot.modelId === modelId && ['starting', 'running'].includes(snapshot.state);
}

function managedLocalInferenceSettingsView(
  modelId: string,
  configuredInput: ManagedLocalInferenceSettings,
): ManagedLocalInferenceSettingsView {
  const configured = managedLocalInferenceSettingsSchema.parse(configuredInput);
  return managedLocalInferenceSettingsViewSchema.parse({
    modelId,
    configured,
    effective: {
      maxOutputTokens: configured.maxOutputTokens,
      thinking: configured.thinking,
      // llama.cpp only defines reasoning_effort=none for this API. When thinking is enabled the
      // field is omitted, so the UI can distinguish a real setting from a silently ignored one.
      reasoningEffort: configured.thinking ? null : 'none',
    },
    // Forced tool extraction is intentionally deterministic and does not inherit user thinking.
    toolCall: {
      maxOutputTokens: MANAGED_LOCAL_TOOL_MAX_OUTPUT_TOKENS,
      thinking: false,
      reasoningEffort: 'none',
    },
  });
}

function managedLocalLaunchSettingsView(
  modelId: string,
  configuredInput: ManagedLocalLaunchSettings,
  effective: ManagedLocalEffectiveLaunchSettings | null,
): ManagedLocalLaunchSettingsView {
  const configured = managedLocalLaunchSettingsSchema.parse(configuredInput);
  return managedLocalLaunchSettingsViewSchema.parse({ modelId, configured, effective });
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

function isMmprojFilename(input: string): boolean {
  return /(?:^|[-_.])mmproj(?:[-_.]|$)/iu.test(input.split(/[\\/]/u).at(-1) ?? '');
}

function compatibleMultimodalPair(
  model: PublicModelArtifact,
  mmproj: PublicModelArtifact | null | undefined,
): mmproj is PublicModelArtifact {
  return (
    model.role === 'model' &&
    mmproj?.role === 'mmproj' &&
    model.multimodalCompatibilityKey !== undefined &&
    model.multimodalCompatibilityKey !== null &&
    model.multimodalCompatibilityKey === mmproj.multimodalCompatibilityKey
  );
}

function hardwareFingerprint(hardware: LocalHardwareSnapshot): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: hardware.version,
        platform: hardware.platform,
        architecture: hardware.architecture,
        totalMemoryBytes: hardware.memory.totalBytes,
        topology: hardware.memory.topology,
        cpu: hardware.cpu,
        gpus: hardware.gpus.map(({ id, vendorId, deviceId, vendorName, deviceName, memory }) => ({
          id,
          vendorId,
          deviceId,
          vendorName,
          deviceName,
          dedicatedTotalBytes: memory.dedicatedTotalBytes,
          sharedTotalBytes: memory.sharedTotalBytes,
          unifiedTotalBytes: memory.unifiedTotalBytes,
        })),
        backends: hardware.backends,
      }),
    )
    .digest('hex');
}

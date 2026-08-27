import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import Database from 'better-sqlite3';
import {
  MANAGED_LOCAL_DEFAULT_MAX_OUTPUT_TOKENS,
  MANAGED_LOCAL_DEFAULT_BATCH_SIZE,
  MANAGED_LOCAL_DEFAULT_CONTEXT_TOKENS,
  MANAGED_LOCAL_DEFAULT_GPU_LAYERS,
  managedLocalLaunchSettingsMapSchema,
  managedLocalLaunchSettingsSchema,
  managedLocalInferenceSettingsMapSchema,
  managedLocalInferenceSettingsSchema,
  localDownloadJobSchema,
  installedLocalModelSchema,
  localVerificationRecordSchema,
  type InstalledLocalModel,
  type LocalDownloadFailureCode,
  type LocalDownloadJob,
  type LocalDownloadJobState,
  type ManagedLocalInferenceSettings,
  type ManagedLocalLaunchSettings,
  type LocalVerificationRecord,
} from '@sprint-coder/contracts';

const DIGEST = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40,64}$/u;
const MAX_ARTIFACTS = 256;
const DISK_RESERVE_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MARKER = '.sprint-coder-local-models-v1';
const INFERENCE_SETTINGS_KEY = 'managed-local.inference-settings';
const DEFAULT_INFERENCE_SETTINGS: ManagedLocalInferenceSettings = Object.freeze({
  maxOutputTokens: MANAGED_LOCAL_DEFAULT_MAX_OUTPUT_TOKENS,
  thinking: false,
});
const MAX_INFERENCE_SETTINGS_BYTES = 32 * 1024;
const LAUNCH_SETTINGS_KEY = 'managed-local.launch-settings';
const DEFAULT_LAUNCH_SETTINGS: ManagedLocalLaunchSettings = Object.freeze({
  backend: 'auto',
  gpuLayers: MANAGED_LOCAL_DEFAULT_GPU_LAYERS,
  contextTokens: MANAGED_LOCAL_DEFAULT_CONTEXT_TOKENS,
  batchSize: MANAGED_LOCAL_DEFAULT_BATCH_SIZE,
});
const MAX_LAUNCH_SETTINGS_BYTES = 32 * 1024;

export type LocalModelArtifactRole = 'model' | 'mmproj';

export type LocalModelInstallArtifact = Readonly<{
  filename: string;
  sizeBytes: number;
  sha256: string;
  sourceUrl: string;
  role: LocalModelArtifactRole;
}>;

/** Main-internal input assembled from a catalog detail; never exposed as an IPC request. */
export type LocalModelInstallPlan = Readonly<{
  source: 'hugging_face' | 'localai_gallery';
  sourceId: string;
  immutableRevision: string;
  quantization: string;
  artifacts: readonly LocalModelInstallArtifact[];
}>;

type ArtifactRow = Readonly<{
  model_id: string;
  ordinal: number;
  filename: string;
  sha256: string;
  byte_length: number;
  etag: string | null;
  downloaded_bytes: number;
  role: LocalModelArtifactRole;
  state: 'pending' | 'downloaded' | 'installed';
}>;

type JobRow = Readonly<{
  id: string;
  model_id: string;
  source_id: string;
  state: LocalDownloadJobState;
  completed_artifacts: number;
  downloaded_bytes: number;
  failure_code: LocalDownloadFailureCode | null;
  created_at: string;
  updated_at: string;
  artifact_count: number;
  total_bytes: number;
}>;

const transitions: Readonly<Record<LocalDownloadJobState, readonly LocalDownloadJobState[]>> = {
  queued: ['downloading', 'canceled'],
  downloading: ['paused', 'verifying', 'failed', 'canceled', 'interrupted'],
  paused: ['downloading', 'canceled'],
  interrupted: ['downloading', 'canceled'],
  verifying: ['installed', 'failed', 'interrupted'],
  installed: [],
  failed: ['downloading', 'canceled'],
  canceled: [],
};

export class LocalModelDownloadError extends Error {
  constructor(
    readonly code: LocalDownloadFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'LocalModelDownloadError';
  }
}

export class LocalModelDownloadRepository {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    this.db = new Database(databasePath);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    const exists = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'local_models'")
      .get();
    const hasArtifactRole = (
      this.db.prepare("PRAGMA table_info('local_model_artifacts')").all() as { name: string }[]
    ).some(({ name }) => name === 'role');
    if (exists === undefined || !hasArtifactRole) {
      this.db.close();
      throw new Error('Managed Local schema migration v77 has not been applied');
    }
  }

  create(plan: LocalModelInstallPlan, id: string, now: string): LocalDownloadJob {
    const modelId = modelIdFor(plan);
    const totalBytes = plan.artifacts.reduce((sum, item) => sum + item.sizeBytes, 0);
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO local_models(
            id, source, source_id, immutable_revision, quantization, artifact_count,
            total_bytes, state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'installing', ?, ?)`,
        )
        .run(
          modelId,
          plan.source,
          plan.sourceId,
          plan.immutableRevision,
          plan.quantization,
          plan.artifacts.length,
          totalBytes,
          now,
          now,
        );
      const insertArtifact = this.db.prepare(
        `INSERT INTO local_model_artifacts(
            model_id, ordinal, filename, sha256, byte_length, role, state
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      );
      plan.artifacts.forEach((artifact, index) =>
        insertArtifact.run(
          modelId,
          index + 1,
          safeStoredFilename(artifact.filename, index + 1),
          artifact.sha256,
          artifact.sizeBytes,
          artifact.role,
        ),
      );
      this.db
        .prepare(
          `INSERT INTO local_model_download_jobs(
            id, model_id, state, created_at, updated_at
          ) VALUES (?, ?, 'queued', ?, ?)`,
        )
        .run(id, modelId, now, now);
    })();
    return this.getJob(id);
  }

  getJob(id: string): LocalDownloadJob {
    const row = this.db
      .prepare(
        `SELECT j.*, m.source_id, m.artifact_count, m.total_bytes
         FROM local_model_download_jobs j
         JOIN local_models m ON m.id = j.model_id
         WHERE j.id = ?`,
      )
      .get(id) as JobRow | undefined;
    if (row === undefined) throw new Error('Local download job not found');
    return this.parseJob(row);
  }

  listJobs(): readonly LocalDownloadJob[] {
    const rows = this.db
      .prepare(
        `SELECT j.*, m.source_id, m.artifact_count, m.total_bytes
         FROM local_model_download_jobs j
         JOIN local_models m ON m.id = j.model_id
         ORDER BY j.created_at DESC, j.id DESC`,
      )
      .all() as JobRow[];
    return rows.map((row) => this.parseJob(row));
  }

  listInstalledModels(): readonly InstalledLocalModel[] {
    const rows = this.db
      .prepare(
        `SELECT id, source, source_id, immutable_revision, quantization, artifact_count,
                total_bytes, state, created_at, updated_at
         FROM local_models
         WHERE state IN ('installed', 'deleting', 'delete_failed')
         ORDER BY updated_at DESC, id DESC`,
      )
      .all() as Array<{
      id: string;
      source: string;
      source_id: string;
      immutable_revision: string;
      quantization: string;
      artifact_count: number;
      total_bytes: number;
      state: string;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((row) =>
      installedLocalModelSchema.parse({
        id: row.id,
        source: row.source,
        sourceId: row.source_id,
        immutableRevision: row.immutable_revision,
        quantization: row.quantization,
        artifactCount: row.artifact_count,
        totalBytes: row.total_bytes,
        state: row.state,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    );
  }

  modelRecord(modelId: string): Readonly<{
    source: 'hugging_face' | 'localai_gallery';
    sourceId: string;
    immutableRevision: string;
    quantization: string;
  }> {
    const row = this.db
      .prepare(
        `SELECT source, source_id, immutable_revision, quantization
         FROM local_models WHERE id = ?`,
      )
      .get(modelId) as
      | {
          source: 'hugging_face' | 'localai_gallery';
          source_id: string;
          immutable_revision: string;
          quantization: string;
        }
      | undefined;
    if (row === undefined) throw new Error('Local model not found');
    return {
      source: row.source,
      sourceId: row.source_id,
      immutableRevision: row.immutable_revision,
      quantization: row.quantization,
    };
  }

  artifactExpectations(modelId: string): readonly Readonly<{
    filename: string;
    sizeBytes: number;
    sha256: string;
    role: LocalModelArtifactRole;
  }>[] {
    return this.artifacts(modelId).map((artifact) => ({
      filename: artifact.filename.replace(/^\d{3}-/u, ''),
      sizeBytes: artifact.byte_length,
      sha256: artifact.sha256,
      role: artifact.role,
    }));
  }

  verification(modelId: string): LocalVerificationRecord | null {
    const row = this.db
      .prepare(
        'SELECT level, verified_at, binding_json FROM local_model_verifications WHERE model_id = ?',
      )
      .get(modelId) as { level: string; verified_at: string; binding_json: string } | undefined;
    if (row === undefined) return null;
    return localVerificationRecordSchema.parse({
      level: row.level,
      verifiedAt: row.verified_at,
      binding: JSON.parse(row.binding_json) as unknown,
    });
  }

  saveVerification(modelId: string, input: LocalVerificationRecord): LocalVerificationRecord {
    const record = localVerificationRecordSchema.parse(input);
    this.db
      .prepare(
        `INSERT INTO local_model_verifications(model_id, level, verified_at, binding_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(model_id) DO UPDATE SET
           level = excluded.level,
           verified_at = excluded.verified_at,
           binding_json = excluded.binding_json`,
      )
      .run(modelId, record.level, record.verifiedAt, JSON.stringify(record.binding));
    return this.verification(modelId)!;
  }

  getInferenceSettings(modelId: string): ManagedLocalInferenceSettings {
    this.assertInstalledInferenceModel(modelId);
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(INFERENCE_SETTINGS_KEY) as { value: string } | undefined;
    if (row === undefined || Buffer.byteLength(row.value, 'utf8') > MAX_INFERENCE_SETTINGS_BYTES)
      return { ...DEFAULT_INFERENCE_SETTINGS };
    try {
      const map = managedLocalInferenceSettingsMapSchema.parse(JSON.parse(row.value) as unknown);
      return map[modelId] === undefined ? { ...DEFAULT_INFERENCE_SETTINGS } : { ...map[modelId] };
    } catch {
      // A malformed optional settings blob must not prevent a downloaded model from running.
      return { ...DEFAULT_INFERENCE_SETTINGS };
    }
  }

  setInferenceSettings(
    modelId: string,
    input: ManagedLocalInferenceSettings,
  ): ManagedLocalInferenceSettings {
    this.assertInstalledInferenceModel(modelId);
    const settings = managedLocalInferenceSettingsSchema.parse(input);
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(INFERENCE_SETTINGS_KEY) as { value: string } | undefined;
    let current: Record<string, ManagedLocalInferenceSettings> = {};
    if (row !== undefined && Buffer.byteLength(row.value, 'utf8') <= MAX_INFERENCE_SETTINGS_BYTES) {
      try {
        current = managedLocalInferenceSettingsMapSchema.parse(JSON.parse(row.value) as unknown);
      } catch {
        // Replace only the malformed optional blob; the model itself remains intact.
      }
    }
    current[modelId] = settings;
    const serialized = JSON.stringify(managedLocalInferenceSettingsMapSchema.parse(current));
    if (Buffer.byteLength(serialized, 'utf8') > MAX_INFERENCE_SETTINGS_BYTES)
      throw new Error('Managed Local inference settings are too large');
    this.db
      .prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(INFERENCE_SETTINGS_KEY, serialized, new Date().toISOString());
    return { ...settings };
  }

  getLaunchSettings(modelId: string): ManagedLocalLaunchSettings {
    this.assertInstalledLaunchModel(modelId);
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(LAUNCH_SETTINGS_KEY) as { value: string } | undefined;
    if (row === undefined || Buffer.byteLength(row.value, 'utf8') > MAX_LAUNCH_SETTINGS_BYTES)
      return this.defaultLaunchSettings(modelId);
    try {
      const map = managedLocalLaunchSettingsMapSchema.parse(JSON.parse(row.value) as unknown);
      return map[modelId] === undefined ? this.defaultLaunchSettings(modelId) : { ...map[modelId] };
    } catch {
      // A malformed optional settings blob must not prevent an installed model from running.
      return this.defaultLaunchSettings(modelId);
    }
  }

  setLaunchSettings(
    modelId: string,
    input: ManagedLocalLaunchSettings,
  ): ManagedLocalLaunchSettings {
    this.assertInstalledLaunchModel(modelId);
    const settings = managedLocalLaunchSettingsSchema.parse(input);
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(LAUNCH_SETTINGS_KEY) as { value: string } | undefined;
    let current: Record<string, ManagedLocalLaunchSettings> = {};
    if (row !== undefined && Buffer.byteLength(row.value, 'utf8') <= MAX_LAUNCH_SETTINGS_BYTES) {
      try {
        current = managedLocalLaunchSettingsMapSchema.parse(JSON.parse(row.value) as unknown);
      } catch {
        // Replace only the malformed optional blob; the model itself remains intact.
      }
    }
    current[modelId] = settings;
    const serialized = JSON.stringify(managedLocalLaunchSettingsMapSchema.parse(current));
    if (Buffer.byteLength(serialized, 'utf8') > MAX_LAUNCH_SETTINGS_BYTES)
      throw new Error('Managed Local launch settings are too large');
    this.db
      .prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(LAUNCH_SETTINGS_KEY, serialized, new Date().toISOString());
    return { ...settings };
  }

  private assertInstalledInferenceModel(modelId: string): void {
    if (!DIGEST.test(modelId)) throw new Error('Invalid Managed Local model id');
    const row = this.db.prepare('SELECT state FROM local_models WHERE id = ?').get(modelId) as
      { state: string } | undefined;
    const artifacts = row?.state === 'installed' ? this.artifacts(modelId) : [];
    if (
      artifacts.filter(({ role }) => role === 'model').length !== 1 ||
      artifacts.filter(({ role }) => role === 'mmproj').length > 1
    )
      throw new Error('Managed Local model is not available for inference settings');
  }

  private assertInstalledLaunchModel(modelId: string): void {
    if (!DIGEST.test(modelId)) throw new Error('Invalid Managed Local model id');
    const row = this.db
      .prepare('SELECT state, artifact_count FROM local_models WHERE id = ?')
      .get(modelId) as { state: string; artifact_count: number } | undefined;
    if (row?.state !== 'installed' || row.artifact_count < 1)
      throw new Error('Managed Local model is not available for launch settings');
  }

  private defaultLaunchSettings(modelId: string): ManagedLocalLaunchSettings {
    const contextTokens =
      this.verification(modelId)?.binding.contextTokens ?? MANAGED_LOCAL_DEFAULT_CONTEXT_TOKENS;
    return {
      ...DEFAULT_LAUNCH_SETTINGS,
      // Preserve the pre-settings behavior for models whose verified fit selected a lower context.
      contextTokens,
      batchSize: Math.min(MANAGED_LOCAL_DEFAULT_BATCH_SIZE, contextTokens),
    };
  }

  private parseJob(row: JobRow): LocalDownloadJob {
    return localDownloadJobSchema.parse({
      id: row.id,
      modelId: row.model_id,
      sourceId: row.source_id,
      state: row.state,
      artifactCount: row.artifact_count,
      completedArtifacts: row.completed_artifacts,
      downloadedBytes: row.downloaded_bytes,
      totalBytes: row.total_bytes,
      failureCode: row.failure_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  artifacts(modelId: string): readonly ArtifactRow[] {
    return this.db
      .prepare('SELECT * FROM local_model_artifacts WHERE model_id = ? ORDER BY ordinal')
      .all(modelId) as ArtifactRow[];
  }

  transition(
    id: string,
    to: LocalDownloadJobState,
    now: string,
    failureCode: LocalDownloadFailureCode | null = null,
  ): LocalDownloadJob {
    const current = this.getJob(id);
    if (!transitions[current.state].includes(to))
      throw new Error(`Invalid local download transition: ${current.state} -> ${to}`);
    this.db
      .prepare(
        'UPDATE local_model_download_jobs SET state = ?, failure_code = ?, updated_at = ? WHERE id = ?',
      )
      .run(to, failureCode, now, id);
    return this.getJob(id);
  }

  progress(jobId: string, ordinal: number, bytes: number, etag: string | null): void {
    const job = this.getJob(jobId);
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE local_model_artifacts
           SET downloaded_bytes = ?, etag = COALESCE(?, etag)
           WHERE model_id = ? AND ordinal = ? AND state = 'pending'`,
        )
        .run(bytes, etag, job.modelId, ordinal);
      const total = this.db
        .prepare(
          'SELECT COALESCE(SUM(downloaded_bytes), 0) AS total FROM local_model_artifacts WHERE model_id = ?',
        )
        .get(job.modelId) as { total: number };
      this.db
        .prepare('UPDATE local_model_download_jobs SET downloaded_bytes = ? WHERE id = ?')
        .run(total.total, jobId);
    })();
  }

  artifactDownloaded(jobId: string, ordinal: number, now: string): void {
    const job = this.getJob(jobId);
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE local_model_artifacts
           SET state = 'downloaded', downloaded_bytes = byte_length
           WHERE model_id = ? AND ordinal = ? AND state = 'pending'`,
        )
        .run(job.modelId, ordinal);
      const count = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM local_model_artifacts WHERE model_id = ? AND state = 'downloaded'",
        )
        .get(job.modelId) as { count: number };
      const total = this.db
        .prepare(
          'SELECT SUM(downloaded_bytes) AS total FROM local_model_artifacts WHERE model_id = ?',
        )
        .get(job.modelId) as { total: number };
      this.db
        .prepare(
          'UPDATE local_model_download_jobs SET completed_artifacts = ?, downloaded_bytes = ?, updated_at = ? WHERE id = ?',
        )
        .run(count.count, total.total, now, jobId);
    })();
  }

  markInstalled(jobId: string, now: string): LocalDownloadJob {
    const job = this.getJob(jobId);
    const completeness = this.db
      .prepare(
        `SELECT COUNT(*) AS count, MIN(ordinal) AS first, MAX(ordinal) AS last,
                SUM(byte_length) AS expected_bytes, SUM(downloaded_bytes) AS downloaded_bytes,
                SUM(CASE WHEN state = 'downloaded' THEN 1 ELSE 0 END) AS downloaded_count
         FROM local_model_artifacts WHERE model_id = ?`,
      )
      .get(job.modelId) as {
      count: number;
      first: number | null;
      last: number | null;
      expected_bytes: number | null;
      downloaded_bytes: number | null;
      downloaded_count: number;
    };
    if (
      job.state !== 'verifying' ||
      completeness.count !== job.artifactCount ||
      completeness.first !== 1 ||
      completeness.last !== job.artifactCount ||
      completeness.downloaded_count !== job.artifactCount ||
      completeness.downloaded_bytes !== completeness.expected_bytes ||
      completeness.downloaded_bytes !== job.totalBytes
    )
      throw new LocalModelDownloadError('missing_shard', 'Every shard must be verified first');
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE local_model_artifacts SET state = 'installed' WHERE model_id = ? AND state = 'downloaded'",
        )
        .run(job.modelId);
      this.db
        .prepare("UPDATE local_models SET state = 'installed', updated_at = ? WHERE id = ?")
        .run(now, job.modelId);
      this.db
        .prepare(
          "UPDATE local_model_download_jobs SET state = 'installed', updated_at = ? WHERE id = ?",
        )
        .run(now, jobId);
    })();
    return this.getJob(jobId);
  }

  recoverInterrupted(now: string): number {
    return this.db
      .prepare(
        `UPDATE local_model_download_jobs
         SET state = 'interrupted', updated_at = ?
         WHERE state IN ('downloading', 'verifying')`,
      )
      .run(now).changes;
  }

  removeModel(modelId: string): void {
    this.db.prepare('DELETE FROM local_models WHERE id = ?').run(modelId);
  }

  markDeleteFailed(modelId: string, now: string): void {
    this.db
      .prepare("UPDATE local_models SET state = 'delete_failed', updated_at = ? WHERE id = ?")
      .run(now, modelId);
  }

  beginDelete(modelId: string, now: string): void {
    const row = this.db.prepare('SELECT state FROM local_models WHERE id = ?').get(modelId) as
      { state: string } | undefined;
    if (!['installed', 'deleting', 'delete_failed'].includes(row?.state ?? ''))
      throw new Error('Model is not deletable');
    this.db
      .prepare("UPDATE local_models SET state = 'deleting', updated_at = ? WHERE id = ?")
      .run(now, modelId);
  }

  close(): void {
    this.db.close();
  }
}

export class LocalModelStore {
  private constructor(readonly rootPath: string) {}

  static async open(rootPath: string): Promise<LocalModelStore> {
    await mkdir(rootPath, { recursive: true, mode: 0o700 });
    const lexical = await lstat(rootPath);
    if (!lexical.isDirectory() || lexical.isSymbolicLink())
      throw new LocalModelDownloadError('unsafe_store', 'Model root must be a real directory');
    const canonical = await realpath(rootPath);
    await mkdir(join(canonical, 'partials'), { recursive: true, mode: 0o700 });
    await mkdir(join(canonical, 'models'), { recursive: true, mode: 0o700 });
    const markerPath = join(canonical, MARKER);
    try {
      await writeFile(markerPath, 'managed-local-v1\n', { flag: 'wx', mode: 0o600 });
    } catch (error: unknown) {
      if (!isNodeError(error, 'EEXIST')) throw error;
      const marker = await lstat(markerPath);
      if (!marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1)
        throw new LocalModelDownloadError('unsafe_store', 'Model root marker is unsafe');
      if ((await readFile(markerPath, 'utf8')) !== 'managed-local-v1\n')
        throw new LocalModelDownloadError('unsafe_store', 'Model root marker is invalid');
    }
    for (const name of await readdir(join(canonical, 'models'))) {
      if (!/^\.staging-[a-f0-9]{64}$/u.test(name)) continue;
      const staging = join(canonical, 'models', name);
      const info = await lstat(staging);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new LocalModelDownloadError('unsafe_store', 'Staging model directory is unsafe');
      await assertFlatPrivateDirectory(staging);
      await rm(staging, { recursive: true });
    }
    return new LocalModelStore(canonical);
  }

  partialPath(modelId: string, ordinal: number): string {
    assertModelId(modelId);
    if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > MAX_ARTIFACTS)
      throw new LocalModelDownloadError('unsafe_store', 'Invalid artifact ordinal');
    return join(
      this.rootPath,
      'partials',
      `${modelId}-${String(ordinal).padStart(3, '0')}.partial`,
    );
  }

  installedPath(modelId: string, ordinal: number): string {
    assertModelId(modelId);
    if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > MAX_ARTIFACTS)
      throw new LocalModelDownloadError('unsafe_store', 'Invalid artifact ordinal');
    return join(this.rootPath, 'models', modelId, `${String(ordinal).padStart(3, '0')}.gguf`);
  }

  async publish(modelId: string, artifacts: readonly ArtifactRow[]): Promise<void> {
    assertModelId(modelId);
    if (artifacts.length === 0 || artifacts.some((item) => item.state !== 'downloaded'))
      throw new LocalModelDownloadError('missing_shard', 'A model shard is missing');
    const modelsRoot = join(this.rootPath, 'models');
    const staging = join(modelsRoot, `.staging-${modelId}`);
    const finalPath = join(modelsRoot, modelId);
    try {
      await lstat(finalPath);
      throw new LocalModelDownloadError('unsafe_store', 'Installed model path already exists');
    } catch (error: unknown) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
    await mkdir(staging, { mode: 0o700 });
    const moved: { source: string; destination: string }[] = [];
    try {
      for (const artifact of artifacts) {
        const source = this.partialPath(modelId, artifact.ordinal);
        const info = await lstat(source);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
          throw new LocalModelDownloadError(
            'unsafe_store',
            'Model shard is not a private regular file',
          );
        const suffix =
          extname(basename(artifact.filename)).toLowerCase() === '.gguf' ? '.gguf' : '.bin';
        const destination = join(staging, `${String(artifact.ordinal).padStart(3, '0')}${suffix}`);
        await rename(source, destination);
        moved.push({ source, destination });
      }
      await rename(staging, finalPath);
    } catch (error) {
      for (const item of moved.reverse())
        await rename(item.destination, item.source).catch(() => undefined);
      await rm(staging, { recursive: true }).catch(() => undefined);
      throw error;
    }
  }

  async cancel(modelId: string, count: number): Promise<void> {
    for (let ordinal = 1; ordinal <= count; ordinal += 1)
      await unlink(this.partialPath(modelId, ordinal)).catch((error: unknown) => {
        if (!isNodeError(error, 'ENOENT')) throw error;
      });
  }

  async deleteInstalled(modelId: string): Promise<void> {
    assertModelId(modelId);
    const target = join(this.rootPath, 'models', modelId);
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new LocalModelDownloadError('unsafe_store', 'Installed model directory is unsafe');
    await assertFlatPrivateDirectory(target);
    await rm(target, { recursive: true });
  }
}

export class LocalModelDownloadManager {
  private readonly controllers = new Map<string, AbortController>();
  private activeJobId: string | null = null;

  constructor(
    private readonly repository: LocalModelDownloadRepository,
    private readonly store: LocalModelStore,
    private readonly assertModelDeletable: (modelId: string) => void,
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly availableBytes: (path: string) => Promise<number> = async (path) => {
      const value = await statfs(path, { bigint: true });
      return Number(value.bavail * value.bsize);
    },
  ) {}

  recoverInterrupted(): number {
    return this.repository.recoverInterrupted(this.now());
  }

  getJob(jobId: string): LocalDownloadJob {
    return this.repository.getJob(jobId);
  }

  listJobs(): readonly LocalDownloadJob[] {
    return this.repository.listJobs();
  }

  listInstalledModels(): readonly InstalledLocalModel[] {
    return this.repository.listInstalledModels();
  }

  modelRecord(modelId: string): ReturnType<LocalModelDownloadRepository['modelRecord']> {
    return this.repository.modelRecord(modelId);
  }

  artifactExpectations(
    modelId: string,
  ): ReturnType<LocalModelDownloadRepository['artifactExpectations']> {
    return this.repository.artifactExpectations(modelId);
  }

  /**
   * Re-checks the immutable bytes before a runtime consumes an installed bundle. The download
   * hash check protects the network-to-store transition; this second check protects the later
   * runtime boundary from an on-disk replacement, symlink, or hardlink.
   */
  async assertInstalledIntegrity(modelId: string): Promise<void> {
    assertModelId(modelId);
    const rows = this.repository.artifacts(modelId);
    if (rows.length === 0 || rows.some((row) => row.state !== 'installed'))
      throw new LocalModelDownloadError(
        'missing_shard',
        'Installed model artifacts are incomplete',
      );
    for (const row of rows) {
      const path = this.store.installedPath(modelId, row.ordinal);
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(path);
      } catch (error: unknown) {
        if (isNodeError(error, 'ENOENT'))
          throw new LocalModelDownloadError('missing_shard', 'Installed model artifact is missing');
        throw error;
      }
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw new LocalModelDownloadError(
          'unsafe_store',
          'Installed model artifact is not a private regular file',
        );
      if (info.size !== row.byte_length)
        throw new LocalModelDownloadError('size_changed', 'Installed model artifact size changed');
      if ((await sha256File(path)) !== row.sha256)
        throw new LocalModelDownloadError(
          'hash_mismatch',
          'Installed model artifact hash mismatch',
        );
    }
  }

  verification(modelId: string): LocalVerificationRecord | null {
    return this.repository.verification(modelId);
  }

  saveVerification(modelId: string, record: LocalVerificationRecord): LocalVerificationRecord {
    return this.repository.saveVerification(modelId, record);
  }

  getInferenceSettings(modelId: string): ManagedLocalInferenceSettings {
    return this.repository.getInferenceSettings(modelId);
  }

  setInferenceSettings(
    modelId: string,
    settings: ManagedLocalInferenceSettings,
  ): ManagedLocalInferenceSettings {
    return this.repository.setInferenceSettings(modelId, settings);
  }

  getLaunchSettings(modelId: string): ManagedLocalLaunchSettings {
    return this.repository.getLaunchSettings(modelId);
  }

  setLaunchSettings(
    modelId: string,
    settings: ManagedLocalLaunchSettings,
  ): ManagedLocalLaunchSettings {
    return this.repository.setLaunchSettings(modelId, settings);
  }

  enqueue(input: LocalModelInstallPlan): LocalDownloadJob {
    const plan = validatePlan(input);
    return this.repository.create(plan, randomUUID(), this.now());
  }

  async run(jobId: string, planInput: LocalModelInstallPlan): Promise<LocalDownloadJob> {
    const plan = validatePlan(planInput);
    let job = this.repository.getJob(jobId);
    if (job.modelId !== modelIdFor(plan)) throw new Error('Install plan does not match job');
    if (this.activeJobId !== null) throw new Error('Another model download is active');
    job = this.repository.transition(jobId, 'downloading', this.now());
    this.activeJobId = jobId;
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    try {
      const rows = this.repository.artifacts(job.modelId);
      for (const row of rows) {
        if (row.state !== 'pending') continue;
        const artifact = plan.artifacts[row.ordinal - 1];
        if (artifact === undefined)
          throw new LocalModelDownloadError('missing_shard', 'Install plan shard is missing');
        await this.downloadArtifact(jobId, job.modelId, row, artifact, controller.signal);
        this.repository.artifactDownloaded(jobId, row.ordinal, this.now());
      }
      this.repository.transition(jobId, 'verifying', this.now());
      await this.store.publish(job.modelId, this.repository.artifacts(job.modelId));
      return this.repository.markInstalled(jobId, this.now());
    } catch (error: unknown) {
      const current = this.repository.getJob(jobId);
      if (current.state === 'paused' || current.state === 'canceled') return current;
      const failure = normalizeFailure(error);
      return this.repository.transition(jobId, 'failed', this.now(), failure.code);
    } finally {
      this.controllers.delete(jobId);
      this.activeJobId = null;
    }
  }

  pause(jobId: string): LocalDownloadJob {
    const job = this.repository.transition(jobId, 'paused', this.now());
    this.controllers.get(jobId)?.abort();
    return job;
  }

  async cancel(jobId: string, confirmed: boolean): Promise<LocalDownloadJob> {
    if (!confirmed) throw new Error('Cancel confirmation is required');
    const current = this.repository.getJob(jobId);
    this.controllers.get(jobId)?.abort();
    await this.store.cancel(current.modelId, current.artifactCount);
    const latest = this.repository.getJob(jobId);
    return this.repository.transition(jobId, 'canceled', this.now(), latest.failureCode);
  }

  async deleteInstalled(modelId: string): Promise<void> {
    this.assertModelDeletable(modelId);
    this.repository.beginDelete(modelId, this.now());
    try {
      await this.store.deleteInstalled(modelId);
      this.repository.removeModel(modelId);
    } catch (error) {
      this.repository.markDeleteFailed(modelId, this.now());
      throw error;
    }
  }

  private async downloadArtifact(
    jobId: string,
    modelId: string,
    row: ArtifactRow,
    artifact: LocalModelInstallArtifact,
    signal: AbortSignal,
  ): Promise<void> {
    const partial = this.store.partialPath(modelId, row.ordinal);
    let offset = await safePartialSize(partial);
    if (offset !== row.downloaded_bytes || offset > artifact.sizeBytes) {
      await unlink(partial).catch(() => undefined);
      offset = 0;
      this.repository.progress(jobId, row.ordinal, 0, null);
    }
    const remaining = artifact.sizeBytes - offset;
    if ((await this.availableBytes(this.store.rootPath)) < remaining + DISK_RESERVE_BYTES)
      throw new LocalModelDownloadError('disk_full', 'Insufficient free space for model artifact');
    const headers = new Headers();
    if (offset > 0) {
      headers.set('range', `bytes=${offset}-`);
      if (row.etag !== null) headers.set('if-range', row.etag);
    }
    const response = await fetchValidated(this.fetch, artifact.sourceUrl, { headers, signal });
    if (offset > 0 && response.status === 200) {
      await unlink(partial).catch(() => undefined);
      offset = 0;
      this.repository.progress(jobId, row.ordinal, 0, response.headers.get('etag'));
    } else if (offset > 0) {
      if (
        response.status !== 206 ||
        contentRangeStart(response.headers.get('content-range')) !== offset
      )
        throw new LocalModelDownloadError(
          'source_changed',
          'Remote artifact cannot be resumed safely',
        );
      const etag = response.headers.get('etag');
      if (row.etag !== null && etag !== null && row.etag !== etag)
        throw new LocalModelDownloadError('source_changed', 'Remote artifact identity changed');
    }
    if (!response.ok || response.body === null)
      throw new LocalModelDownloadError('network', 'Model artifact request failed');
    const contentLength = positiveHeaderInteger(response.headers.get('content-length'));
    const expectedResponseBytes = artifact.sizeBytes - offset;
    if (contentLength === null)
      throw new LocalModelDownloadError('size_unknown', 'Remote artifact size is unknown');
    if (contentLength !== expectedResponseBytes)
      throw new LocalModelDownloadError('size_changed', 'Remote artifact size changed');
    const handle = await openPartial(partial, offset > 0);
    try {
      const reader = response.body.getReader();
      let written = offset;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (written + chunk.value.byteLength > artifact.sizeBytes)
          throw new LocalModelDownloadError(
            'size_changed',
            'Remote artifact exceeded declared size',
          );
        await handle.write(chunk.value);
        written += chunk.value.byteLength;
        this.repository.progress(jobId, row.ordinal, written, response.headers.get('etag'));
      }
      await handle.sync();
      if (written !== artifact.sizeBytes)
        throw new LocalModelDownloadError(
          'size_changed',
          'Remote artifact ended before declared size',
        );
    } finally {
      await handle.close();
    }
    if ((await sha256File(partial)) !== artifact.sha256) {
      await unlink(partial).catch(() => undefined);
      this.repository.progress(jobId, row.ordinal, 0, null);
      throw new LocalModelDownloadError('hash_mismatch', 'Model artifact hash mismatch');
    }
  }
}

function validatePlan(input: LocalModelInstallPlan): LocalModelInstallPlan {
  if (!['hugging_face', 'localai_gallery'].includes(input.source))
    throw new Error('Invalid source');
  if (input.sourceId.length < 1 || input.sourceId.length > 256)
    throw new Error('Invalid source id');
  if (!REVISION.test(input.immutableRevision)) throw new Error('Immutable revision is required');
  if (input.quantization.length < 1 || input.quantization.length > 64)
    throw new Error('Invalid quantization');
  if (input.artifacts.length < 1 || input.artifacts.length > MAX_ARTIFACTS)
    throw new Error('Invalid artifact count');
  const artifacts = input.artifacts.map((artifact) => {
    if (artifact.filename.length < 1 || artifact.filename.length > 512)
      throw new Error('Invalid artifact filename');
    if (!['model', 'mmproj'].includes(artifact.role)) throw new Error('Invalid artifact role');
    if (!artifact.filename.toLowerCase().endsWith('.gguf'))
      throw new Error('Managed Local artifacts must be GGUF files');
    if (artifact.role === 'mmproj' && !isMmprojFilename(artifact.filename))
      throw new Error('mmproj artifact filename is not recognized');
    if (artifact.role === 'model' && isMmprojFilename(artifact.filename))
      throw new Error('mmproj artifact must be classified explicitly');
    if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 1)
      throw new LocalModelDownloadError('size_unknown', 'Artifact size is required');
    if (!DIGEST.test(artifact.sha256)) throw new Error('Artifact SHA-256 is required');
    assertPlanSourceUrl(input, artifact.sourceUrl);
    return input.source === 'localai_gallery'
      ? { ...artifact, sourceUrl: pinGallerySourceUrl(artifact.sourceUrl, input.immutableRevision) }
      : artifact;
  });
  const modelArtifacts = artifacts.filter(({ role }) => role === 'model');
  const projectorArtifacts = artifacts.filter(({ role }) => role === 'mmproj');
  if (modelArtifacts.length === 0) throw new Error('A model artifact is required');
  if (projectorArtifacts.length > 1) throw new Error('Only one mmproj artifact is supported');
  const totalBytes = artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
  if (!Number.isSafeInteger(totalBytes)) throw new Error('Model download size exceeds safe bounds');
  return { ...input, artifacts };
}

function modelIdFor(plan: LocalModelInstallPlan): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        source: plan.source,
        sourceId: plan.sourceId,
        revision: plan.immutableRevision,
        quantization: plan.quantization,
        artifacts: plan.artifacts.some(({ role }) => role === 'mmproj')
          ? plan.artifacts.map(({ filename, sizeBytes, sha256, role }) => ({
              filename,
              sizeBytes,
              sha256,
              role,
            }))
          : plan.artifacts.map(({ filename, sizeBytes, sha256 }) => ({
              filename,
              sizeBytes,
              sha256,
            })),
      }),
    )
    .digest('hex');
}

function assertAllowedSourceUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '')
    throw new Error('Unsafe model source URL');
  const host = url.hostname.toLowerCase();
  const allowed =
    host === 'huggingface.co' ||
    host.endsWith('.huggingface.co') ||
    host === 'hf.co' ||
    host.endsWith('.hf.co') ||
    host === 'xethub.hf.co' ||
    host.endsWith('.xethub.hf.co') ||
    host === 'raw.githubusercontent.com';
  if (!allowed || /%(?:2e|2f|5c)/iu.test(url.pathname)) throw new Error('Unsafe model source URL');
  return url;
}

function assertPlanSourceUrl(plan: LocalModelInstallPlan, input: string): void {
  const url = assertAllowedSourceUrl(input);
  if (plan.source === 'hugging_face') {
    const sourceParts = plan.sourceId.split('/');
    if (
      sourceParts.length !== 2 ||
      sourceParts.some((part) => !/^[a-zA-Z0-9._-]+$/u.test(part)) ||
      url.origin !== 'https://huggingface.co'
    )
      throw new Error('Unsafe Hugging Face source identity');
    const expectedPrefix = `/${sourceParts[0]}/${sourceParts[1]}/resolve/${plan.immutableRevision}/`;
    if (!url.pathname.startsWith(expectedPrefix))
      throw new Error('Artifact URL is not bound to the immutable model revision');
    return;
  }
  if (
    url.origin !== 'https://huggingface.co' ||
    !/^\/[^/]+\/[^/]+\/resolve\/(?:main|[a-f0-9]{40,64})\/.+/u.test(url.pathname)
  )
    throw new Error('Artifact URL is outside the pinned LocalAI Gallery resolver');
}

function pinGallerySourceUrl(input: string, immutableRevision: string): string {
  const url = new URL(input);
  const parts = url.pathname.split('/');
  const resolveIndex = parts.indexOf('resolve');
  if (resolveIndex < 0 || resolveIndex + 2 >= parts.length)
    throw new Error('Invalid LocalAI Gallery resolver URL');
  parts[resolveIndex + 1] = immutableRevision;
  url.pathname = parts.join('/');
  return url.toString();
}

function safeStoredFilename(input: string, ordinal: number): string {
  const leaf = input.split(/[\\/]/u).at(-1)?.replace(/[:\0]/gu, '_') ?? 'artifact.gguf';
  const safeLeaf = leaf === '' || leaf === '.' || leaf === '..' ? 'artifact.gguf' : leaf;
  return `${String(ordinal).padStart(3, '0')}-${safeLeaf}`.slice(0, 512);
}

function isMmprojFilename(input: string): boolean {
  return /(?:^|[-_.])mmproj(?:[-_.]|$)/iu.test(input.split(/[\\/]/u).at(-1) ?? '');
}

async function fetchValidated(
  fetcher: typeof globalThis.fetch,
  input: string,
  init: RequestInit,
): Promise<Response> {
  let current = input;
  for (let count = 0; count <= MAX_REDIRECTS; count += 1) {
    assertAllowedSourceUrl(current);
    const response = await fetcher(current, { ...init, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (location === null || count === MAX_REDIRECTS)
      throw new LocalModelDownloadError('network', 'Invalid model artifact redirect');
    current = new URL(location, current).toString();
  }
  throw new LocalModelDownloadError('network', 'Too many model artifact redirects');
}

async function openPartial(path: string, append: boolean): Promise<FileHandle> {
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_NOFOLLOW |
    (append ? constants.O_APPEND : constants.O_TRUNC);
  const handle = await open(path, flags, 0o600);
  const info = await handle.stat();
  if (!info.isFile() || info.nlink !== 1) {
    await handle.close();
    throw new LocalModelDownloadError('unsafe_store', 'Partial artifact is unsafe');
  }
  return handle;
}

async function safePartialSize(path: string): Promise<number> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new LocalModelDownloadError('unsafe_store', 'Partial artifact is unsafe');
    return info.size;
  } catch (error: unknown) {
    if (isNodeError(error, 'ENOENT')) return 0;
    throw error;
  }
}

async function assertFlatPrivateDirectory(path: string): Promise<void> {
  for (const name of await readdir(path)) {
    const info = await lstat(join(path, name));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new LocalModelDownloadError('unsafe_store', 'Model directory contains an unsafe entry');
  }
}

async function sha256File(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

function positiveHeaderInteger(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function contentRangeStart(value: string | null): number | null {
  const match = /^bytes (\d+)-\d+\/\d+$/u.exec(value ?? '');
  return match === null ? null : Number(match[1]);
}

function assertModelId(value: string): void {
  if (!DIGEST.test(value)) throw new LocalModelDownloadError('unsafe_store', 'Invalid model id');
}

function normalizeFailure(error: unknown): LocalModelDownloadError {
  if (error instanceof LocalModelDownloadError) return error;
  return new LocalModelDownloadError('network', 'Model download failed');
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

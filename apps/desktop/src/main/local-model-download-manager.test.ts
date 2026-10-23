import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type * as FsPromises from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqlitePersistenceClient } from './persistence';
import { electronTestExecutablePath } from './electron-test-runtime';
import { PublicModelCatalogService } from './public-model-catalog';
import { ManagedLocalController } from './managed-local-controller';
import { ManagedLocalRuntimeLifecycle } from './managed-local-runtime-lifecycle';
import {
  ManagedLocalRuntimeSupervisor,
  type ManagedLocalRuntimeStartInput,
  type ManagedLocalRuntimeSession,
} from './managed-local-runtime-supervisor';
import type { VerifiedManagedLocalSidecarBundle } from './managed-local-sidecar-bundle';
import type { LocalHardwareSnapshot, PublicModelCatalogDetail } from '@sprint-coder/contracts';
import {
  LocalModelDownloadManager,
  LocalModelDownloadRepository,
  LocalModelStore,
  type LocalModelInstallPlan,
} from './local-model-download-manager';

const roots: string[] = [];
const filesystemFault = vi.hoisted(() => ({
  rename: null as ((...args: Parameters<typeof FsPromises.rename>) => Promise<void>) | null,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof FsPromises>();
  return {
    ...original,
    rename: async (...args: Parameters<typeof original.rename>) => {
      if (filesystemFault.rename !== null) return filesystemFault.rename(...args);
      return original.rename(...args);
    },
  };
});
const runsWithElectronAbi = process.env.SPRINT_CODER_ELECTRON_LOCAL_MODEL_DB_TEST === '1';
const localModelBridgeTimeoutMs = process.platform === 'win32' ? 120_000 : 60_000;

function modelMetadata(architecture: string): Buffer {
  const u32 = (n: number) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(n);
    return bytes;
  };
  const u64 = (n: number) => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(BigInt(n));
    return bytes;
  };
  const string = (value: string) =>
    Buffer.concat([u64(Buffer.byteLength(value)), Buffer.from(value)]);
  return Buffer.concat([
    Buffer.from('GGUF'),
    u32(3),
    u64(0),
    u64(7),
    string('general.architecture'),
    u32(8),
    string(architecture),
    string(`${architecture}.context_length`),
    u32(4),
    u32(32768),
    string(`${architecture}.block_count`),
    u32(4),
    u32(2),
    string(`${architecture}.embedding_length`),
    u32(4),
    u32(1024),
    string(`${architecture}.attention.head_count`),
    u32(4),
    u32(8),
    string(`${architecture}.attention.head_count_kv`),
    u32(4),
    u32(2),
    string(`${architecture}.target_layers`),
    u32(9),
    u32(4),
    u64(2),
    u32(1),
    u32(2),
  ]);
}

afterEach(async () => {
  filesystemFault.rename = null;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(input?: {
  bytes?: readonly Buffer[];
  fetch?: typeof globalThis.fetch;
  availableBytes?: number;
  assertModelDeletable?: (modelId: string) => void;
}) {
  const root = await mkdtemp(join(tmpdir(), 'sprint-coder-local-model-'));
  roots.push(root);
  const databasePath = join(root, 'app.sqlite3');
  new SqlitePersistenceClient(databasePath).close();
  const repository = new LocalModelDownloadRepository(databasePath);
  const store = await LocalModelStore.open(join(root, 'local-models'));
  const bytes = input?.bytes ?? [Buffer.from('first shard'), Buffer.from('second shard')];
  const plan: LocalModelInstallPlan = {
    source: 'hugging_face',
    sourceId: 'owner/model',
    immutableRevision: 'a'.repeat(40),
    quantization: 'Q4_K_M',
    artifacts: bytes.map((value, index) => ({
      filename: `model-${index + 1}-of-${bytes.length}.gguf`,
      sizeBytes: value.byteLength,
      sha256: createHash('sha256').update(value).digest('hex'),
      sourceUrl: `https://huggingface.co/owner/model/resolve/${'a'.repeat(40)}/model-${index + 1}.gguf`,
      role: 'model',
    })),
  };
  const fetch =
    input?.fetch ??
    (async (url: string | URL | Request) => {
      const ordinal = Number(/model-(\d+)\.gguf/u.exec(String(url))?.[1] ?? '1');
      const body = bytes[ordinal - 1]!;
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: { 'content-length': String(body.byteLength), etag: `"artifact-${ordinal}"` },
      });
    });
  const manager = new LocalModelDownloadManager(
    repository,
    store,
    input?.assertModelDeletable ?? (() => undefined),
    fetch,
    () => '2026-08-23T00:00:00.000Z',
    async () => input?.availableBytes ?? 1024 * 1024 * 1024,
  );
  return { root, repository, store, manager, plan, bytes, fetch };
}

async function verifiedFixture() {
  const env = await fixture();
  const job = await env.manager.enqueue(env.plan);
  env.repository.transition(job.id, 'downloading', '2026-08-23T00:00:01.000Z');
  for (let index = 0; index < env.bytes.length; index += 1) {
    await writeFile(env.store.partialPath(job.modelId, index + 1), env.bytes[index]!);
    env.repository.progress(job.id, index + 1, env.bytes[index]!.length, null);
    env.repository.artifactDownloaded(job.id, index + 1, '2026-08-23T00:00:02.000Z');
  }
  env.repository.transition(job.id, 'verifying', '2026-08-23T00:00:03.000Z');
  return { ...env, job };
}

if (runsWithElectronAbi)
  describe('LocalModelDownloadManager', () => {
    it('rolls back canceled identity replacement if the new job insert fails', async () => {
      const env = await fixture();
      try {
        const original = await env.manager.enqueue(env.plan);
        env.repository.progress(original.id, 1, 3, '"old"');
        await env.manager.cancel(original.id, true);
        const other = await env.manager.enqueue({ ...env.plan, quantization: 'Q8_0' });
        expect(() => env.repository.create(env.plan, other.id, '2026-08-23T00:00:01.000Z')).toThrow(
          'UNIQUE',
        );
        expect(env.manager.getJob(original.id)).toMatchObject({
          state: 'canceled',
          downloadedBytes: 3,
        });
        expect(env.repository.artifacts(original.modelId)[0]).toMatchObject({
          downloaded_bytes: 3,
          etag: '"old"',
        });
        expect(env.manager.getJob(other.id).state).toBe('queued');
      } finally {
        env.repository.close();
      }
    });

    it('protects active, installed, deleting and delete-failed identities from replacement', async () => {
      const env = await fixture({ bytes: [Buffer.from('single model')] });
      try {
        const original = await env.manager.enqueue(env.plan);
        await expect(env.manager.enqueue(env.plan)).rejects.toThrow('already in use');
        expect((await env.manager.run(original.id, env.plan)).state).toBe('installed');
        const settings = env.manager.getInferenceSettings(original.modelId);
        for (const state of ['installed', 'deleting', 'delete_failed'] as const) {
          if (state === 'deleting')
            env.repository.beginDelete(original.modelId, '2026-08-23T00:00:01.000Z');
          if (state === 'delete_failed')
            env.repository.markDeleteFailed(original.modelId, '2026-08-23T00:00:02.000Z');
          await expect(env.manager.enqueue(env.plan)).rejects.toThrow('already in use');
          expect(env.manager.listInstalledModels()[0]?.state).toBe(state);
          expect(await readFile(env.store.installedPath(original.modelId, 1))).toEqual(
            env.bytes[0],
          );
        }
        expect(env.repository.getJob(original.id).state).toBe('installed');
        expect(settings.maxOutputTokens).toBe(512);
      } finally {
        env.repository.close();
      }
    });

    it('rejects DB artifact identity tampering even when the published bytes match the altered row', async () => {
      const env = await verifiedFixture();
      await env.store.publish(env.job.modelId, env.repository.artifacts(env.job.modelId));
      env.repository.close();
      const changed = Buffer.alloc(env.bytes[0]!.length);
      const db = new Database(join(env.root, 'app.sqlite3'));
      db.prepare(
        'UPDATE local_model_artifacts SET sha256 = ? WHERE model_id = ? AND ordinal = 1',
      ).run(createHash('sha256').update(changed).digest('hex'), env.job.modelId);
      db.close();
      await writeFile(env.store.installedPath(env.job.modelId, 1), changed);
      const repository = new LocalModelDownloadRepository(join(env.root, 'app.sqlite3'));
      const store = await LocalModelStore.open(env.store.rootPath);
      const manager = new LocalModelDownloadManager(repository, store, () => undefined, env.fetch);
      try {
        manager.recoverInterrupted();
        expect(await manager.run(env.job.id, env.plan)).toMatchObject({
          state: 'failed',
          failureCode: 'unsafe_store',
        });
        expect(await readFile(store.installedPath(env.job.modelId, 1))).toEqual(changed);
        expect(manager.listInstalledModels()).toEqual([]);
      } finally {
        repository.close();
      }
    });
    it('preserves the only staged copy when both publish and rollback rename fail, including a replay', async () => {
      const env = await verifiedFixture();
      const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
      const staging = join(env.store.rootPath, 'models', `.staging-${env.job.modelId}`);
      const failPublishAndRollback = async (...args: Parameters<typeof actual.rename>) => {
        if (
          String(args[0]) === env.store.partialPath(env.job.modelId, 2) ||
          String(args[0]) === join(staging, '001.gguf')
        )
          throw new Error('injected rename denial');
        return actual.rename(...args);
      };
      filesystemFault.rename = failPublishAndRollback;
      await expect(
        env.store.publish(env.job.modelId, env.repository.artifacts(env.job.modelId)),
      ).rejects.toThrow('rename denial');
      filesystemFault.rename = null;
      expect(await readFile(join(staging, '001.gguf'))).toEqual(env.bytes[0]);
      env.repository.close();
      let repository = new LocalModelDownloadRepository(join(env.root, 'app.sqlite3'));
      let store = await LocalModelStore.open(env.store.rootPath);
      let manager = new LocalModelDownloadManager(repository, store, () => undefined, env.fetch);
      manager.recoverInterrupted();
      filesystemFault.rename = async (...args) => {
        // Permit recovery to return the shard, then fail the next publish and rollback.
        if (
          String(args[1]) === env.store.partialPath(env.job.modelId, 1) &&
          String(args[0]) === join(staging, '001.gguf')
        ) {
          filesystemFault.rename = failPublishAndRollback;
          return actual.rename(...args);
        }
        return failPublishAndRollback(...args);
      };
      expect((await manager.run(env.job.id, env.plan)).state).toBe('failed');
      filesystemFault.rename = null;
      expect(await readFile(join(staging, '001.gguf'))).toEqual(env.bytes[0]);
      repository.close();
      repository = new LocalModelDownloadRepository(join(env.root, 'app.sqlite3'));
      store = await LocalModelStore.open(env.store.rootPath);
      manager = new LocalModelDownloadManager(repository, store, () => undefined, env.fetch);
      try {
        expect((await manager.run(env.job.id, env.plan)).state).toBe('installed');
        for (let index = 0; index < env.bytes.length; index += 1)
          expect(await readFile(store.installedPath(env.job.modelId, index + 1))).toEqual(
            env.bytes[index],
          );
      } finally {
        repository.close();
      }
    });
    it.each(['draft', 'projector'] as const)(
      'keeps %s metadata and artifact roles when a published bundle recovers',
      async (kind) => {
        const env = await fixture({
          bytes:
            kind === 'draft'
              ? [modelMetadata('dflash')]
              : [modelMetadata('llama'), Buffer.from('projector')],
        });
        const plan = {
          ...env.plan,
          architecture: kind === 'draft' ? 'dflash' : 'llama',
          baseModelId: 'owner/base',
          artifacts: env.plan.artifacts.map((artifact, index) =>
            kind === 'projector' && index === 1
              ? { ...artifact, role: 'mmproj' as const, filename: 'mmproj-model.gguf' }
              : artifact,
          ),
        };
        const job = await env.manager.enqueue(plan);
        vi.spyOn(env.repository, 'markInstalled').mockImplementationOnce(() => {
          throw new Error('commit fault');
        });
        expect((await env.manager.run(job.id, plan)).state).toBe('failed');
        env.repository.close();
        const repository = new LocalModelDownloadRepository(join(env.root, 'app.sqlite3'));
        const store = await LocalModelStore.open(env.store.rootPath);
        const fetch = vi.fn(env.fetch);
        const manager = new LocalModelDownloadManager(repository, store, () => undefined, fetch);
        try {
          expect((await manager.run(job.id, plan)).state).toBe('installed');
          expect(manager.listInstalledModels()[0]).toMatchObject({
            purpose: kind === 'draft' ? 'draft-dflash' : 'normal',
            baseModelId: 'owner/base',
          });
          expect(manager.artifactExpectations(job.modelId).map(({ role }) => role)).toEqual(
            plan.artifacts.map(({ role }) => role),
          );
          expect(fetch).not.toHaveBeenCalled();
        } finally {
          repository.close();
        }
      },
    );

    it('recovers through the real Controller startup, catalog identity reconstruction, and resume pump', async () => {
      const env = await verifiedFixture();
      await env.store.publish(env.job.modelId, env.repository.artifacts(env.job.modelId));
      env.repository.close();
      const detail: PublicModelCatalogDetail = {
        item: {
          id: 'owner/model',
          name: 'model',
          author: 'owner',
          source: 'hugging_face',
          sourceId: 'owner/model',
          sourceUrl: 'https://huggingface.co/owner/model',
          immutableRevision: env.plan.immutableRevision,
          gated: false,
          private: false,
          viewable: true,
          installability: { state: 'installable', reason: 'fixture' },
          license: null,
          purpose: null,
          tags: [],
          downloads: null,
          updatedAt: null,
        },
        description: '',
        architecture: null,
        parameterCount: null,
        contextTokens: null,
        toolTemplate: 'unknown',
        backend: null,
        variants: [],
        referenceUrls: [],
        artifacts: env.plan.artifacts.map((artifact, index) => ({
          ...artifact,
          sourceUrl: `https://huggingface.co/owner/model/blob/${env.plan.immutableRevision}/${artifact.filename}`,
          id: `artifact-${index}`,
          format: 'gguf',
          quantization: env.plan.quantization,
          installability: { state: 'installable', reason: 'fixture' },
        })),
      };
      const catalog = new PublicModelCatalogService(env.fetch);
      vi.spyOn(catalog, 'detail').mockResolvedValue(detail);
      const fetch = vi.fn(env.fetch);
      const dependencies = {
        databasePath: join(env.root, 'app.sqlite3'),
        storeRoot: env.store.rootPath,
        lifecycle: null,
        bundle: null,
        catalog,
        fetch,
      };
      const controller = await ManagedLocalController.create(dependencies);
      try {
        expect(controller.listJobs()[0]?.state).toBe('interrupted');
        await controller.resume(env.job.id);
        await vi.waitFor(() => expect(controller.listJobs()[0]?.state).toBe('installed'));
        expect(controller.listInstalled()[0]?.id).toBe(env.job.modelId);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        await controller.dispose();
      }
      const reopened = await ManagedLocalController.create(dependencies);
      try {
        expect(reopened.listInstalled()).toHaveLength(1);
      } finally {
        await reopened.dispose();
      }
    });
    it('reinstalls a canceled model through the real Controller after reopening the store', async () => {
      const env = await fixture({ bytes: [Buffer.from('controller model')] });
      env.repository.close();
      let reading!: () => void;
      const started = new Promise<void>((resolve) => {
        reading = resolve;
      });
      let aborts = 0;
      const fetch = vi.fn(env.fetch).mockImplementationOnce(
        async () =>
          new Response(
            new ReadableStream({
              pull() {
                reading();
              },
              cancel() {
                aborts += 1;
              },
            }),
            { headers: { 'content-length': String(env.bytes[0]!.length) } },
          ),
      );
      const detail: PublicModelCatalogDetail = {
        item: {
          id: 'owner/model',
          name: 'model',
          author: 'owner',
          source: 'hugging_face',
          sourceId: 'owner/model',
          sourceUrl: 'https://huggingface.co/owner/model',
          immutableRevision: env.plan.immutableRevision,
          gated: false,
          private: false,
          viewable: true,
          installability: { state: 'installable', reason: 'fixture' },
          license: null,
          purpose: null,
          tags: [],
          downloads: null,
          updatedAt: null,
        },
        description: '',
        architecture: null,
        parameterCount: null,
        contextTokens: null,
        toolTemplate: 'unknown',
        backend: null,
        variants: [],
        referenceUrls: [],
        artifacts: env.plan.artifacts.map((artifact, index) => ({
          ...artifact,
          sourceUrl: `https://huggingface.co/owner/model/blob/${env.plan.immutableRevision}/${artifact.filename}`,
          id: `artifact-${index}`,
          format: 'gguf',
          quantization: env.plan.quantization,
          installability: { state: 'installable', reason: 'fixture' },
        })),
      };
      const catalog = new PublicModelCatalogService(env.fetch);
      vi.spyOn(catalog, 'detail').mockResolvedValue(detail);
      const dependencies = {
        databasePath: join(env.root, 'app.sqlite3'),
        storeRoot: env.store.rootPath,
        lifecycle: null,
        bundle: null,
        catalog,
        fetch,
      };
      const input = {
        source: env.plan.source,
        sourceId: env.plan.sourceId,
        artifactIds: detail.artifacts.map(({ id }) => id),
        quantization: env.plan.quantization,
        confirmed: true as const,
      };
      const controller = await ManagedLocalController.create(dependencies);
      let original!: Awaited<ReturnType<typeof controller.install>>;
      try {
        original = await controller.install(input);
        await started;
        expect((await controller.cancel(original.id, true)).state).toBe('canceled');
        expect(aborts).toBe(1);
        await expect(readFile(env.store.partialPath(original.modelId, 1))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        await controller.dispose();
      }
      const reopened = await ManagedLocalController.create(dependencies);
      try {
        const replacement = await reopened.install(input);
        expect(replacement.id).not.toBe(original.id);
        expect(replacement.modelId).toBe(original.modelId);
        await vi.waitFor(() =>
          expect(reopened.listJobs().find(({ id }) => id === replacement.id)).toMatchObject({
            state: 'installed',
            failureCode: null,
          }),
        );
        await expect(reopened.cancel(original.id, true)).rejects.toThrow('not found');
        expect(reopened.listInstalled()).toHaveLength(1);
        for (let index = 0; index < env.bytes.length; index += 1)
          expect(await readFile(env.store.installedPath(replacement.modelId, index + 1))).toEqual(
            env.bytes[index],
          );
      } finally {
        await reopened.dispose();
      }
    });

    it.each(['before_publish', 'one_staged', 'all_staged', 'final', 'committed'] as const)(
      'recovers the %s cutpoint after a real SQLite/store reopen',
      async (cutpoint) => {
        const env = await verifiedFixture();
        if (cutpoint === 'one_staged' || cutpoint === 'all_staged') {
          const staging = join(env.store.rootPath, 'models', `.staging-${env.job.modelId}`);
          await mkdir(staging);
          const count = cutpoint === 'one_staged' ? 1 : env.bytes.length;
          for (let index = 0; index < count; index += 1)
            await rename(
              env.store.partialPath(env.job.modelId, index + 1),
              join(staging, `${String(index + 1).padStart(3, '0')}.gguf`),
            );
        }
        if (cutpoint === 'final' || cutpoint === 'committed') {
          await env.store.publish(env.job.modelId, env.repository.artifacts(env.job.modelId));
          if (cutpoint === 'committed')
            env.repository.markInstalled(env.job.id, '2026-08-23T00:00:04.000Z');
        }
        env.repository.close();
        const repository = new LocalModelDownloadRepository(join(env.root, 'app.sqlite3'));
        const store = await LocalModelStore.open(env.store.rootPath);
        const fetch = vi.fn(env.fetch);
        const manager = new LocalModelDownloadManager(repository, store, () => undefined, fetch);
        try {
          manager.recoverInterrupted();
          const installed = await manager.run(env.job.id, env.plan);
          expect(installed).toMatchObject({
            id: env.job.id,
            modelId: env.job.modelId,
            state: 'installed',
          });
          expect(manager.listInstalledModels()).toHaveLength(1);
          expect(fetch).not.toHaveBeenCalled();
          for (let index = 0; index < env.bytes.length; index += 1)
            expect(await readFile(store.installedPath(env.job.modelId, index + 1))).toEqual(
              env.bytes[index],
            );
        } finally {
          repository.close();
        }
      },
    );

    it.each(['missing', 'size', 'hash', 'extra', 'hardlink', 'directory-link'] as const)(
      'preserves and rejects an unsafe published bundle (%s)',
      async (fault) => {
        const env = await verifiedFixture();
        await env.store.publish(env.job.modelId, env.repository.artifacts(env.job.modelId));
        const finalPath = join(env.store.rootPath, 'models', env.job.modelId);
        const first = env.store.installedPath(env.job.modelId, 1);
        if (fault === 'missing') await rm(first);
        if (fault === 'size') await writeFile(first, 'x');
        if (fault === 'hash') await writeFile(first, Buffer.alloc(env.bytes[0]!.length));
        if (fault === 'extra') await writeFile(join(finalPath, 'unexpected'), 'extra');
        if (fault === 'hardlink') await link(first, join(env.root, 'linked-shard'));
        if (fault === 'directory-link') {
          await rename(finalPath, join(env.root, 'outside-bundle'));
          await symlink(join(env.root, 'outside-bundle'), finalPath, 'junction');
        }
        env.repository.close();
        const repository = new LocalModelDownloadRepository(join(env.root, 'app.sqlite3'));
        const store = await LocalModelStore.open(env.store.rootPath);
        const manager = new LocalModelDownloadManager(
          repository,
          store,
          () => undefined,
          env.fetch,
        );
        try {
          manager.recoverInterrupted();
          const before = await readdir(finalPath);
          expect((await manager.run(env.job.id, env.plan)).state).toBe('failed');
          expect(manager.listInstalledModels()).toEqual([]);
          expect(await readdir(finalPath)).toEqual(before);
          await expect(manager.cancel(env.job.id, true)).rejects.toMatchObject({
            code: 'unsafe_store',
          });
          expect(await readdir(finalPath)).toEqual(before);
        } finally {
          repository.close();
        }
      },
    );

    it('redownloads a missing downloaded partial instead of trusting only the DB row', async () => {
      const env = await verifiedFixture();
      await rm(env.store.partialPath(env.job.modelId, 1));
      env.manager.recoverInterrupted();
      try {
        expect((await env.manager.run(env.job.id, env.plan)).state).toBe('installed');
        expect(await readFile(env.store.installedPath(env.job.modelId, 1))).toEqual(env.bytes[0]);
      } finally {
        env.repository.close();
      }
    });

    it('checks duplicate staging and partial bytes before removing either copy', async () => {
      const env = await verifiedFixture();
      const staging = join(env.store.rootPath, 'models', `.staging-${env.job.modelId}`);
      await mkdir(staging);
      await writeFile(join(staging, '001.gguf'), env.bytes[0]!);
      await writeFile(
        env.store.partialPath(env.job.modelId, 1),
        Buffer.alloc(env.bytes[0]!.length),
      );
      env.manager.recoverInterrupted();
      try {
        expect(await env.manager.run(env.job.id, env.plan)).toMatchObject({
          state: 'failed',
          failureCode: 'hash_mismatch',
        });
        expect(await readFile(join(staging, '001.gguf'))).toEqual(env.bytes[0]);
        await writeFile(env.store.partialPath(env.job.modelId, 1), env.bytes[0]!);
        expect((await env.manager.run(env.job.id, env.plan)).state).toBe('installed');
      } finally {
        env.repository.close();
      }
    });
    it('recovers a published bundle after the database commit fails and the store reopens', async () => {
      const env = await fixture();
      const original = await env.manager.enqueue(env.plan);
      vi.spyOn(env.repository, 'markInstalled').mockImplementationOnce(() => {
        throw new Error('simulated crash before DB commit');
      });
      expect((await env.manager.run(original.id, env.plan)).state).toBe('failed');
      env.repository.close();
      const repository = new LocalModelDownloadRepository(join(env.root, 'app.sqlite3'));
      const store = await LocalModelStore.open(env.store.rootPath);
      const manager = new LocalModelDownloadManager(repository, store, () => undefined, env.fetch);
      try {
        manager.recoverInterrupted();
        expect((await manager.run(original.id, env.plan)).state).toBe('installed');
        expect(manager.listInstalledModels()).toHaveLength(1);
        for (let index = 0; index < env.bytes.length; index += 1)
          expect(await readFile(store.installedPath(original.modelId, index + 1))).toEqual(
            env.bytes[index],
          );
        expect((await manager.run(original.id, env.plan)).state).toBe('installed');
      } finally {
        repository.close();
      }
    });
    it.each(['queued', 'paused', 'interrupted', 'failed'] as const)(
      'reinstalls a canceled %s job after reopening the database and store',
      async (state) => {
        const env = await fixture();
        const original = await env.manager.enqueue(env.plan);
        if (state !== 'queued') {
          env.repository.transition(original.id, 'downloading', '2026-08-23T00:00:01.000Z');
          env.repository.transition(
            original.id,
            state,
            '2026-08-23T00:00:02.000Z',
            state === 'failed' ? 'network' : null,
          );
        }
        await env.manager.cancel(original.id, true);
        env.repository.close();
        const repository = new LocalModelDownloadRepository(join(env.root, 'app.sqlite3'));
        const store = await LocalModelStore.open(env.store.rootPath);
        const manager = new LocalModelDownloadManager(
          repository,
          store,
          () => undefined,
          env.fetch,
        );
        try {
          // Legacy canceled rows can retain partial bytes. Cleanup precedes identity reuse.
          await writeFile(store.partialPath(original.modelId, 1), Buffer.from('old'));
          const replacement = await manager.enqueue(env.plan);
          expect(replacement.id).not.toBe(original.id);
          expect(replacement.modelId).toBe(original.modelId);
          expect(replacement.downloadedBytes).toBe(0);
          expect((await manager.run(replacement.id, env.plan)).state).toBe('installed');
          expect(manager.listInstalledModels()).toHaveLength(1);
        } finally {
          repository.close();
        }
      },
    );
    it('reinstalls the same immutable model after confirmed cancel', async () => {
      const env = await fixture();
      try {
        const original = await env.manager.enqueue(env.plan);
        await env.manager.cancel(original.id, true);
        const replacement = await env.manager.enqueue(env.plan);
        expect(replacement.modelId).toBe(original.modelId);
        expect(replacement.id).not.toBe(original.id);
        expect((await env.manager.run(replacement.id, env.plan)).state).toBe('installed');
        expect(env.manager.listInstalledModels()).toHaveLength(1);
      } finally {
        env.repository.close();
      }
    });

    it('serializes concurrent reinstallation cleanup and preserves the winning job', async () => {
      const env = await fixture();
      try {
        const original = await env.manager.enqueue(env.plan);
        await env.manager.cancel(original.id, true);
        const attempts = await Promise.allSettled([
          env.manager.enqueue(env.plan),
          env.manager.enqueue(env.plan),
        ]);
        expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
        const job = env.manager.listJobs()[0]!;
        await expect(env.manager.cancel(original.id, true)).rejects.toThrow('not found');
        expect((await env.manager.run(job.id, env.plan)).state).toBe('installed');
        await expect(env.manager.enqueue(env.plan)).rejects.toThrow('already in use');
        expect(env.manager.listInstalledModels()).toHaveLength(1);
      } finally {
        env.repository.close();
      }
    });

    it('does not report successful cancel after cleanup failure or restart the job during cleanup', async () => {
      const env = await fixture();
      const original = await env.manager.enqueue(env.plan);
      const cleanup = vi
        .spyOn(env.store, 'cancel')
        .mockRejectedValueOnce(new Error('cleanup denied'));
      await expect(env.manager.cancel(original.id, true)).rejects.toThrow('cleanup denied');
      expect(env.manager.getJob(original.id).state).toBe('queued');
      let release!: () => void;
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      cleanup.mockImplementationOnce(async () => {
        entered();
        await barrier;
      });
      try {
        const cancellation = env.manager.cancel(original.id, true);
        await ready;
        const restart = env.manager.run(original.id, env.plan);
        release();
        expect((await cancellation).state).toBe('canceled');
        expect((await restart).state).toBe('canceled');
        expect(await readdir(join(env.store.rootPath, 'models'))).toEqual([]);
        const replacement = await env.manager.enqueue(env.plan);
        expect((await env.manager.run(replacement.id, env.plan)).state).toBe('installed');
      } finally {
        release();
        env.repository.close();
      }
    });

    it('waits for an aborted stream before cleanup and permits reinstall', async () => {
      let reading!: () => void;
      const started = new Promise<void>((resolve) => {
        reading = resolve;
      });
      let aborts = 0;
      const env = await fixture({
        fetch: async () =>
          new Response(
            new ReadableStream({
              pull() {
                reading();
              },
              cancel() {
                aborts += 1;
              },
            }),
            { headers: { 'content-length': '11' } },
          ),
      });
      try {
        const original = await env.manager.enqueue(env.plan);
        const run = env.manager.run(original.id, env.plan);
        await started;
        const canceled = await env.manager.cancel(original.id, true);
        await run;
        expect(canceled.state).toBe('canceled');
        expect(aborts).toBe(1);
        await expect(readFile(env.store.partialPath(original.modelId, 1))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        const replacement = await env.manager.enqueue(env.plan);
        expect(replacement.id).not.toBe(original.id);
        expect(replacement.downloadedBytes).toBe(0);
      } finally {
        env.repository.close();
      }
    });
    it.each([
      [false, null],
      [true, null],
      [true, 'model'],
      [true, 'mmproj'],
    ] as const)(
      'connects controller settings and pair-bound evidence (v82 migration: %s, extra artifact: %s)',
      async (legacy, extraRole) => {
        const env = await fixture({ bytes: [modelMetadata('llama'), modelMetadata('dflash')] });
        const targetPlan = {
          ...env.plan,
          architecture: 'llama',
          baseModelId: 'owner/base',
          artifacts: [env.plan.artifacts[0]!],
        };
        const draftPlan = {
          ...env.plan,
          architecture: 'dflash',
          baseModelId: 'owner/base',
          artifacts: [env.plan.artifacts[1]!],
        };
        const target = await env.manager.enqueue(targetPlan);
        const draft = await env.manager.enqueue(draftPlan);
        await env.manager.run(target.id, targetPlan);
        await env.manager.run(draft.id, draftPlan);
        env.repository.setLaunchSettings(target.modelId, {
          backend: 'cpu',
          gpuLayers: 0,
          contextTokens: 1024,
          batchSize: 512,
        });
        env.repository.close();
        if (legacy) {
          const db = new Database(join(env.root, 'app.sqlite3'));
          db.exec(
            'ALTER TABLE local_models DROP COLUMN purpose; ALTER TABLE local_models DROP COLUMN base_model_id; DELETE FROM schema_migrations WHERE version = 83;',
          );
          db.close();
          new SqlitePersistenceClient(join(env.root, 'app.sqlite3')).close();
        }
        if (extraRole !== null) {
          const db = new Database(join(env.root, 'app.sqlite3'));
          db.prepare(
            `INSERT INTO local_model_artifacts(model_id, ordinal, filename, sha256, byte_length, role, state, downloaded_bytes)
            SELECT model_id, 2, 'extra.gguf', sha256, byte_length, ?, state, downloaded_bytes FROM local_model_artifacts WHERE model_id = ? AND ordinal = 1`,
          ).run(extraRole, draft.modelId);
          db.prepare(
            'UPDATE local_model_download_jobs SET downloaded_bytes = downloaded_bytes * 2, completed_artifacts = 2 WHERE model_id = ?',
          ).run(draft.modelId);
          db.prepare(
            'UPDATE local_models SET artifact_count = 2, total_bytes = total_bytes * 2 WHERE id = ?',
          ).run(draft.modelId);
          db.close();
          await writeFile(env.store.installedPath(draft.modelId, 2), env.bytes[1]!);
        }
        const catalog = new PublicModelCatalogService(globalThis.fetch);
        const resolveBase = vi.spyOn(catalog, 'resolveBaseModelId').mockResolvedValue('owner/base');
        const bundle: VerifiedManagedLocalSidecarBundle = {
          target: 'darwin-arm64',
          rootPath: '/fixture',
          serverPath: '/fixture/server',
          licensePath: '/fixture/license',
          artifactPaths: {},
          manifestSha256: 'e'.repeat(64),
          manifest: {
            schemaVersion: 1,
            runtime: 'llama.cpp',
            runtimeVersion: 'test-dflash',
            upstreamRepository: 'https://github.com/ggml-org/llama.cpp',
            upstreamRevision: 'f'.repeat(40),
            platform: 'darwin',
            architecture: 'arm64',
            candidateBackends: ['cpu'],
            speculativeDflash: true,
            artifacts: [],
          },
        };
        const hardware: LocalHardwareSnapshot = {
          version: 1,
          status: 'complete',
          observedAt: new Date().toISOString(),
          platform: 'darwin',
          architecture: 'arm64',
          memory: {
            totalBytes: 32 * 1024 ** 3,
            availableBytes: 16 * 1024 ** 3,
            topology: 'unified',
          },
          cpu: { model: 'fixture', logicalCores: 4, features: [], featuresStatus: 'known' },
          gpuDevicesStatus: 'known',
          gpus: [],
          backends: [{ kind: 'cpu', status: 'available' }],
          unknownComponents: [],
        };
        const starts: ManagedLocalRuntimeStartInput[] = [];
        class TestSupervisor extends ManagedLocalRuntimeSupervisor {
          override async start(
            input: ManagedLocalRuntimeStartInput,
          ): Promise<ManagedLocalRuntimeSession> {
            if (input.kind !== 'model') throw new Error('model required');
            starts.push(input);
            let state: 'running' | 'stopped' = 'running';
            const snapshot = () => ({
              state,
              target: bundle.target,
              runtimeVersion: bundle.manifest.runtimeVersion,
              baseUrl: 'http://127.0.0.1:1234/v1',
              backend: input.backend,
              gpuLayers: input.gpuLayers,
              contextTokens: input.contextTokens,
              batchSize: input.batchSize,
              startedAt: new Date().toISOString(),
              stoppedAt: null,
              exitCode: null,
              signal: null,
            });
            return {
              baseUrl: 'http://127.0.0.1:1234/v1',
              snapshot,
              diagnostics: () => '',
              stop: async () => {
                state = 'stopped';
                return snapshot();
              },
              authenticatedFetch: async (_path, init) => {
                const request = JSON.parse(String(init?.body)) as {
                  tools?: unknown[];
                  messages: Array<{ content: string }>;
                };
                const nonce = /nonce ([a-f0-9-]+)\./u.exec(request.messages[0]!.content)?.[1];
                const message = request.tools
                  ? {
                      content: null,
                      tool_calls: [
                        {
                          id: 'call-1',
                          type: 'function',
                          function: {
                            name: 'sprint_self_test',
                            arguments: JSON.stringify({ nonce }),
                          },
                        },
                      ],
                    }
                  : {
                      content:
                        request.messages.length === 1
                          ? 'one two three four five six seven eight nine ten'
                          : 'DONE',
                    };
                return new Response(
                  JSON.stringify({
                    choices: [{ message }],
                    timings: { draft_n: 12, draft_n_accepted: 9 },
                  }),
                );
              },
            };
          }
        }
        const lifecycle = new ManagedLocalRuntimeLifecycle({
          bundle,
          supervisor: new TestSupervisor({ loadBundle: async () => bundle }),
          collectHardware: async () => hardware,
        });
        const controller = await ManagedLocalController.create({
          databasePath: join(env.root, 'app.sqlite3'),
          storeRoot: env.store.rootPath,
          bundle,
          lifecycle,
          catalog,
          collectHardware: async () => hardware,
        });
        try {
          expect(controller.listInstalled().find(({ id }) => id === draft.modelId)?.purpose).toBe(
            'draft-dflash',
          );
          await expect(controller.getLaunchSettings(draft.modelId)).rejects.toThrow(
            'launch settings',
          );
          expect(
            (await controller.listProviderModels('test', 'managed-local')).some(
              ({ modelId }) => modelId === draft.modelId,
            ),
          ).toBe(false);
          const view = await controller.getSpeculativeSettings(target.modelId);
          if (extraRole !== null) {
            expect(view.eligibleDrafts).toEqual([]);
            const settings = {
              type: 'draft-dflash',
              draftModelId: draft.modelId,
              draftTokensMax: 3,
            } as const;
            const repository = new LocalModelDownloadRepository(join(env.root, 'app.sqlite3'));
            // Even a matching remote declaration cannot authorize this legacy bundle shape.
            repository.backfillBaseModelId(
              draft.modelId,
              draftPlan.sourceId,
              draftPlan.immutableRevision,
              'owner/base',
            );
            expect(() => repository.setSpeculativeSettings(target.modelId, settings)).toThrow(
              'compatible',
            );
            repository.close();
            await expect(
              controller.setSpeculativeSettings(target.modelId, settings),
            ).rejects.toThrow('compatible');
            const db = new Database(join(env.root, 'app.sqlite3'));
            db.prepare(
              'INSERT OR REPLACE INTO settings(key, value, updated_at) VALUES (?, ?, ?)',
            ).run(
              'managed-local.speculative-settings',
              JSON.stringify({ [target.modelId]: settings }),
              new Date().toISOString(),
            );
            db.close();
            await expect(
              controller.acquireRuntime(target.modelId, false, new AbortController().signal),
            ).rejects.toThrow('compatible');
            expect(starts).toEqual([]);
            return;
          }
          if (legacy)
            expect(resolveBase).toHaveBeenCalledWith(
              draftPlan.sourceId,
              draftPlan.immutableRevision,
            );
          expect(view.eligibleDrafts.map(({ id }) => id)).toEqual([draft.modelId]);
          await controller.setSpeculativeSettings(target.modelId, {
            type: 'draft-dflash',
            draftModelId: draft.modelId,
            draftTokensMax: 3,
          });
          const integrity = vi.spyOn(
            LocalModelDownloadManager.prototype,
            'assertInstalledIntegrity',
          );
          const fit = await controller.verify(target.modelId);
          expect(integrity).toHaveBeenCalledTimes(2);
          const lease = await controller.acquireRuntime(
            target.modelId,
            false,
            new AbortController().signal,
          );
          await lease.release();
          expect(integrity).toHaveBeenCalledTimes(2);
          integrity.mockRestore();
          expect(fit.state).toBe('verified_tools');
          expect(fit.verification?.binding).toMatchObject({
            backend: 'cpu',
            draftPlacement: 'cpu',
          });
          expect(fit.verification?.binding.speculative).toMatchObject({
            draftModelId: draft.modelId,
            draftArtifactHashes: [draftPlan.artifacts[0]!.sha256],
            draftTokensMax: 3,
          });
          expect(fit.breakdown?.draft?.weightsBytes).toBe(env.bytes[1]!.byteLength);
          expect(starts[0]).toMatchObject({
            kind: 'model',
            modelAlias: target.modelId,
            draft: { id: draft.modelId, draftTokensMax: 3 },
          });
          await expect(controller.delete(draft.modelId)).rejects.toThrow('referenced');
          expect(lifecycle.snapshot().state).toBe('running');
          await controller.setSpeculativeSettings(target.modelId, {
            type: 'off',
            draftModelId: null,
            draftTokensMax: 3,
          });
          expect(lifecycle.snapshot().state).toBe('stopped');
          await controller.delete(draft.modelId);
        } finally {
          await lifecycle.dispose();
          await controller.dispose();
        }
      },
    );
    it('installs verified draft metadata, persists a pair, and serializes deletion against references', async () => {
      const env = await fixture({ bytes: [modelMetadata('llama'), modelMetadata('dflash')] });
      const targetPlan = {
        ...env.plan,
        architecture: 'llama',
        baseModelId: 'owner/base',
        artifacts: [env.plan.artifacts[0]!],
      };
      const draftPlan = {
        ...env.plan,
        architecture: 'dflash',
        baseModelId: 'owner/base',
        artifacts: [env.plan.artifacts[1]!],
      };
      const target = await env.manager.enqueue(targetPlan);
      const draft = await env.manager.enqueue(draftPlan);
      expect((await env.manager.run(target.id, targetPlan)).state).toBe('installed');
      expect((await env.manager.run(draft.id, draftPlan)).state).toBe('installed');
      expect(
        env.repository.listInstalledModels().find(({ id }) => id === draft.modelId),
      ).toMatchObject({ purpose: 'draft-dflash', baseModelId: 'owner/base' });
      expect(() => env.repository.getLaunchSettings(draft.modelId)).toThrow('launch settings');
      expect(() => env.repository.getInferenceSettings(draft.modelId)).toThrow('launch settings');
      const on = { type: 'draft-dflash', draftModelId: draft.modelId, draftTokensMax: 3 } as const;
      expect(env.repository.setSpeculativeSettings(target.modelId, on)).toEqual(on);
      const secondPlan = { ...targetPlan, quantization: 'Q8_0' };
      const second = await env.manager.enqueue(secondPlan);
      expect((await env.manager.run(second.id, secondPlan)).state).toBe('installed');
      env.repository.setSpeculativeSettings(second.modelId, on);
      await expect(env.manager.deleteInstalled(draft.modelId)).rejects.toThrow('still referenced');
      expect(
        env.repository.listInstalledModels().find(({ id }) => id === draft.modelId)?.state,
      ).toBe('installed');
      env.repository.close();
      const reopened = new LocalModelDownloadRepository(join(env.root, 'app.sqlite3'));
      expect(reopened.getSpeculativeSettings(target.modelId)).toEqual(on);
      reopened.beginDelete(target.modelId, new Date().toISOString());
      expect(() => reopened.setSpeculativeSettings(target.modelId, on)).toThrow('launch settings');
      reopened.removeModel(target.modelId);
      expect(() => reopened.beginDelete(draft.modelId, new Date().toISOString())).toThrow(
        'still referenced',
      );
      reopened.setSpeculativeSettings(second.modelId, {
        type: 'off',
        draftModelId: null,
        draftTokensMax: 3,
      });
      reopened.beginDelete(draft.modelId, new Date().toISOString());
      expect(() => reopened.setSpeculativeSettings(second.modelId, on)).toThrow('compatible');
      reopened.removeModel(draft.modelId);
      reopened.beginDelete(second.modelId, new Date().toISOString());
      reopened.removeModel(second.modelId);
      expect(reopened.listInstalledModels()).toEqual([]);
      reopened.close();
    });

    it('rejects a declared draft before publish when the actual GGUF is a normal model', async () => {
      const env = await fixture({ bytes: [modelMetadata('llama')] });
      const plan = { ...env.plan, architecture: 'dflash', baseModelId: 'owner/base' };
      const job = await env.manager.enqueue(plan);
      expect(await env.manager.run(job.id, plan)).toMatchObject({
        state: 'failed',
        failureCode: 'unsafe_store',
      });
      expect(env.repository.listInstalledModels()).toEqual([]);
      expect(await readdir(join(env.store.rootPath, 'models'))).toEqual([]);
      env.repository.close();
    });

    it('retains valid target settings when a different speculative entry is malformed', async () => {
      const env = await fixture();
      const job = await env.manager.enqueue(env.plan);
      await env.manager.run(job.id, env.plan);
      env.repository.close();
      const valid = { type: 'draft-dflash', draftModelId: 'b'.repeat(64), draftTokensMax: 3 };
      const db = new Database(join(env.root, 'app.sqlite3'));
      db.prepare('INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)').run(
        'managed-local.speculative-settings',
        JSON.stringify({ [job.modelId]: valid, ['c'.repeat(64)]: { type: 'invalid' } }),
        new Date().toISOString(),
      );
      db.close();
      const reopened = new LocalModelDownloadRepository(join(env.root, 'app.sqlite3'));
      try {
        expect(reopened.needsSpeculativeSettingsRecovery()).toBe(true);
        expect(reopened.getSpeculativeSettings(job.modelId)).toEqual(valid);
      } finally {
        reopened.close();
      }
    });

    it('recovers only a malformed speculative row and retains unrelated launch settings', async () => {
      const env = await fixture();
      const job = await env.manager.enqueue(env.plan);
      await env.manager.run(job.id, env.plan);
      const launch = env.repository.getLaunchSettings(job.modelId);
      env.repository.setLaunchSettings(job.modelId, launch);
      env.repository.close();
      const db = new Database(join(env.root, 'app.sqlite3'));
      db.prepare('INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)').run(
        'managed-local.speculative-settings',
        '{invalid',
        new Date().toISOString(),
      );
      db.close();
      const reopened = new LocalModelDownloadRepository(join(env.root, 'app.sqlite3'));
      expect(reopened.needsSpeculativeSettingsRecovery()).toBe(true);
      expect(reopened.getSpeculativeSettings(job.modelId)).toEqual({
        type: 'off',
        draftModelId: null,
        draftTokensMax: 3,
      });
      expect(reopened.getLaunchSettings(job.modelId)).toEqual(launch);
      reopened.setSpeculativeSettings(job.modelId, {
        type: 'off',
        draftModelId: null,
        draftTokensMax: 3,
      });
      expect(reopened.needsSpeculativeSettingsRecovery()).toBe(false);
      reopened.close();
    });

    it('migrates an installed v82 model without changing identity, files, or its launch settings', async () => {
      const env = await fixture();
      const job = await env.manager.enqueue(env.plan);
      await env.manager.run(job.id, env.plan);
      const before = env.repository.listInstalledModels();
      const launch = env.repository.getLaunchSettings(job.modelId);
      env.repository.setLaunchSettings(job.modelId, launch);
      env.repository.close();
      const path = join(env.root, 'app.sqlite3');
      const legacy = new Database(path);
      legacy.exec(
        'ALTER TABLE local_models DROP COLUMN purpose; ALTER TABLE local_models DROP COLUMN base_model_id; DELETE FROM schema_migrations WHERE version = 83;',
      );
      legacy.close();
      new SqlitePersistenceClient(path).close();
      const migrated = new LocalModelDownloadRepository(path);
      expect(migrated.listInstalledModels()).toEqual(before);
      expect(migrated.getLaunchSettings(job.modelId)).toEqual(launch);
      expect(
        migrated.backfillBaseModelId(job.modelId, env.plan.sourceId, 'b'.repeat(40), 'owner/base'),
      ).toBe(false);
      expect(
        migrated.backfillBaseModelId(
          job.modelId,
          env.plan.sourceId,
          env.plan.immutableRevision,
          'owner/base',
        ),
      ).toBe(true);
      expect(
        migrated.backfillBaseModelId(
          job.modelId,
          env.plan.sourceId,
          env.plan.immutableRevision,
          'owner/other',
        ),
      ).toBe(false);
      expect(migrated.listInstalledModels()[0]?.baseModelId).toBe('owner/base');
      expect(await readFile(env.store.installedPath(job.modelId, 1))).toEqual(env.bytes[0]);
      migrated.close();
    });

    it('reopens an existing model store so the desktop can restart with the same userData', async () => {
      const env = await fixture();

      const reopened = await LocalModelStore.open(env.store.rootPath);

      expect(reopened.rootPath).toBe(env.store.rootPath);
      env.repository.close();
    });

    it('publishes every verified split GGUF shard before marking the model installed', async () => {
      const env = await fixture();
      const queued = await env.manager.enqueue(env.plan);

      const installed = await env.manager.run(queued.id, env.plan);

      expect(installed.state).toBe('installed');
      expect(installed.completedArtifacts).toBe(2);
      expect(env.manager.listJobs()).toEqual([installed]);
      expect(env.manager.listInstalledModels()).toMatchObject([
        {
          id: installed.modelId,
          source: 'hugging_face',
          sourceId: 'owner/model',
          quantization: 'Q4_K_M',
          state: 'installed',
        },
      ]);
      expect(env.manager.modelRecord(installed.modelId)).toMatchObject({
        sourceId: 'owner/model',
        immutableRevision: 'a'.repeat(40),
      });
      expect(env.manager.artifactExpectations(installed.modelId)).toHaveLength(2);
      const verification = env.manager.saveVerification(installed.modelId, {
        level: 'tools',
        verifiedAt: '2026-08-23T00:00:00.000Z',
        binding: {
          hostCapabilityFingerprint: 'b'.repeat(64),
          modelRepo: 'owner/model',
          immutableRevision: 'a'.repeat(40),
          artifactHashes: env.plan.artifacts.map(({ sha256 }) => sha256),
          quantization: 'Q4_K_M',
          contextTokens: 8192,
          kvCacheType: 'f16',
          batchSize: 512,
          gpuOffloadRatio: 0,
          sidecarVersion: 'b10516',
          backend: 'cpu',
        },
      });
      expect(env.manager.verification(installed.modelId)).toEqual(verification);
      const modelPath = join(env.store.rootPath, 'models', installed.modelId);
      expect(await readdir(modelPath)).toEqual(['001.gguf', '002.gguf']);
      expect(await readFile(join(modelPath, '001.gguf'))).toEqual(env.bytes[0]);
      env.repository.close();
    });

    it('clamps a legacy verification-derived default batch to its fallback context', async () => {
      const env = await fixture({ bytes: [Buffer.from('one model')] });
      const queued = await env.manager.enqueue(env.plan);
      const installed = await env.manager.run(queued.id, env.plan);
      env.manager.saveVerification(installed.modelId, {
        level: 'loaded',
        verifiedAt: '2026-08-23T00:00:00.000Z',
        binding: {
          hostCapabilityFingerprint: 'b'.repeat(64),
          modelRepo: 'owner/model',
          immutableRevision: 'a'.repeat(40),
          artifactHashes: env.plan.artifacts.map(({ sha256 }) => sha256),
          quantization: 'Q4_K_M',
          contextTokens: 256,
          kvCacheType: 'f16',
          batchSize: 512,
          gpuOffloadRatio: 0,
          sidecarVersion: 'b10516',
          backend: 'cpu',
        },
      });

      expect(env.manager.getLaunchSettings(installed.modelId)).toMatchObject({
        contextTokens: 256,
        batchSize: 256,
      });
      env.repository.close();
    });

    it('persists a projector role and rejects an installed mmproj after byte tampering', async () => {
      const modelBytes = Buffer.from('model weights');
      const projectorBytes = Buffer.from('projector weights');
      const env = await fixture({
        bytes: [modelBytes, projectorBytes],
        fetch: async (url) => {
          const body = String(url).includes('mmproj') ? projectorBytes : modelBytes;
          return new Response(new Uint8Array(body), {
            status: 200,
            headers: { 'content-length': String(body.byteLength) },
          });
        },
      });
      const plan: LocalModelInstallPlan = {
        ...env.plan,
        artifacts: [
          { ...env.plan.artifacts[0]!, filename: 'model-Q4_K_M.gguf', role: 'model' },
          {
            ...env.plan.artifacts[1]!,
            filename: 'mmproj-model-f16.gguf',
            role: 'mmproj',
            sha256: createHash('sha256').update(projectorBytes).digest('hex'),
            sourceUrl: `https://huggingface.co/owner/model/resolve/${'a'.repeat(40)}/mmproj-model-f16.gguf`,
          },
        ],
      };
      const queued = await env.manager.enqueue(plan);
      const installed = await env.manager.run(queued.id, plan);

      expect(installed.state).toBe('installed');
      expect(env.manager.artifactExpectations(installed.modelId)).toEqual([
        expect.objectContaining({ filename: 'model-Q4_K_M.gguf', role: 'model' }),
        expect.objectContaining({ filename: 'mmproj-model-f16.gguf', role: 'mmproj' }),
      ]);
      expect(env.manager.getInferenceSettings(installed.modelId)).toEqual({
        maxOutputTokens: 512,
        thinking: false,
      });
      const projectorPath = join(env.store.rootPath, 'models', installed.modelId, '002.gguf');
      await expect(
        env.manager.assertInstalledIntegrity(installed.modelId),
      ).resolves.toBeUndefined();
      await writeFile(projectorPath, Buffer.alloc(projectorBytes.byteLength, 0));
      await expect(env.manager.assertInstalledIntegrity(installed.modelId)).rejects.toMatchObject({
        code: 'hash_mismatch',
      });
      env.repository.close();
    });

    it('persists Managed Local inference settings per installed model in the existing settings table', async () => {
      const env = await fixture({ bytes: [Buffer.from('one model')] });
      const queued = await env.manager.enqueue(env.plan);
      const installed = await env.manager.run(queued.id, env.plan);

      expect(env.manager.getInferenceSettings(installed.modelId)).toEqual({
        maxOutputTokens: 512,
        thinking: false,
      });
      expect(
        env.manager.setInferenceSettings(installed.modelId, {
          maxOutputTokens: 4_096,
          thinking: true,
        }),
      ).toEqual({ maxOutputTokens: 4_096, thinking: true });
      env.repository.close();

      const reopened = new LocalModelDownloadRepository(join(env.root, 'app.sqlite3'));
      expect(reopened.getInferenceSettings(installed.modelId)).toEqual({
        maxOutputTokens: 4_096,
        thinking: true,
      });
      reopened.close();
    });

    it('persists typed Managed Local launch settings per installed model in the existing settings table', async () => {
      const env = await fixture({ bytes: [Buffer.from('one model')] });
      const queued = await env.manager.enqueue(env.plan);
      const installed = await env.manager.run(queued.id, env.plan);

      expect(env.manager.getLaunchSettings(installed.modelId)).toEqual({
        backend: 'auto',
        gpuLayers: 999,
        contextTokens: 8_192,
        batchSize: 512,
      });
      expect(
        env.manager.setLaunchSettings(installed.modelId, {
          backend: 'cpu',
          gpuLayers: 0,
          contextTokens: 4_096,
          batchSize: 256,
        }),
      ).toEqual({ backend: 'cpu', gpuLayers: 0, contextTokens: 4_096, batchSize: 256 });
      env.repository.close();

      const reopened = new LocalModelDownloadRepository(join(env.root, 'app.sqlite3'));
      expect(reopened.getLaunchSettings(installed.modelId)).toEqual({
        backend: 'cpu',
        gpuLayers: 0,
        contextTokens: 4_096,
        batchSize: 256,
      });
      reopened.close();
    });

    it('removes per-model inference and launch settings when the model is deleted', async () => {
      const env = await fixture({ bytes: [Buffer.from('one model')] });
      const queued = await env.manager.enqueue(env.plan);
      const installed = await env.manager.run(queued.id, env.plan);
      env.manager.setInferenceSettings(installed.modelId, {
        maxOutputTokens: 4_096,
        thinking: true,
      });
      env.manager.setLaunchSettings(installed.modelId, {
        backend: 'cpu',
        gpuLayers: 0,
        contextTokens: 4_096,
        batchSize: 256,
      });

      await env.manager.deleteInstalled(installed.modelId);
      const requeued = await env.manager.enqueue(env.plan);
      const reinstalled = await env.manager.run(requeued.id, env.plan);

      expect(env.manager.getInferenceSettings(reinstalled.modelId)).toEqual({
        maxOutputTokens: 512,
        thinking: false,
      });
      expect(env.manager.getLaunchSettings(reinstalled.modelId)).toEqual({
        backend: 'auto',
        gpuLayers: 999,
        contextTokens: 8_192,
        batchSize: 512,
      });
      env.repository.close();
    });

    it('never publishes a hash mismatch or a missing shard as installed', async () => {
      const wrong = Buffer.from('tampered bytes');
      const env = await fixture({
        fetch: async () =>
          new Response(new Uint8Array(wrong), {
            status: 200,
            headers: { 'content-length': String(wrong.byteLength) },
          }),
        bytes: [Buffer.alloc(wrong.byteLength, 1)],
      });
      const queued = await env.manager.enqueue(env.plan);

      const failed = await env.manager.run(queued.id, env.plan);

      expect(failed).toMatchObject({ state: 'failed', failureCode: 'hash_mismatch' });
      expect(await readdir(join(env.store.rootPath, 'models'))).toEqual([]);
      env.repository.close();
    });

    it.each([
      ['header rejection', '11', false],
      ['stream byte overflow', '10', true],
    ])('cancels the artifact body after %s', async (_name, contentLength, enqueueBytes) => {
      const expected = Buffer.alloc(10, 1);
      const cancel = vi.fn();
      const env = await fixture({
        bytes: [expected],
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                if (enqueueBytes) controller.enqueue(new Uint8Array(11));
              },
              cancel,
            }),
            { status: 200, headers: { 'content-length': contentLength } },
          ),
      });
      const queued = await env.manager.enqueue(env.plan);

      const failed = await env.manager.run(queued.id, env.plan);

      expect(failed).toMatchObject({ state: 'failed', failureCode: 'size_changed' });
      expect(cancel).toHaveBeenCalledOnce();
      env.repository.close();
    });

    it('fails closed before network I/O when disk reserve is unavailable', async () => {
      let requests = 0;
      const env = await fixture({
        availableBytes: 0,
        fetch: async () => {
          requests += 1;
          return new Response();
        },
      });
      const queued = await env.manager.enqueue(env.plan);

      const failed = await env.manager.run(queued.id, env.plan);

      expect(failed).toMatchObject({ state: 'failed', failureCode: 'disk_full' });
      expect(requests).toBe(0);
      env.repository.close();
    });

    it('retains partial bytes on pause, recovers active jobs as interrupted, and deletes on confirmed cancel', async () => {
      const env = await fixture();
      const queued = await env.manager.enqueue(env.plan);
      const partial = env.store.partialPath(queued.modelId, 1);
      await writeFile(partial, env.bytes[0]!.subarray(0, 3));
      env.repository.progress(queued.id, 1, 3, '"old"');
      env.repository.transition(queued.id, 'downloading', '2026-08-23T00:00:01.000Z');

      expect(env.manager.recoverInterrupted()).toBe(1);
      expect(env.repository.getJob(queued.id).state).toBe('interrupted');
      expect((await readFile(partial)).byteLength).toBe(3);

      await env.manager.cancel(queued.id, true);
      expect(env.repository.getJob(queued.id).state).toBe('canceled');
      await expect(readFile(partial)).rejects.toMatchObject({ code: 'ENOENT' });
      env.repository.close();
    });

    it('rejects a changed ETag when resuming instead of appending a different source', async () => {
      const env = await fixture({
        fetch: async () =>
          new Response(Buffer.from('st shard'), {
            status: 206,
            headers: {
              'content-length': '8',
              'content-range': 'bytes 3-10/11',
              etag: '"new"',
            },
          }),
      });
      const queued = await env.manager.enqueue(env.plan);
      await writeFile(env.store.partialPath(queued.modelId, 1), Buffer.from('fir'));
      env.repository.progress(queued.id, 1, 3, '"old"');

      const failed = await env.manager.run(queued.id, env.plan);

      expect(failed).toMatchObject({ state: 'failed', failureCode: 'source_changed' });
      env.repository.close();
    });

    it('rejects arbitrary and private source URLs before creating a durable job', async () => {
      const env = await fixture();
      const unsafe = {
        ...env.plan,
        artifacts: [{ ...env.plan.artifacts[0]!, sourceUrl: 'http://127.0.0.1/model.gguf' }],
      };

      await expect(env.manager.enqueue(unsafe)).rejects.toThrow('Unsafe model source URL');
      env.repository.close();
    });

    it('replaces a mutable LocalAI Gallery main ref with the resolved immutable revision', async () => {
      const requested: string[] = [];
      const bytes = Buffer.from('gallery model');
      const env = await fixture({
        bytes: [bytes],
        fetch: async (url) => {
          requested.push(String(url));
          return new Response(new Uint8Array(bytes), {
            status: 200,
            headers: { 'content-length': String(bytes.byteLength) },
          });
        },
      });
      const revision = 'd'.repeat(40);
      const plan: LocalModelInstallPlan = {
        ...env.plan,
        source: 'localai_gallery',
        sourceId: 'gallery-model',
        immutableRevision: revision,
        artifacts: [
          {
            ...env.plan.artifacts[0]!,
            sourceUrl: 'https://huggingface.co/owner/model/resolve/main/model.gguf',
          },
        ],
      };

      const queued = await env.manager.enqueue(plan);
      expect((await env.manager.run(queued.id, plan)).state).toBe('installed');
      expect(requested).toEqual([
        `https://huggingface.co/owner/model/resolve/${revision}/model.gguf`,
      ]);
      env.repository.close();
    });

    it('keeps a failed deletion retryable and removes DB rows only after filesystem success', async () => {
      const env = await fixture({ bytes: [Buffer.from('one model')] });
      const queued = await env.manager.enqueue(env.plan);
      const installed = await env.manager.run(queued.id, env.plan);
      const modelPath = join(env.store.rootPath, 'models', installed.modelId);
      const unsafeEntry = join(modelPath, 'unexpected-directory');
      await mkdir(unsafeEntry);

      await expect(env.manager.deleteInstalled(installed.modelId)).rejects.toMatchObject({
        code: 'unsafe_store',
      });
      expect(env.repository.getJob(queued.id).state).toBe('installed');

      await rm(unsafeEntry, { recursive: true });
      await env.manager.deleteInstalled(installed.modelId);
      expect(() => env.repository.getJob(queued.id)).toThrow('not found');
      env.repository.close();
    });

    it('consults the Main-owned lifecycle gate before changing filesystem or DB state', async () => {
      const env = await fixture({
        bytes: [Buffer.from('leased model')],
        assertModelDeletable: () => {
          throw new Error('Model has an active lease');
        },
      });
      const queued = await env.manager.enqueue(env.plan);
      const installed = await env.manager.run(queued.id, env.plan);

      await expect(env.manager.deleteInstalled(installed.modelId)).rejects.toThrow('active lease');
      expect(env.repository.getJob(queued.id).state).toBe('installed');
      expect(await readdir(join(env.store.rootPath, 'models', installed.modelId))).not.toHaveLength(
        0,
      );
      env.repository.close();
    });
  });
else
  describe('LocalModelDownloadManager Electron ABI bridge', () => {
    it(
      'runs the SQLite integration suite with the bundled Electron Node ABI',
      () => {
        const result = spawnSync(
          electronTestExecutablePath(),
          [
            join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
            'run',
            'src/main/local-model-download-manager.test.ts',
          ],
          {
            cwd: process.cwd(),
            encoding: 'utf8',
            env: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: '1',
              SPRINT_CODER_ELECTRON_LOCAL_MODEL_DB_TEST: '1',
            },
            timeout: localModelBridgeTimeoutMs,
          },
        );
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      },
      localModelBridgeTimeoutMs + 5_000,
    );
  });

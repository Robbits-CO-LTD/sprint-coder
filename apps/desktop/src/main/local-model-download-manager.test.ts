import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
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
import type { LocalHardwareSnapshot } from '@sprint-coder/contracts';
import {
  LocalModelDownloadManager,
  LocalModelDownloadRepository,
  LocalModelStore,
  type LocalModelInstallPlan,
} from './local-model-download-manager';

const roots: string[] = [];
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
  return { root, repository, store, manager, plan, bytes };
}

if (runsWithElectronAbi)
  describe('LocalModelDownloadManager', () => {
    it.each([false, true])(
      'connects controller settings and pair-bound evidence (v82 migration: %s)',
      async (legacy) => {
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
        const target = env.manager.enqueue(targetPlan);
        const draft = env.manager.enqueue(draftPlan);
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
      const target = env.manager.enqueue(targetPlan);
      const draft = env.manager.enqueue(draftPlan);
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
      const second = env.manager.enqueue(secondPlan);
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
      const job = env.manager.enqueue(plan);
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
      const job = env.manager.enqueue(env.plan);
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
      const job = env.manager.enqueue(env.plan);
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
      const job = env.manager.enqueue(env.plan);
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
      const queued = env.manager.enqueue(env.plan);

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
      const queued = env.manager.enqueue(env.plan);
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
      const queued = env.manager.enqueue(plan);
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
      const queued = env.manager.enqueue(env.plan);
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
      const queued = env.manager.enqueue(env.plan);
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
      const queued = env.manager.enqueue(env.plan);
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
      const requeued = env.manager.enqueue(env.plan);
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
      const queued = env.manager.enqueue(env.plan);

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
      const queued = env.manager.enqueue(env.plan);

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
      const queued = env.manager.enqueue(env.plan);

      const failed = await env.manager.run(queued.id, env.plan);

      expect(failed).toMatchObject({ state: 'failed', failureCode: 'disk_full' });
      expect(requests).toBe(0);
      env.repository.close();
    });

    it('retains partial bytes on pause, recovers active jobs as interrupted, and deletes on confirmed cancel', async () => {
      const env = await fixture();
      const queued = env.manager.enqueue(env.plan);
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
      const queued = env.manager.enqueue(env.plan);
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

      expect(() => env.manager.enqueue(unsafe)).toThrow('Unsafe model source URL');
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

      const queued = env.manager.enqueue(plan);
      expect((await env.manager.run(queued.id, plan)).state).toBe('installed');
      expect(requested).toEqual([
        `https://huggingface.co/owner/model/resolve/${revision}/model.gguf`,
      ]);
      env.repository.close();
    });

    it('keeps a failed deletion retryable and removes DB rows only after filesystem success', async () => {
      const env = await fixture({ bytes: [Buffer.from('one model')] });
      const queued = env.manager.enqueue(env.plan);
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
      const queued = env.manager.enqueue(env.plan);
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

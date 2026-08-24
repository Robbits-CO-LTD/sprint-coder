import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { SqlitePersistenceClient } from './persistence';
import { ManagedLocalController } from './managed-local-controller';
import { ManagedLocalRuntimeLifecycle } from './managed-local-runtime-lifecycle';
import { loadBundledManagedLocalSidecar } from './managed-local-sidecar-bundle';
import type { ManagedLocalSidecarPin, ManagedLocalTargetKey } from './managed-local-sidecar-bundle';
import { electronTestExecutablePath } from './electron-test-runtime';
import { collectLocalHardwareSnapshot } from './local-hardware-inventory';
import type { LocalHardwareSnapshot } from '@sprint-coder/contracts';

const LIVE = process.env['SPRINT_CODER_MANAGED_LOCAL_CODING_LIVE'] === '1';
const ELECTRON_LIVE = process.env['SPRINT_CODER_ELECTRON_MANAGED_LOCAL_CODING_LIVE'] === '1';
const REPO = 'Qwen/Qwen3-0.6B-GGUF';
const REVISION = '23749fefcc72300e3a2ad315e1317431b06b590a';
const ARTIFACT = 'Qwen3-0.6B-Q8_0.gguf';
const SHA256 = '9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031';
const SIZE_BYTES = 639_446_688;
const QUANTIZATION = 'Q8_0';

describe.runIf(LIVE && ELECTRON_LIVE)('Managed Local coding live smoke', () => {
  it(
    'downloads, hashes, loads, chats, completes a nonce tool round-trip, stops, and deletes',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'sprint-coder-managed-local-live-'));
      const databasePath = join(root, 'sprint-coder.sqlite3');
      new SqlitePersistenceClient(databasePath).close();
      const target = `${process.platform}-${process.arch}` as ManagedLocalTargetKey;
      const buildRoot = join(process.cwd(), 'managed-local', 'build');
      const pins = JSON.parse(
        await readFile(join(buildRoot, 'managed-local-sidecar-pins.json'), 'utf8'),
      ) as Partial<Record<ManagedLocalTargetKey, ManagedLocalSidecarPin>>;
      const bundle = await loadBundledManagedLocalSidecar({
        rootPath: join(buildRoot, 'managed-local', target),
        pins,
      });
      let lastHardware: LocalHardwareSnapshot | null = null;
      const collectHardware = async () => {
        const candidates =
          process.platform === 'darwin' ? bundle.manifest.candidateBackends : (['cpu'] as const);
        lastHardware = await collectLocalHardwareSnapshot({
          backends: async () =>
            candidates.map((kind) => ({
              kind,
              status: 'available' as const,
            })),
        });
        return lastHardware;
      };
      const lifecycle = new ManagedLocalRuntimeLifecycle({ bundle, collectHardware });
      const controller = await ManagedLocalController.create({
        databasePath,
        storeRoot: join(root, 'local-models'),
        lifecycle,
        bundle,
        collectHardware,
      });
      try {
        const detail = await controller.detail({ source: 'hugging_face', sourceId: REPO });
        expect(detail.item).toMatchObject({
          immutableRevision: REVISION,
          license: 'apache-2.0',
        });
        const artifact = detail.artifacts.find(({ filename }) => filename === ARTIFACT);
        expect(artifact).toMatchObject({
          sizeBytes: SIZE_BYTES,
          sha256: SHA256,
          quantization: QUANTIZATION,
          installability: { state: 'installable' },
        });
        const job = await controller.install({
          source: 'hugging_face',
          sourceId: REPO,
          artifactIds: [artifact!.id],
          quantization: QUANTIZATION,
          confirmed: true,
        });
        const installed = await waitForInstall(controller, job.id, 8 * 60_000);
        expect(installed).toMatchObject({
          state: 'installed',
          downloadedBytes: SIZE_BYTES,
          totalBytes: SIZE_BYTES,
        });
        expect(controller.listInstalled()).toContainEqual(
          expect.objectContaining({ id: installed.modelId, sourceId: REPO, state: 'installed' }),
        );

        const verification = await controller.verify(installed.modelId).catch((error: unknown) => {
          throw new Error(
            `Managed Local verification failed: ${error instanceof Error ? error.message : 'unknown'}; ` +
              `hardware=${JSON.stringify(lastHardware)}; runtime=${JSON.stringify(controller.runtime())}`,
          );
        });
        expect(verification).toMatchObject({
          state: 'verified_tools',
          verification: { level: 'tools' },
        });
        const models = await controller.listProviderModels(
          'managed-local:runtime',
          'sprint-managed-local',
        );
        expect(models).toContainEqual(
          expect.objectContaining({
            modelId: installed.modelId,
            available: true,
            toolCalling: expect.objectContaining({ value: true }),
          }),
        );

        await controller.delete(installed.modelId);
        expect(controller.listInstalled()).toEqual([]);
        expect(await readdir(join(root, 'local-models', 'models'))).toEqual([]);
      } finally {
        await controller.dispose().catch(() => undefined);
        await lifecycle.dispose().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    },
    10 * 60_000,
  );
});

describe.runIf(LIVE && !ELECTRON_LIVE)(
  'Managed Local coding live smoke Electron ABI bridge',
  () => {
    it(
      'runs the live coding smoke under the bundled Electron Node ABI',
      () => {
        const result = spawnSync(
          electronTestExecutablePath(),
          [
            join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
            'run',
            'src/main/managed-local-coding-live-smoke.test.ts',
          ],
          {
            cwd: process.cwd(),
            encoding: 'utf8',
            env: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: '1',
              SPRINT_CODER_MANAGED_LOCAL_CODING_LIVE: '1',
              SPRINT_CODER_ELECTRON_MANAGED_LOCAL_CODING_LIVE: '1',
            },
            timeout: 11 * 60_000,
          },
        );
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      },
      11 * 60_000 + 5_000,
    );
  },
);

async function waitForInstall(
  controller: ManagedLocalController,
  jobId: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = controller.listJobs().find(({ id }) => id === jobId);
    if (job === undefined) throw new Error('Managed Local live job disappeared');
    if (job.state === 'installed') return job;
    if (job.state === 'failed' || job.state === 'canceled')
      throw new Error(`Managed Local live install ended as ${job.state}:${job.failureCode ?? ''}`);
    if (Date.now() >= deadline) throw new Error('Managed Local live install timed out');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

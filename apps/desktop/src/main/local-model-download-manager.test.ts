import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePersistenceClient } from './persistence';
import {
  LocalModelDownloadManager,
  LocalModelDownloadRepository,
  LocalModelStore,
  type LocalModelInstallPlan,
} from './local-model-download-manager';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(input?: {
  bytes?: readonly Buffer[];
  fetch?: typeof globalThis.fetch;
  availableBytes?: number;
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
    fetch,
    () => '2026-08-23T00:00:00.000Z',
    async () => input?.availableBytes ?? 1024 * 1024 * 1024,
  );
  return { root, repository, store, manager, plan, bytes };
}

describe('LocalModelDownloadManager', () => {
  it('publishes every verified split GGUF shard before marking the model installed', async () => {
    const env = await fixture();
    const queued = env.manager.enqueue(env.plan);

    const installed = await env.manager.run(queued.id, env.plan);

    expect(installed.state).toBe('installed');
    expect(installed.completedArtifacts).toBe(2);
    const modelPath = join(env.store.rootPath, 'models', installed.modelId);
    expect(await readdir(modelPath)).toEqual(['001.gguf', '002.gguf']);
    expect(await readFile(join(modelPath, '001.gguf'))).toEqual(env.bytes[0]);
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

    await expect(env.manager.deleteInstalled(installed.modelId, 0)).rejects.toMatchObject({
      code: 'unsafe_store',
    });
    expect(env.repository.getJob(queued.id).state).toBe('installed');

    await rm(unsafeEntry, { recursive: true });
    await env.manager.deleteInstalled(installed.modelId, 0);
    expect(() => env.repository.getJob(queued.id)).toThrow('not found');
    env.repository.close();
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditArtifactStore } from './edit-artifact-store';
import type { EditArtifactError } from './edit-artifact-store';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(quotaBytes = 1024) {
  const root = await mkdtemp(join(tmpdir(), 'vibe-edit-artifact-'));
  roots.push(root);
  const store = await EditArtifactStore.open({ rootPath: root, quotaBytes });
  return { root, store };
}

describe('EditArtifactStore', () => {
  it('durably stores exact bytes behind an opaque owner-bound manifest', async () => {
    const { root, store } = await fixture();
    const ref = await store.put({
      owner: { sagaId: 'saga-1', ordinal: 1, role: 'preimage' },
      bytes: Buffer.from('const secret = "value";\n'),
    });

    expect(ref).toMatchObject({
      version: 1,
      artifactId: expect.stringMatching(/^[a-f0-9]{64}$/),
      size: 24,
      owner: { sagaId: 'saga-1', ordinal: 1, role: 'preimage' },
    });
    expect(ref.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(ref)).not.toContain(root);
    await expect(store.read(ref)).resolves.toEqual(Buffer.from('const secret = "value";\n'));
    expect((await readdir(root)).sort()).toEqual([
      `${ref.artifactId}.bin`,
      `${ref.artifactId}.json`,
    ]);
  });

  it('rejects quota overflow without publishing a partial artifact', async () => {
    const { root, store } = await fixture(8);
    await expect(
      store.put({
        owner: { sagaId: 'saga-1', ordinal: 1, role: 'postimage' },
        bytes: Buffer.from('123456789'),
      }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' } satisfies Partial<EditArtifactError>);
    expect(await readdir(root)).toEqual([]);
  });

  it('reuses deterministic owner-bound artifacts and releases both files', async () => {
    const { root, store } = await fixture();
    const input = {
      owner: { sagaId: 'saga-1', ordinal: 1, role: 'preimage' as const },
      bytes: Buffer.from('before'),
    };
    const first = await store.put(input);
    const second = await store.put(input);
    expect(second).toEqual(first);
    expect(await readdir(root)).toHaveLength(2);

    await store.release(first);
    expect(await readdir(root)).toEqual([]);
  });

  it('removes an interrupted final artifact pair when reopening', async () => {
    const { root } = await fixture();
    const orphanId = 'a'.repeat(64);
    await writeFile(join(root, `${orphanId}.bin`), 'orphan');

    await EditArtifactStore.open({ rootPath: root, quotaBytes: 1024 });

    expect(await readdir(root)).toEqual([]);
  });

  it('detects content and manifest tampering after restart', async () => {
    const { root, store } = await fixture();
    const ref = await store.put({
      owner: { sagaId: 'saga-1', ordinal: 1, role: 'preimage' },
      bytes: Buffer.from('before'),
    });
    await writeFile(join(root, `${ref.artifactId}.bin`), 'tampered');
    const reopened = await EditArtifactStore.open({ rootPath: root, quotaBytes: 1024 });
    await expect(reopened.read(ref)).rejects.toMatchObject({
      code: 'INTEGRITY_MISMATCH',
    } satisfies Partial<EditArtifactError>);

    await writeFile(join(root, `${ref.artifactId}.bin`), 'before');
    const manifestPath = join(root, `${ref.artifactId}.json`);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { contentHash: string };
    manifest.contentHash = 'f'.repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(reopened.read(ref)).rejects.toMatchObject({
      code: 'INTEGRITY_MISMATCH',
    } satisfies Partial<EditArtifactError>);
  });

  it('fails closed when artifact files become writable by other users', async () => {
    const { root, store } = await fixture();
    const ref = await store.put({
      owner: { sagaId: 'saga-1', ordinal: 1, role: 'preimage' },
      bytes: Buffer.from('before'),
    });
    await chmod(join(root, `${ref.artifactId}.bin`), 0o666);
    await expect(store.read(ref)).rejects.toMatchObject({
      code: 'UNSAFE_ARTIFACT',
    } satisfies Partial<EditArtifactError>);
  });
});

import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimeImageManifestDigest, type RuntimeImageAttachmentManifestEntry } from './protocol';
import {
  prepareRuntimeImages,
  releasePreparedRuntimeImages,
  reverifyPreparedRuntimeImages,
} from './image-attachment-preparer';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  path: string;
  bytes: Buffer;
  manifest: RuntimeImageAttachmentManifestEntry[];
}> {
  const root = await mkdtemp(join(tmpdir(), 'sprint-coder-runtime-images-'));
  cleanup.push(root);
  const path = join(root, '001.png');
  const bytes = await sharp({
    create: { width: 2, height: 2, channels: 4, background: '#336699' },
  })
    .png()
    .toBuffer();
  await writeFile(path, bytes, { mode: 0o400 });
  return {
    path,
    bytes,
    manifest: [
      {
        id: 'attachment-1',
        mimeType: 'image/png',
        byteLength: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ],
  };
}

describe.skipIf(process.platform === 'win32')('Runtime image attachment preparation', () => {
  it('decodes, retains, and re-verifies exact canonical bytes', async () => {
    const { path, bytes, manifest } = await fixture();
    const digest = runtimeImageManifestDigest(manifest);
    const prepared = await prepareRuntimeImages(manifest, [path], digest);
    expect(prepared).toMatchObject({ manifestDigest: digest, decodedByteLength: bytes.byteLength });
    await expect(reverifyPreparedRuntimeImages(prepared)).resolves.toBeUndefined();

    await chmod(path, 0o600);
    await writeFile(path, Buffer.alloc(bytes.byteLength, 0x20));
    await expect(reverifyPreparedRuntimeImages(prepared)).rejects.toThrow(
      'attachment content mismatch',
    );
    await releasePreparedRuntimeImages(prepared);
  });

  it('rejects manifest, decode, and no-follow path mismatches', async () => {
    const { path, bytes, manifest } = await fixture();
    await expect(prepareRuntimeImages(manifest, [path], '0'.repeat(64))).rejects.toThrow(
      'manifest mismatch',
    );
    const wrongMime = [{ ...manifest[0]!, mimeType: 'image/jpeg' as const }];
    await expect(
      prepareRuntimeImages(wrongMime, [path], runtimeImageManifestDigest(wrongMime)),
    ).rejects.toThrow('attachment decode mismatch');

    const symlinkPath = join(path, '..', 'linked.png');
    await symlink(path, symlinkPath);
    await expect(
      prepareRuntimeImages(manifest, [symlinkPath], runtimeImageManifestDigest(manifest)),
    ).rejects.toThrow();

    const truncatedPath = join(path, '..', 'truncated.png');
    const truncated = bytes.subarray(0, Math.floor(bytes.byteLength * 0.7));
    await writeFile(truncatedPath, truncated, { mode: 0o400 });
    const truncatedManifest = [
      {
        ...manifest[0]!,
        byteLength: truncated.byteLength,
        sha256: createHash('sha256').update(truncated).digest('hex'),
      },
    ];
    await expect(
      prepareRuntimeImages(
        truncatedManifest,
        [truncatedPath],
        runtimeImageManifestDigest(truncatedManifest),
      ),
    ).rejects.toThrow();

    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareRuntimeImages(
        manifest,
        [path],
        runtimeImageManifestDigest(manifest),
        controller.signal,
      ),
    ).rejects.toThrow('attachment preparation aborted');
  });
});

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import sharp from 'sharp';
import { runtimeImageManifestDigest, type RuntimeImageAttachmentManifestEntry } from './protocol';

const MAX_DIMENSION = 8192;
const MAX_PIXELS = 16_777_216;

export type PreparedRuntimeImages = Readonly<{
  manifest: readonly RuntimeImageAttachmentManifestEntry[];
  paths: readonly string[];
  handles: readonly FileHandle[];
  manifestDigest: string;
  decodedByteLength: number;
}>;

export async function prepareRuntimeImages(
  manifest: readonly RuntimeImageAttachmentManifestEntry[],
  paths: readonly string[],
  expectedManifestDigest: string,
  signal?: AbortSignal,
): Promise<PreparedRuntimeImages> {
  if (runtimeImageManifestDigest(manifest) !== expectedManifestDigest)
    throw new Error('manifest mismatch');
  const handles: FileHandle[] = [];
  const closeHandles = (): void => {
    void Promise.all(handles.map((handle) => handle.close().catch(() => undefined)));
  };
  signal?.addEventListener('abort', closeHandles, { once: true });
  let decodedByteLength = 0;
  try {
    for (const [index, entry] of manifest.entries()) {
      throwIfAborted(signal);
      const handle = await open(paths[index]!, constants.O_RDONLY | constants.O_NOFOLLOW);
      handles.push(handle);
      throwIfAborted(signal);
      const bytes = await readVerified(handle, entry);
      await assertDecodedImage(bytes, entry.mimeType);
      throwIfAborted(signal);
      decodedByteLength += bytes.byteLength;
    }
    return Object.freeze({
      manifest: Object.freeze(manifest.map((entry) => Object.freeze({ ...entry }))),
      paths: Object.freeze([...paths]),
      handles: Object.freeze(handles),
      manifestDigest: expectedManifestDigest,
      decodedByteLength,
    });
  } catch (error) {
    await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)));
    throw error;
  } finally {
    signal?.removeEventListener('abort', closeHandles);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new Error('attachment preparation aborted');
}

export async function reverifyPreparedRuntimeImages(
  prepared: PreparedRuntimeImages,
): Promise<void> {
  for (const [index, entry] of prepared.manifest.entries())
    await readVerified(prepared.handles[index]!, entry);
}

export async function releasePreparedRuntimeImages(prepared: PreparedRuntimeImages): Promise<void> {
  await Promise.all(prepared.handles.map((handle) => handle.close().catch(() => undefined)));
}

async function readVerified(
  handle: FileHandle,
  entry: RuntimeImageAttachmentManifestEntry,
): Promise<Buffer> {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(entry.byteLength))
    throw new Error('attachment identity mismatch');
  const bytes = Buffer.allocUnsafe(entry.byteLength + 1);
  let total = 0;
  while (total < bytes.byteLength) {
    const { bytesRead } = await handle.read(bytes, total, bytes.byteLength - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  if (
    total !== entry.byteLength ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.nlink !== after.nlink ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    createHash('sha256').update(bytes.subarray(0, total)).digest('hex') !== entry.sha256
  )
    throw new Error('attachment content mismatch');
  return Buffer.from(bytes.subarray(0, total));
}

async function assertDecodedImage(
  bytes: Buffer,
  mimeType: RuntimeImageAttachmentManifestEntry['mimeType'],
): Promise<void> {
  const decoder = sharp(bytes, {
    animated: false,
    failOn: 'warning',
    limitInputPixels: MAX_PIXELS,
    unlimited: false,
  });
  const metadata = await decoder.metadata();
  const expectedFormat =
    mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpeg' : 'webp';
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (
    metadata.format !== expectedFormat ||
    (metadata.pages ?? 1) !== 1 ||
    width < 1 ||
    height < 1 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS
  )
    throw new Error('attachment decode mismatch');
  const decoded = await decoder.clone().raw().toBuffer({ resolveWithObject: true });
  if (
    decoded.info.width !== width ||
    decoded.info.height !== height ||
    decoded.data.byteLength < width * height
  )
    throw new Error('attachment decode mismatch');
}

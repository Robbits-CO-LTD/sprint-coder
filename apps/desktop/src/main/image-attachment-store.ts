import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { basename } from 'node:path';
import sharp, { type FormatEnum, type Metadata, type OutputInfo, type Sharp } from 'sharp';
import {
  IMAGE_ATTACHMENT_MAX_BYTES,
  IMAGE_ATTACHMENT_PREVIEW_MAX_EDGE,
  type ImageAttachmentMetadata,
  type ImageAttachmentMimeType,
  type ImageAttachmentPreview,
} from '@sprint-coder/contracts';
import type { PersistenceClient } from './persistence';
import { readWindowsNoReparseImageFile } from './native-file-publication';

const IMAGE_ATTACHMENT_MAX_DIMENSION = 8192;
const IMAGE_ATTACHMENT_MAX_PIXELS = 16_777_216;
const FORBIDDEN_FILE_NAME = /[/\\\u202a-\u202e\u2066-\u2069]/u;

export type ImageAttachmentValidationReason =
  | 'unsupported_platform'
  | 'unsafe_file'
  | 'file_too_large'
  | 'invalid_file_name'
  | 'invalid_image'
  | 'clipboard_image_too_large';

export class ImageAttachmentValidationError extends Error {
  constructor(readonly reason: ImageAttachmentValidationReason) {
    super(imageAttachmentValidationMessage(reason));
    this.name = 'ImageAttachmentValidationError';
  }
}

function imageAttachmentValidationMessage(reason: ImageAttachmentValidationReason): string {
  switch (reason) {
    case 'unsupported_platform':
      return 'この環境では画像添付を安全に読み込めません。';
    case 'file_too_large':
      return '画像は1枚5MB以下にしてください。';
    case 'invalid_file_name':
      return 'このファイル名は使用できません。名前を変更してから選び直してください。';
    case 'invalid_image':
      return 'PNG・JPEG・WebPの静止画像を選んでください。';
    case 'unsafe_file':
      return 'この画像は安全に読み込めません。通常のファイルを選び直してください。';
    case 'clipboard_image_too_large':
      return 'コピーした画像が大きすぎます。縮小してからコピーし直してください。';
  }
}

export class ImageAttachmentDraftStore {
  constructor(private readonly persistence: PersistenceClient) {}

  async addFromPath(taskId: string, selectedPath: string): Promise<ImageAttachmentMetadata> {
    const fileName = normalizeAttachmentFileName(selectedPath);
    const input =
      process.platform === 'win32'
        ? readSelectedWindowsFile(selectedPath)
        : await readSelectedRegularFile(selectedPath);
    const canonical = await canonicalizeImage(input);
    return this.persistence.createDraftImageAttachment({
      taskId,
      fileName,
      mimeType: canonical.mimeType,
      bytes: canonical.bytes,
    });
  }

  /**
   * Adds bytes the OS clipboard handed to Main.
   *
   * The Renderer never supplies image bytes: it only reports that the paste it received carried an
   * image, and Main reads the clipboard itself. So this path keeps the same custody rule as the
   * picker — bytes enter through Main, are decoded and re-encoded by `canonicalizeImage`, and the
   * Renderer only ever sees public metadata.
   */
  async addFromClipboard(
    taskId: string,
    bytes: Buffer,
    fileName: string,
  ): Promise<ImageAttachmentMetadata> {
    const canonical = await canonicalizeImage(await fitClipboardImage(bytes));
    return this.persistence.createDraftImageAttachment({
      taskId,
      fileName: normalizeAttachmentFileName(fileName),
      mimeType: canonical.mimeType,
      bytes: canonical.bytes,
    });
  }

  list(taskId: string): ImageAttachmentMetadata[] {
    return this.persistence.listDraftImageAttachments(taskId);
  }

  async preview(taskId: string, attachmentId: string): Promise<ImageAttachmentPreview> {
    const found = this.persistence.readDraftImageAttachment(taskId, attachmentId);
    if (found === null) throw new ImageAttachmentValidationError('invalid_image');
    return renderAttachmentPreview(found.metadata.id, found.bytes);
  }

  remove(taskId: string, attachmentId: string): void {
    this.persistence.removeDraftImageAttachment(taskId, attachmentId);
  }
}

/**
 * The size a clipboard image has to be resized to before it can be decoded at all, or `null` when
 * it already fits.
 *
 * A 6K capture is 20.4M pixels — past the decoder's pixel envelope, and small enough in bytes that
 * the byte-driven step-down below would never look at it. Bounding happens at the `NativeImage` the
 * clipboard handed over (Chromium has already decoded it, so no untrusted decode is involved) and
 * before the PNG encode, which is what makes those captures pasteable instead of rejected as "not
 * a still image".
 */
export function boundClipboardImageSize(size: {
  width: number;
  height: number;
}): { width: number; height: number } | null {
  const { width, height } = size;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  const scale = Math.min(
    1,
    Math.sqrt(IMAGE_ATTACHMENT_MAX_PIXELS / (width * height)),
    IMAGE_ATTACHMENT_MAX_DIMENSION / width,
    IMAGE_ATTACHMENT_MAX_DIMENSION / height,
  );
  if (scale >= 1) return null;
  let bounded = {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
  // Floating-point scale plus flooring lands inside the envelope in practice; this closes the edge
  // rather than trusting that, and terminates because both edges shrink.
  while (
    bounded.width * bounded.height > IMAGE_ATTACHMENT_MAX_PIXELS &&
    (bounded.width > 1 || bounded.height > 1)
  )
    bounded = {
      width: Math.max(1, bounded.width - 1),
      height: Math.max(1, bounded.height - 1),
    };
  return bounded;
}

/**
 * A pasted screenshot is whatever size the display is, and a Retina full-screen grab routinely
 * encodes past the 5 MiB per-image cap. Refusing it would make Ctrl+V unusable on exactly the
 * screens people paste most, so the long edge is stepped down until the encode fits. Steps are
 * fixed rather than computed so the same clipboard always yields the same attachment.
 */
export const CLIPBOARD_IMAGE_DOWNSCALE_EDGES = [2048, 1536, 1024] as const;

export async function fitClipboardImage(bytes: Buffer): Promise<Buffer> {
  if (bytes.byteLength <= IMAGE_ATTACHMENT_MAX_BYTES) return bytes;
  for (const edge of CLIPBOARD_IMAGE_DOWNSCALE_EDGES) {
    const resized = await sharp(bytes, {
      animated: false,
      failOn: 'warning',
      limitInputPixels: IMAGE_ATTACHMENT_MAX_PIXELS,
      unlimited: false,
    })
      .rotate()
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer()
      .catch(() => null);
    if (resized !== null && resized.byteLength <= IMAGE_ATTACHMENT_MAX_BYTES) return resized;
  }
  throw new ImageAttachmentValidationError('clipboard_image_too_large');
}

export async function renderAttachmentPreview(
  attachmentId: string,
  bytes: Buffer,
): Promise<ImageAttachmentPreview> {
  try {
    const output = await sharp(bytes, {
      animated: false,
      failOn: 'warning',
      limitInputPixels: IMAGE_ATTACHMENT_MAX_PIXELS,
      unlimited: false,
    })
      .rotate()
      .resize({
        width: IMAGE_ATTACHMENT_PREVIEW_MAX_EDGE,
        height: IMAGE_ATTACHMENT_PREVIEW_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 72 })
      .toBuffer({ resolveWithObject: true });
    return {
      id: attachmentId,
      mimeType: 'image/webp',
      width: output.info.width,
      height: output.info.height,
      base64: output.data.toString('base64'),
    };
  } catch (error) {
    if (error instanceof ImageAttachmentValidationError) throw error;
    throw new ImageAttachmentValidationError('invalid_image');
  }
}

function readSelectedWindowsFile(selectedPath: string): Buffer {
  try {
    return readWindowsNoReparseImageFile(selectedPath);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'IMAGE_FILE_TOO_LARGE'
    )
      throw new ImageAttachmentValidationError('file_too_large');
    throw new ImageAttachmentValidationError('unsafe_file');
  }
}

/**
 * A clipboard image has no name of its own, so one is minted here. The timestamp keeps repeated
 * pastes distinguishable in the Composer chip list, which is the only place this string is shown.
 */
export function clipboardAttachmentFileName(now: Date): string {
  const stamp = [
    now.getFullYear(),
    `${now.getMonth() + 1}`.padStart(2, '0'),
    `${now.getDate()}`.padStart(2, '0'),
    '-',
    `${now.getHours()}`.padStart(2, '0'),
    `${now.getMinutes()}`.padStart(2, '0'),
    `${now.getSeconds()}`.padStart(2, '0'),
  ].join('');
  return `貼り付け画像-${stamp}.png`;
}

export function normalizeAttachmentFileName(selectedPath: string): string {
  const name = basename(selectedPath).normalize('NFC');
  if (
    name.length < 1 ||
    name.length > 255 ||
    name === '.' ||
    name === '..' ||
    FORBIDDEN_FILE_NAME.test(name) ||
    Array.from(name).some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  )
    throw new ImageAttachmentValidationError('invalid_file_name');
  return name;
}

export async function readSelectedRegularFile(
  selectedPath: string,
  afterRead?: (() => void | Promise<void>) | undefined,
  onReadRequest?: ((byteLength: number) => void) | undefined,
): Promise<Buffer> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(selectedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n)
      throw new ImageAttachmentValidationError('unsafe_file');
    if (before.size < 1n || before.size > BigInt(IMAGE_ATTACHMENT_MAX_BYTES))
      throw new ImageAttachmentValidationError('file_too_large');
    const expectedSize = Number(before.size);
    const bytes = Buffer.alloc(expectedSize);
    let offset = 0;
    while (offset < expectedSize) {
      const requested = expectedSize - offset;
      onReadRequest?.(requested);
      const { bytesRead } = await handle.read(bytes, offset, requested, offset);
      if (bytesRead === 0) throw new ImageAttachmentValidationError('unsafe_file');
      offset += bytesRead;
    }
    await afterRead?.();
    const overflowProbe = Buffer.alloc(1);
    onReadRequest?.(1);
    if ((await handle.read(overflowProbe, 0, 1, expectedSize)).bytesRead !== 0)
      throw new ImageAttachmentValidationError('unsafe_file');
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(before, after) || BigInt(bytes.byteLength) !== after.size)
      throw new ImageAttachmentValidationError('unsafe_file');
    return bytes;
  } catch (error) {
    if (error instanceof ImageAttachmentValidationError) throw error;
    throw new ImageAttachmentValidationError('unsafe_file');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export type CanonicalImage = Readonly<{
  bytes: Buffer;
  mimeType: ImageAttachmentMimeType;
  sha256: string;
}>;

/**
 * The only image-byte boundary shared by attachments and trusted workspace-image tools.
 * Callers may retain or transmit only the returned deterministic re-encoding.
 */
export async function canonicalizeImage(input: Buffer): Promise<CanonicalImage> {
  try {
    rejectAnimatedPng(input);
    const decoder = sharp(input, {
      animated: false,
      failOn: 'warning',
      limitInputPixels: IMAGE_ATTACHMENT_MAX_PIXELS,
      unlimited: false,
    });
    const metadata = await decoder.metadata();
    assertSupportedMetadata(metadata);
    const pipeline = decoder.rotate();
    const output = await encodeCanonical(pipeline, metadata.format!);
    assertOutputInfo(output.info, metadata.format!);
    if (output.data.byteLength < 1 || output.data.byteLength > IMAGE_ATTACHMENT_MAX_BYTES)
      throw new ImageAttachmentValidationError('file_too_large');
    const mimeType = mimeTypeForFormat(metadata.format!);
    return {
      bytes: output.data,
      mimeType,
      sha256: createHash('sha256').update(output.data).digest('hex'),
    };
  } catch (error) {
    if (error instanceof ImageAttachmentValidationError) throw error;
    throw new ImageAttachmentValidationError('invalid_image');
  }
}

function rejectAnimatedPng(input: Buffer): void {
  if (!input.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return;
  let offset = 8;
  while (offset + 12 <= input.byteLength) {
    const length = input.readUInt32BE(offset);
    const next = offset + 12 + length;
    if (next > input.byteLength) return;
    if (input.toString('ascii', offset + 4, offset + 8) === 'acTL')
      throw new ImageAttachmentValidationError('invalid_image');
    offset = next;
  }
}

function assertSupportedMetadata(
  metadata: Metadata,
): asserts metadata is Metadata & { format: 'png' | 'jpeg' | 'webp' } {
  if (!isSupportedFormat(metadata.format))
    throw new ImageAttachmentValidationError('invalid_image');
  if ((metadata.pages ?? 1) !== 1) throw new ImageAttachmentValidationError('invalid_image');
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (
    width < 1 ||
    height < 1 ||
    width > IMAGE_ATTACHMENT_MAX_DIMENSION ||
    height > IMAGE_ATTACHMENT_MAX_DIMENSION ||
    width * height > IMAGE_ATTACHMENT_MAX_PIXELS
  )
    throw new ImageAttachmentValidationError('invalid_image');
}

function isSupportedFormat(
  format: keyof FormatEnum | undefined,
): format is 'png' | 'jpeg' | 'webp' {
  return format === 'png' || format === 'jpeg' || format === 'webp';
}

async function encodeCanonical(
  pipeline: Sharp,
  format: 'png' | 'jpeg' | 'webp',
): Promise<{ data: Buffer; info: OutputInfo }> {
  if (format === 'png') return pipeline.png().toBuffer({ resolveWithObject: true });
  if (format === 'jpeg') return pipeline.jpeg().toBuffer({ resolveWithObject: true });
  return pipeline.webp().toBuffer({ resolveWithObject: true });
}

function assertOutputInfo(info: OutputInfo, format: 'png' | 'jpeg' | 'webp'): void {
  if (
    info.format !== format ||
    info.width < 1 ||
    info.height < 1 ||
    info.width > IMAGE_ATTACHMENT_MAX_DIMENSION ||
    info.height > IMAGE_ATTACHMENT_MAX_DIMENSION ||
    info.width * info.height > IMAGE_ATTACHMENT_MAX_PIXELS ||
    info.size < 1 ||
    info.size > IMAGE_ATTACHMENT_MAX_BYTES
  )
    throw new ImageAttachmentValidationError('invalid_image');
}

function mimeTypeForFormat(format: 'png' | 'jpeg' | 'webp'): ImageAttachmentMimeType {
  if (format === 'png') return 'image/png';
  if (format === 'jpeg') return 'image/jpeg';
  return 'image/webp';
}

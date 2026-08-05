import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { basename } from 'node:path';
import sharp, { type FormatEnum, type Metadata, type OutputInfo, type Sharp } from 'sharp';
import {
  IMAGE_ATTACHMENT_MAX_BYTES,
  type ImageAttachmentMetadata,
  type ImageAttachmentMimeType,
} from '@sprint-coder/contracts';
import type { PersistenceClient } from './persistence';

const IMAGE_ATTACHMENT_MAX_DIMENSION = 8192;
const IMAGE_ATTACHMENT_MAX_PIXELS = 16_777_216;
const FORBIDDEN_FILE_NAME = /[/\\\u202a-\u202e\u2066-\u2069]/u;

export type ImageAttachmentValidationReason =
  'unsupported_platform' | 'unsafe_file' | 'file_too_large' | 'invalid_file_name' | 'invalid_image';

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
  }
}

export class ImageAttachmentDraftStore {
  constructor(private readonly persistence: PersistenceClient) {}

  async addFromPath(taskId: string, selectedPath: string): Promise<ImageAttachmentMetadata> {
    if (process.platform === 'win32')
      throw new ImageAttachmentValidationError('unsupported_platform');
    const fileName = normalizeAttachmentFileName(selectedPath);
    const input = await readSelectedRegularFile(selectedPath);
    const canonical = await canonicalizeImage(input);
    return this.persistence.createDraftImageAttachment({
      taskId,
      fileName,
      mimeType: canonical.mimeType,
      bytes: canonical.bytes,
    });
  }

  list(taskId: string): ImageAttachmentMetadata[] {
    return this.persistence.listDraftImageAttachments(taskId);
  }

  remove(taskId: string, attachmentId: string): void {
    this.persistence.removeDraftImageAttachment(taskId, attachmentId);
  }
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

type CanonicalImage = Readonly<{
  bytes: Buffer;
  mimeType: ImageAttachmentMimeType;
  sha256: string;
}>;

async function canonicalizeImage(input: Buffer): Promise<CanonicalImage> {
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

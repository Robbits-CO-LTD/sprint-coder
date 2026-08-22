import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IMAGE_ATTACHMENT_MAX_BYTES } from '@sprint-coder/contracts';
import type { PersistenceClient } from './persistence';
import {
  boundClipboardImageSize,
  clipboardAttachmentFileName,
  fitClipboardImage,
  ImageAttachmentDraftStore,
  ImageAttachmentValidationError,
  normalizeAttachmentFileName,
  readSelectedRegularFile,
  renderAttachmentPreview,
} from './image-attachment-store';

const cleanup: string[] = [];

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-image-attachment-'));
  cleanup.push(directory);
  return directory;
}

function persistenceMock() {
  const createDraftImageAttachment = vi.fn((input) => ({
    id: 'attachment-1',
    fileName: input.fileName,
    mimeType: input.mimeType,
    byteLength: input.bytes.byteLength,
    createdAt: '2026-08-05T00:00:00.000Z',
  }));
  return {
    createDraftImageAttachment,
    listDraftImageAttachments: vi.fn(() => []),
    removeDraftImageAttachment: vi.fn(),
  } as unknown as PersistenceClient;
}

describe.skipIf(process.platform === 'win32')('ImageAttachmentDraftStore POSIX reads', () => {
  it('opens a regular image once and stores canonical bytes without its original path', async () => {
    const directory = tempDirectory();
    const path = join(directory, 'profile.png');
    const encoded = await sharp({
      create: { width: 2, height: 3, channels: 3, background: { r: 20, g: 40, b: 60 } },
    })
      .png()
      .withMetadata({ exif: { IFD0: { Copyright: 'private metadata' } } })
      .toBuffer();
    writeFileSync(path, Buffer.concat([encoded, Buffer.from('private trailing payload')]));
    const persistence = persistenceMock();
    const result = await new ImageAttachmentDraftStore(persistence).addFromPath('task-1', path);

    expect(result).toMatchObject({ fileName: 'profile.png', mimeType: 'image/png' });
    const input = vi.mocked(persistence.createDraftImageAttachment).mock.calls[0]![0];
    expect(input).not.toHaveProperty('path');
    expect(input.bytes.includes(Buffer.from('private metadata'))).toBe(false);
    expect(input.bytes.includes(Buffer.from('private trailing payload'))).toBe(false);
    expect(await sharp(input.bytes).metadata()).toMatchObject({
      format: 'png',
      width: 2,
      height: 3,
    });
  });

  it('rejects symlinks and multiply-linked files', async () => {
    const directory = tempDirectory();
    const original = join(directory, 'original.png');
    const bytes = await sharp({
      create: { width: 1, height: 1, channels: 3, background: 'black' },
    })
      .png()
      .toBuffer();
    writeFileSync(original, bytes);
    const symlink = join(directory, 'symlink.png');
    symlinkSync(original, symlink);
    const hardlink = join(directory, 'hardlink.png');
    linkSync(original, hardlink);
    const store = new ImageAttachmentDraftStore(persistenceMock());

    await expect(store.addFromPath('task-1', symlink)).rejects.toMatchObject({
      reason: 'unsafe_file',
    });
    await expect(store.addFromPath('task-1', hardlink)).rejects.toMatchObject({
      reason: 'unsafe_file',
    });
  });

  it('rejects a file mutated after reading but before the final handle check', async () => {
    const directory = tempDirectory();
    const path = join(directory, 'mutable.png');
    writeFileSync(path, Buffer.from('before'));

    await expect(
      readSelectedRegularFile(path, () => writeFileSync(path, Buffer.from('after!'))),
    ).rejects.toMatchObject({ reason: 'unsafe_file' });
  });

  it('never reads beyond the fixed bound when a checked file grows', async () => {
    const directory = tempDirectory();
    const path = join(directory, 'growing.png');
    writeFileSync(path, Buffer.from('small'));
    const requested: number[] = [];

    await expect(
      readSelectedRegularFile(
        path,
        () => writeFileSync(path, Buffer.alloc(IMAGE_ATTACHMENT_MAX_BYTES + 1024)),
        (byteLength) => requested.push(byteLength),
      ),
    ).rejects.toMatchObject({ reason: 'unsafe_file' });
    expect(Math.max(...requested)).toBeLessThanOrEqual(IMAGE_ATTACHMENT_MAX_BYTES);
    expect(requested.reduce((sum, byteLength) => sum + byteLength, 0)).toBe(6);
  });

  it('rejects malformed images', async () => {
    const directory = tempDirectory();
    const malformed = join(directory, 'broken.png');
    writeFileSync(malformed, Buffer.from('not an image'));
    await expect(
      new ImageAttachmentDraftStore(persistenceMock()).addFromPath('task-1', malformed),
    ).rejects.toMatchObject({ reason: 'invalid_image' });
  });

  it('rejects animated WebP and APNG input', async () => {
    const directory = tempDirectory();
    const animatedWebp = join(directory, 'animated.webp');
    writeFileSync(
      animatedWebp,
      await sharp(Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]), {
        raw: { width: 1, height: 2, channels: 4, pageHeight: 1 },
      })
        .webp({ loop: 0 })
        .toBuffer(),
    );
    const animatedPng = join(directory, 'animated.png');
    writeFileSync(animatedPng, createApng());
    const store = new ImageAttachmentDraftStore(persistenceMock());

    await expect(store.addFromPath('task-1', animatedWebp)).rejects.toMatchObject({
      reason: 'invalid_image',
    });
    await expect(store.addFromPath('task-1', animatedPng)).rejects.toMatchObject({
      reason: 'invalid_image',
    });
  });

  it('rejects dimensions beyond the bounded decoder contract', async () => {
    const directory = tempDirectory();
    const tooWide = join(directory, 'too-wide.png');
    writeFileSync(
      tooWide,
      await sharp({
        create: { width: 8193, height: 1, channels: 3, background: 'black' },
      })
        .png()
        .toBuffer(),
    );

    await expect(
      new ImageAttachmentDraftStore(persistenceMock()).addFromPath('task-1', tooWide),
    ).rejects.toMatchObject({ reason: 'invalid_image' });
  });
});

describe('clipboard drafts', () => {
  it('stores canonical bytes under a generated, displayable name', async () => {
    const persistence = persistenceMock();
    const pasted = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();

    const result = await new ImageAttachmentDraftStore(persistence).addFromClipboard(
      'task-1',
      pasted,
      clipboardAttachmentFileName(new Date('2026-08-22T13:42:10')),
    );

    expect(result).toMatchObject({
      fileName: '貼り付け画像-20260822-134210.png',
      mimeType: 'image/png',
    });
    expect(() => normalizeAttachmentFileName(result.fileName)).not.toThrow();
  });

  it('bounds a capture past the decoder pixel envelope instead of refusing it', () => {
    // 6K full-screen capture: 20.4M pixels. It encodes to well under the byte cap, so nothing else
    // in this path would look at it — it just failed to decode.
    const bounded = boundClipboardImageSize({ width: 6016, height: 3384 });
    expect(bounded).not.toBeNull();
    expect(bounded!.width * bounded!.height).toBeLessThanOrEqual(16_777_216);
    // Aspect ratio survives (within a pixel of rounding).
    expect(bounded!.width / bounded!.height).toBeCloseTo(6016 / 3384, 2);

    // A panorama grab is bounded by the per-edge limit rather than by pixel count.
    const wide = boundClipboardImageSize({ width: 20_000, height: 400 });
    expect(wide).toEqual({ width: 8192, height: 163 });

    // Anything already inside the envelope is left alone, so a normal paste is not resampled.
    expect(boundClipboardImageSize({ width: 3456, height: 2234 })).toBeNull();
    expect(boundClipboardImageSize({ width: 8, height: 8 })).toBeNull();
    expect(boundClipboardImageSize({ width: 0, height: 0 })).toBeNull();
  });

  it('accepts a 6K capture end to end once it has been bounded', async () => {
    const bounded = boundClipboardImageSize({ width: 6016, height: 3384 })!;
    // Stands in for the NativeImage resize Main performs before the PNG encode.
    const pasted = await sharp({
      create: {
        width: bounded.width,
        height: bounded.height,
        channels: 3,
        background: { r: 30, g: 30, b: 34 },
      },
    })
      .png()
      .toBuffer();

    const result = await new ImageAttachmentDraftStore(persistenceMock()).addFromClipboard(
      'task-1',
      pasted,
      clipboardAttachmentFileName(new Date('2026-08-22T13:42:10')),
    );

    expect(result).toMatchObject({ mimeType: 'image/png' });
  });

  it('leaves an image that already fits untouched', async () => {
    const bytes = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    expect(await fitClipboardImage(bytes)).toBe(bytes);
  });

  it('steps a screenshot-sized paste down until it fits the per-image cap', async () => {
    // Deterministic noise so PNG cannot compress it away — this is what pushes the encode past the
    // cap the way a full-screen Retina grab does.
    const width = 1800;
    const height = 1200;
    const noise = Buffer.alloc(width * height * 3);
    let seed = 1;
    for (let index = 0; index < noise.length; index += 1) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      noise[index] = seed >>> 24;
    }
    const oversized = await sharp(noise, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();
    expect(oversized.byteLength).toBeGreaterThan(IMAGE_ATTACHMENT_MAX_BYTES);

    const fitted = await fitClipboardImage(oversized);

    expect(fitted.byteLength).toBeLessThanOrEqual(IMAGE_ATTACHMENT_MAX_BYTES);
    const metadata = await sharp(fitted).metadata();
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBeLessThanOrEqual(2048);
  });
});

describe('draft thumbnails', () => {
  it('downscales inside the preview bound and returns base64 WebP', async () => {
    const bytes = await sharp({
      create: { width: 1200, height: 600, channels: 3, background: { r: 90, g: 90, b: 90 } },
    })
      .png()
      .toBuffer();

    const preview = await renderAttachmentPreview('attachment-1', bytes);

    expect(preview).toMatchObject({ id: 'attachment-1', mimeType: 'image/webp' });
    expect(preview.width).toBe(320);
    expect(preview.height).toBe(160);
    expect((await sharp(Buffer.from(preview.base64, 'base64')).metadata()).format).toBe('webp');
  });

  it('reports unusable stored bytes as a validation error rather than a broken image', async () => {
    await expect(
      renderAttachmentPreview('attachment-1', Buffer.from('not an image')),
    ).rejects.toThrow(ImageAttachmentValidationError);
  });
});

it('rejects unsafe image attachment display names on every platform', () => {
  expect(() => normalizeAttachmentFileName(`/tmp/bad\u202ename.png`)).toThrow(
    ImageAttachmentValidationError,
  );
});

describe.runIf(process.platform === 'win32')('ImageAttachmentDraftStore Windows reads', () => {
  it('reads a regular image through the native no-reparse boundary', async () => {
    const directory = tempDirectory();
    const path = join(directory, 'image.png');
    const bytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: 'black' },
    })
      .png()
      .toBuffer();
    writeFileSync(path, bytes);
    const persistence = persistenceMock();

    await expect(
      new ImageAttachmentDraftStore(persistence).addFromPath('task-1', path),
    ).resolves.toMatchObject({ fileName: 'image.png', mimeType: 'image/png' });
  });

  it('rejects hard links and parent-directory junctions', async () => {
    const directory = tempDirectory();
    const targetDirectory = join(directory, 'target');
    const junctionDirectory = join(directory, 'junction');
    const original = join(targetDirectory, 'image.png');
    const hardlink = join(targetDirectory, 'hardlink.png');
    const bytes = await sharp({
      create: { width: 1, height: 1, channels: 3, background: 'black' },
    })
      .png()
      .toBuffer();
    mkdirSync(targetDirectory);
    writeFileSync(original, bytes);
    linkSync(original, hardlink);
    symlinkSync(targetDirectory, junctionDirectory, 'junction');
    const store = new ImageAttachmentDraftStore(persistenceMock());

    await expect(store.addFromPath('task-1', hardlink)).rejects.toMatchObject({
      reason: 'unsafe_file',
    });
    await expect(
      store.addFromPath('task-1', join(junctionDirectory, 'image.png')),
    ).rejects.toMatchObject({ reason: 'unsafe_file' });
  });
});

function createApng(): Buffer {
  const uint32 = (value: number) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return bytes;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    return Buffer.concat([uint32(data.byteLength), body, uint32(crc32(body))]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const frameControl = (sequence: number) => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(sequence, 0);
    data.writeUInt32BE(1, 4);
    data.writeUInt32BE(1, 8);
    data.writeUInt16BE(1, 20);
    data.writeUInt16BE(10, 22);
    return data;
  };
  const first = deflateSync(Buffer.from([0, 255, 0, 0, 255]));
  const second = deflateSync(Buffer.from([0, 0, 255, 0, 255]));
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('acTL', Buffer.concat([uint32(2), uint32(0)])),
    chunk('fcTL', frameControl(0)),
    chunk('IDAT', first),
    chunk('fcTL', frameControl(1)),
    chunk('fdAT', Buffer.concat([uint32(2), second])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

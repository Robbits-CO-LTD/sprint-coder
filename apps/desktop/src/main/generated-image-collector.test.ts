import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  codexGeneratedImagesRoot,
  collectThreadImages,
  resolveThreadImageDirectory,
} from './generated-image-collector';

// Issue #11. The security argument for this module is that a generated image is located by a
// structured thread id and never by a path taken from model output — parsing the path out of the
// agent's own message ("生成済みファイル: [call_x.png](/Users/…)") would be an arbitrary-file-read
// primitive driven by attacker-influenceable text. These tests pin that boundary down.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const dirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sprint-coder-genimg-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('codexGeneratedImagesRoot', () => {
  it('honours CODEX_HOME, matching how the model catalog is located', () => {
    expect(codexGeneratedImagesRoot({ CODEX_HOME: '/custom/codex' })).toBe(
      join('/custom/codex', 'generated_images'),
    );
  });

  it('falls back to ~/.codex', () => {
    expect(codexGeneratedImagesRoot({ HOME: '/home/u' })).toBe(
      join('/home/u', '.codex', 'generated_images'),
    );
  });
});

describe('resolveThreadImageDirectory', () => {
  it('resolves a thread id under the root', () => {
    const root = resolve('generated-images-root');
    expect(resolveThreadImageDirectory('019f976e-45b1-7a60-bd4d-14374e766d9a', root)).toBe(
      join(root, '019f976e-45b1-7a60-bd4d-14374e766d9a'),
    );
  });

  it('refuses anything that would escape the root', () => {
    // The runtime protocol already constrains the id to a UUID shape, but a value interpolated into
    // a filesystem path deserves the containment check at the point of use as well.
    for (const hostile of [
      '..',
      '../..',
      '../../etc',
      'a/../../b',
      '/etc/passwd',
      '/absolute',
      '',
    ]) {
      expect(
        resolveThreadImageDirectory(hostile, resolve('generated-images-root')),
        hostile,
      ).toBeNull();
    }
  });
});

describe('collectThreadImages', () => {
  it('reads the PNGs the CLI wrote for that thread', () => {
    const root = tempRoot();
    const thread = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mkdirSync(join(root, thread));
    writeFileSync(join(root, thread, 'call_b.png'), PNG);
    writeFileSync(join(root, thread, 'call_a.png'), PNG);

    const collected = collectThreadImages(thread, root);
    // Sorted, so the order is stable across filesystems rather than readdir-dependent.
    expect(collected.map(({ fileName }) => fileName)).toEqual(['call_a.png', 'call_b.png']);
    expect(collected[0]?.bytes.equals(PNG)).toBe(true);
  });

  it('returns nothing when the thread generated no images', () => {
    // The common case: most turns never call the image tool, and a missing directory is not an error.
    expect(collectThreadImages('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', tempRoot())).toEqual([]);
  });

  it('ignores non-PNG files in the directory', () => {
    const root = tempRoot();
    const thread = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mkdirSync(join(root, thread));
    writeFileSync(join(root, thread, 'notes.txt'), 'not an image');
    writeFileSync(join(root, thread, 'call.png'), PNG);
    expect(collectThreadImages(thread, root).map(({ fileName }) => fileName)).toEqual(['call.png']);
  });

  it('ignores a directory that merely looks like a PNG', () => {
    const root = tempRoot();
    const thread = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mkdirSync(join(root, thread));
    mkdirSync(join(root, thread, 'trap.png'));
    expect(collectThreadImages(thread, root)).toEqual([]);
  });

  it('never follows a traversing thread id out of the root', () => {
    const root = tempRoot();
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.png'), PNG);
    // Even if a malformed id somehow reached this layer, it cannot reach a sibling directory.
    expect(collectThreadImages('../outside', root)).toEqual([]);
    expect(collectThreadImages(join(outside), root)).toEqual([]);
  });

  it('refuses a symlink that points outside the thread directory', () => {
    const root = tempRoot();
    const thread = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mkdirSync(join(root, thread));
    const secretDir = join(root, 'secrets');
    mkdirSync(secretDir);
    writeFileSync(join(secretDir, 'key'), 'not a png but sensitive');
    symlinkSync(join(secretDir, 'key'), join(root, thread, 'leak.png'));
    // The bytes would fail the PNG magic check downstream anyway, but refusing to open anything that
    // is not a plain file means that check is not the only thing standing in the way.
    const collected = collectThreadImages(thread, root);
    expect(collected.map(({ fileName }) => fileName)).not.toContain('leak.png');
  });

  it('caps how many images one turn can contribute', () => {
    const root = tempRoot();
    const thread = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mkdirSync(join(root, thread));
    for (let i = 0; i < 20; i += 1)
      writeFileSync(join(root, thread, `call_${String(i).padStart(2, '0')}.png`), PNG);
    expect(collectThreadImages(thread, root).length).toBeLessThanOrEqual(8);
  });
});

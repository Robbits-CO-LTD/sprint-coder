import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  verifyWindowsSandboxArchive,
  verifyWindowsSandboxArtifacts,
} from './windows-sandbox-artifacts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const runner = 'resources/sprint-coder-sandbox-runner.exe';
const seal = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

// Minimal stored ZIP writer keeps the archive-boundary tests independent of OS zip tools.
function fixture(entries: ReadonlyArray<readonly [string, string]>, extension = '.zip'): string {
  const root = mkdtempSync(join(tmpdir(), 'sandbox-artifact-'));
  roots.push(root);
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [path, text] of entries) {
    const name = Buffer.from(path);
    const data = Buffer.from(text);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(Buffer.concat(directory).length, 12);
  end.writeUInt32LE(offset, 16);
  const path = join(root, `fixture${extension}`);
  writeFileSync(path, Buffer.concat([...locals, ...directory, end]));
  return path;
}

describe('Windows final sandbox artifact seals', () => {
  it.each(['', 'lib/net45/'])(
    'accepts final signed-byte seals at archive prefix %s',
    async (prefix) => {
      const path = fixture([
        [prefix + runner, 'signed-helper'],
        [prefix + runner + '.sha256', seal('signed-helper') + '\n'],
      ]);
      await expect(verifyWindowsSandboxArchive(path)).resolves.toBe(seal('signed-helper'));
    },
  );
  it.each([
    [
      [runner, 'signed-helper'],
      [runner + '.sha256', seal('unsigned-helper')],
    ],
    [[runner, 'signed-helper']],
    [
      [runner, 'signed-helper'],
      [runner + '.sha256', 'invalid'],
    ],
    [
      [runner, 'signed-helper'],
      ['other/' + runner + '.sha256', seal('signed-helper')],
    ],
    [
      [runner, 'signed-helper'],
      [runner, 'duplicate'],
      [runner + '.sha256', seal('signed-helper')],
    ],
  ] as const)(
    'fails closed on stale, missing, malformed, misplaced or duplicate entries',
    async (...entries) => {
      await expect(verifyWindowsSandboxArchive(fixture(entries))).rejects.toThrow(
        'digest verification failed',
      );
    },
  );
  it('requires portable ZIP and full nupkg to contain the same sealed helper bytes', async () => {
    const zip = fixture([
      [runner, 'one'],
      [runner + '.sha256', seal('one')],
    ]);
    const nupkg = fixture(
      [
        ['lib/net45/' + runner, 'two'],
        ['lib/net45/' + runner + '.sha256', seal('two')],
      ],
      '-full.nupkg',
    );
    await expect(
      verifyWindowsSandboxArtifacts([
        { platform: 'win32', arch: 'x64', packageJSON: {}, artifacts: [zip, nupkg] },
      ]),
    ).rejects.toThrow('bytes differ');
  });
  it('does not apply Windows validation to other platforms or delta/installer containers', async () => {
    await expect(
      verifyWindowsSandboxArtifacts([
        { platform: 'linux', arch: 'x64', packageJSON: {}, artifacts: ['missing.zip'] },
        {
          platform: 'win32',
          arch: 'x64',
          packageJSON: {},
          artifacts: ['missing-delta.nupkg', 'Setup.exe'],
        },
      ]),
    ).resolves.toBeUndefined();
  });
});

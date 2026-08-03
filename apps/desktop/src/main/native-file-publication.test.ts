import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { replaceWindowsFileWithBackup } from './native-file-publication';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('replaceWindowsFileWithBackup', () => {
  it.runIf(process.platform === 'win32')(
    'rejects a replacement outside the target directory before publication',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'sprint-coder-publication-'));
      cleanup.push(root);
      const first = join(root, 'first');
      const second = join(root, 'second');
      await mkdir(first);
      await mkdir(second);
      const replacement = join(first, 'replacement.txt');
      const target = join(second, 'target.txt');
      await writeFile(replacement, 'replacement');
      await writeFile(target, 'target');

      expect(() =>
        replaceWindowsFileWithBackup(replacement, target, join(second, 'backup.txt')),
      ).toThrow('must share a parent directory');
    },
  );
});

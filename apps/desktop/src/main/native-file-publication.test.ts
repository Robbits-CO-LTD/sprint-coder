import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { replaceWindowsFileWithBackup } from './native-file-publication';
import { openWorkspaceFileForEdit, saveWorkspaceFile } from './workspace-edit';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('replaceWindowsFileWithBackup', () => {
  it.runIf(process.platform === 'win32')(
    'publishes a valid 255-character component beyond the Win32 full-path limit',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'sprint-coder-long-publication-'));
      cleanup.push(root);
      const target = join(root, 'x'.repeat(255));
      const replacement = join(root, '.stage.tmp');
      const backup = join(root, '.backup.tmp');
      expect(target.length).toBeGreaterThan(260);
      await writeFile(target, 'before');
      await writeFile(replacement, 'after');
      replaceWindowsFileWithBackup(replacement, target, backup);
      expect(await readFile(target, 'utf8')).toBe('after');
      expect(await readFile(backup, 'utf8')).toBe('before');
    },
  );

  it.runIf(process.platform === 'win32')(
    'saves an editable Workspace file with a long parent path through the actual native boundary',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'sprint-coder-long-editor-'));
      cleanup.push(root);
      const relativePath = [...Array<string>(7).fill('x'.repeat(32)), 'note.txt'].join('/');
      await mkdir(join(root, ...Array<string>(7).fill('x'.repeat(32))), { recursive: true });
      await writeFile(join(root, relativePath), 'before');
      expect(join(root, relativePath).length).toBeGreaterThan(260);
      const opened = openWorkspaceFileForEdit(root, relativePath);
      expect(opened.editable).toBe(true);
      const outcome = saveWorkspaceFile(root, relativePath, 'after', opened.digest);
      expect(outcome.outcome).toBe('saved');
      expect(await readFile(join(root, relativePath), 'utf8')).toBe('after');
    },
  );

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

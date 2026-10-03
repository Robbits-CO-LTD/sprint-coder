import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { replaceWindowsFileWithBackup } from './native-file-publication';
import { openWorkspaceFileForEdit, saveWorkspaceFile } from './workspace-edit';

const cleanup: string[] = [];

function loopbackUncOf(path: string): string {
  const { root } = parse(path);
  return ['', '', 'localhost', `${root.slice(0, 1)}$`, path.slice(root.length)].join('\\');
}

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
    'keeps refusing a replacement from another directory when the full path is long',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'sprint-coder-long-guard-'));
      cleanup.push(root);
      const first = join(root, 'f'.repeat(200));
      const second = join(root, 's'.repeat(200));
      await mkdir(first);
      await mkdir(second);
      const replacement = join(first, 'replacement.txt');
      const target = join(second, 'target.txt');
      await writeFile(replacement, 'replacement');
      await writeFile(target, 'target');
      expect(target.length).toBeGreaterThan(260);
      expect(() =>
        replaceWindowsFileWithBackup(replacement, target, join(second, 'backup.txt')),
      ).toThrow('must share a parent directory');
      expect(await readFile(target, 'utf8')).toBe('target');
    },
  );

  it.runIf(process.platform === 'win32')(
    'publishes Unicode names beyond the Win32 full-path limit',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'sprint-coder-long-unicode-'));
      cleanup.push(root);
      const parent = join(root, ...Array<string>(45).fill('日本語🎉'));
      await mkdir(parent, { recursive: true });
      const target = join(parent, '日本語🎉.txt');
      expect(target.length).toBeGreaterThan(260);
      await writeFile(target, 'before');
      await writeFile(join(parent, '.stage.tmp'), 'after');
      replaceWindowsFileWithBackup(join(parent, '.stage.tmp'), target, join(parent, '.backup.tmp'));
      expect(await readFile(target, 'utf8')).toBe('after');
      expect(await readFile(join(parent, '.backup.tmp'), 'utf8')).toBe('before');
    },
  );

  it.runIf(process.platform === 'win32')(
    'accepts a drive-relative spelling by resolving it against the current directory',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'sprint-coder-relative-'));
      cleanup.push(root);
      await writeFile(join(root, 'target.txt'), 'before');
      await writeFile(join(root, 'stage.tmp'), 'after');
      const previous = process.cwd();
      process.chdir(root);
      try {
        replaceWindowsFileWithBackup('stage.tmp', 'target.txt', 'backup.tmp');
      } finally {
        process.chdir(previous);
      }
      expect(await readFile(join(root, 'target.txt'), 'utf8')).toBe('after');
      expect(await readFile(join(root, 'backup.tmp'), 'utf8')).toBe('before');
    },
  );

  // A UNC spelling reaches the native call as \?\UNC\...; the loopback administrative share is
  // the only UNC path an unattended run can rely on. A machine without it records this as skipped.
  it.runIf(process.platform === 'win32' && existsSync(loopbackUncOf(tmpdir())))(
    'publishes through a UNC share spelling with a long full path',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'sprint-coder-unc-'));
      cleanup.push(root);
      const unc = join(loopbackUncOf(root), 'p'.repeat(120), 'q'.repeat(120));
      await mkdir(unc, { recursive: true });
      const target = join(unc, 'target.txt');
      expect(target.length).toBeGreaterThan(260);
      await writeFile(target, 'before');
      await writeFile(join(unc, 'stage.tmp'), 'after');
      replaceWindowsFileWithBackup(join(unc, 'stage.tmp'), target, join(unc, 'backup.tmp'));
      expect(await readFile(target, 'utf8')).toBe('after');
      expect(await readFile(join(unc, 'backup.tmp'), 'utf8')).toBe('before');
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

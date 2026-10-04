import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { replaceWindowsFileWithBackup } from './native-file-publication';
import { openWorkspaceFileForEdit, saveWorkspaceFile } from './workspace-edit';

const cleanup: string[] = [];

// Resolve System32 tools explicitly: a Git for Windows PATH can shadow whoami with a POSIX one.
function system32(name: string): string {
  return join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', name);
}

// An elevated token creates Administrators-owned files, so give the user ownership first. A
// standard token already owns them and may itself lack WRITE_OWNER (#737), so a refused rewrite
// of the same owner is expected there.
function ownAsCurrentUser(path: string, sid: string): void {
  try {
    execFileSync(system32('icacls.exe'), [path, '/setowner', `*${sid}`], { stdio: 'ignore' });
  } catch {
    // Already owned by the standard user.
  }
}

function loopbackUncOf(path: string): string {
  const { root } = parse(path);
  return ['', '', 'localhost', `${root.slice(0, 1)}$`, path.slice(root.length)].join('\\');
}

function currentUserSid(): string {
  const [, sid] = execFileSync(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
  })
    .trim()
    .split('","');
  if (!sid?.startsWith('S-1-')) throw new Error('current user SID unavailable');
  return sid.replace(/"$/, '');
}

// Issue #737: an owner holds READ_CONTROL and WRITE_DAC implicitly but not WRITE_OWNER. Owning a
// file and being denied WRITE_OWNER reproduces a drive-root default ACL on either token: an
// elevated run gets the owner back first, then neither the user nor Administrators may rewrite it.
function ownWithoutWriteOwner(path: string, sid: string): void {
  ownAsCurrentUser(path, sid);
  execFileSync(system32('icacls.exe'), [path, '/deny', `*${sid}:(WO)`, '*S-1-5-32-544:(WO)'], {
    stdio: 'ignore',
  });
}

// The drive-root default of an added NTFS volume: Administrators and SYSTEM full control,
// Authenticated Users Modify (no WRITE_DAC or WRITE_OWNER) and Users read, all inherited.
function applyDriveRootDefaultAcl(directory: string, sid: string): void {
  ownAsCurrentUser(directory, sid);
  execFileSync(
    system32('icacls.exe'),
    [
      directory,
      '/inheritance:r',
      '/grant:r',
      '*S-1-5-32-544:(OI)(CI)F',
      '*S-1-5-18:(OI)(CI)F',
      '*S-1-5-11:(OI)(CI)M',
      '*S-1-5-32-545:(OI)(CI)RX',
    ],
    { stdio: 'ignore' },
  );
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('replaceWindowsFileWithBackup', () => {
  it.runIf(process.platform === 'win32')(
    'publishes when the caller owns the target but lacks WRITE_OWNER (issue #737)',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'sprint-coder-no-write-owner-'));
      cleanup.push(root);
      const sid = currentUserSid();
      const target = join(root, 'target.txt');
      const replacement = join(root, '.stage.tmp');
      const backup = join(root, '.backup.tmp');
      await writeFile(target, 'before');
      await writeFile(replacement, 'after');
      ownWithoutWriteOwner(target, sid);
      ownWithoutWriteOwner(replacement, sid);
      replaceWindowsFileWithBackup(replacement, target, backup);
      expect(await readFile(target, 'utf8')).toBe('after');
      expect(await readFile(backup, 'utf8')).toBe('before');
    },
  );

  // A standard token reproduces #737 here. An elevated token creates Administrators-owned files that
  // the inherited Administrators entry lets it rewrite, so the WRITE_OWNER test above is the one
  // that catches a regression on either token.
  it.runIf(process.platform === 'win32')(
    'saves a Workspace file under a drive-root default ACL (issue #737)',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'sprint-coder-default-acl-'));
      cleanup.push(root);
      applyDriveRootDefaultAcl(root, currentUserSid());
      await writeFile(join(root, 'note.txt'), 'before');
      const opened = openWorkspaceFileForEdit(root, 'note.txt');
      expect(opened.editable).toBe(true);
      const outcome = saveWorkspaceFile(root, 'note.txt', 'after', opened.digest);
      expect(outcome.outcome).toBe('saved');
      expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('after');
    },
  );

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
      // Derive the component length from the actual root so a short TEMP cannot shrink the path.
      const pad = Math.min(255, Math.max(200, 262 - root.length - 12));
      const first = join(root, 'f'.repeat(pad));
      const second = join(root, 's'.repeat(pad));
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
    'accepts a plain relative spelling by resolving it against the current directory',
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

  it.runIf(process.platform === 'win32')(
    'accepts a drive-relative spelling by resolving it against that drive current directory',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'sprint-coder-drive-relative-'));
      cleanup.push(root);
      await writeFile(join(root, 'target.txt'), 'before');
      await writeFile(join(root, 'stage.tmp'), 'after');
      const drive = root.slice(0, 2);
      const previous = process.cwd();
      process.chdir(root);
      try {
        replaceWindowsFileWithBackup(
          `${drive}stage.tmp`,
          `${drive}target.txt`,
          `${drive}backup.tmp`,
        );
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
      const share = loopbackUncOf(root);
      const pad = Math.min(255, Math.max(120, Math.ceil((262 - share.length - 12) / 2)));
      const unc = join(share, 'p'.repeat(pad), 'q'.repeat(pad));
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

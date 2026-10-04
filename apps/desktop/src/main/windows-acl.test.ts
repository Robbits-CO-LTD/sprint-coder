import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  secureWindowsPath,
  secureWindowsPaths,
  verifyWindowsPathAcl,
  verifyWindowsPaths,
  type WindowsAclPath,
} from './windows-acl';

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

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Windows ACL runner', () => {
  // Issue #737: securing must not need WRITE_OWNER on a path the user already owns. Denying it to
  // the user and Administrators after giving the user ownership reproduces a drive-root default
  // ACL on either token.
  it.runIf(process.platform === 'win32')(
    'secures a current-user-owned path that denies WRITE_OWNER (issue #737)',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'sprint-coder-acl-no-write-owner-'));
      cleanup.push(root);
      const [, quotedSid] = execFileSync(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
        encoding: 'utf8',
      })
        .trim()
        .split('","');
      const sid = quotedSid?.replace(/"$/, '') ?? '';
      expect(sid.startsWith('S-1-')).toBe(true);
      const file = join(root, 'private.txt');
      const directory = join(root, 'private-dir');
      await writeFile(file, 'private');
      await mkdir(directory);
      for (const path of [file, directory]) {
        ownAsCurrentUser(path, sid);
        execFileSync(
          system32('icacls.exe'),
          [path, '/deny', `*${sid}:(WO)`, '*S-1-5-32-544:(WO)'],
          {
            stdio: 'ignore',
          },
        );
      }

      await secureWindowsPath(file, 'file');
      await secureWindowsPath(directory, 'directory');
      await verifyWindowsPathAcl(file, 'file');
      await verifyWindowsPathAcl(directory, 'directory');
    },
  );

  it.runIf(process.platform === 'win32')(
    'secures an ACL list larger than the Windows process-environment limit',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'sprint-coder-acl-large-'));
      cleanup.push(root);
      const items: WindowsAclPath[] = [];
      for (let index = 0; index < 256; index += 1) {
        const path = join(
          root,
          `${index.toString().padStart(3, '0')}-${'long-name-'.repeat(10)}.txt`,
        );
        await writeFile(path, 'private');
        items.push({ path, kind: 'file' });
      }

      const encoded = Buffer.from(JSON.stringify(items), 'utf8').toString('base64');
      expect(encoded.length).toBeGreaterThan(32_767);

      await secureWindowsPaths(items);
      await verifyWindowsPaths(items);
    },
  );

  it.runIf(process.platform === 'win32')(
    'handles parallel ACL callers through the native Windows implementation',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'sprint-coder-acl-parallel-'));
      cleanup.push(root);
      const paths = await Promise.all(
        Array.from({ length: 32 }, async (_, index) => {
          const path = join(root, `${index}.txt`);
          await writeFile(path, 'private');
          return path;
        }),
      );

      await Promise.all(paths.map((path) => secureWindowsPath(path, 'file')));
      await Promise.all(paths.map((path) => verifyWindowsPathAcl(path, 'file')));
    },
  );

  it.runIf(process.platform === 'win32')(
    'isolates a failing coalesced request from an unrelated valid request',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'sprint-coder-acl-isolation-'));
      cleanup.push(root);
      const valid = join(root, 'valid.txt');
      await writeFile(valid, 'private');

      const [validResult, missingResult] = await Promise.allSettled([
        secureWindowsPath(valid, 'file'),
        secureWindowsPath(join(root, 'missing.txt'), 'file'),
      ]);

      expect(validResult.status).toBe('fulfilled');
      expect(missingResult.status).toBe('rejected');
      await verifyWindowsPathAcl(valid, 'file');
    },
  );
});

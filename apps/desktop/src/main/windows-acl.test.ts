import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Windows ACL runner', () => {
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

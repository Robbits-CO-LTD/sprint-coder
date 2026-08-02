import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  secureWindowsPaths,
  verifyWindowsPaths,
  WINDOWS_ACL_TIMEOUT_MS,
  type WindowsAclPath,
} from './windows-acl';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Windows ACL runner', () => {
  it('keeps its subprocess deadline below the integration-test timeout', () => {
    expect(WINDOWS_ACL_TIMEOUT_MS).toBeGreaterThan(10_000);
    expect(WINDOWS_ACL_TIMEOUT_MS).toBeLessThan(20_000);
  });

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
});

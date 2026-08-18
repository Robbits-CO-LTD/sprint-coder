import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeSandboxRunner, verifySandboxRunnerDigest } from './sandbox-runner';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('sandbox runner boundary', () => {
  it('fails closed when the helper or digest manifest is unavailable', async () => {
    await expect(probeSandboxRunner('/does/not/exist')).resolves.toMatchObject({
      available: false,
    });
  });

  it.runIf(process.platform === 'win32')(
    'passes the Windows AppContainer probe or reports a typed fail-closed reason',
    async () => {
      const capability = await probeSandboxRunner();
      if (capability.available)
        expect(capability).toEqual({
          available: true,
          backend: 'windows-appcontainer',
          reason: null,
        });
      else {
        expect(capability.backend).toBe('windows-appcontainer');
        expect(capability.reason).toMatch(/^appcontainer_[a-z0-9_]+$/u);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a helper whose bytes changed after sealing',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'sprint-coder-sandbox-runner-'));
      roots.push(root);
      const executable = join(root, 'runner');
      copyFileSync(process.execPath, executable);
      chmodSync(executable, 0o700);
      writeFileSync(`${executable}.sha256`, '0'.repeat(64));
      expect(() => verifySandboxRunnerDigest(executable)).toThrow('digest mismatch');
    },
  );
});

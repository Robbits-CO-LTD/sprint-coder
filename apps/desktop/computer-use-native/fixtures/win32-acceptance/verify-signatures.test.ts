import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'win32')(
  'rejects incomplete Windows signature preflight evidence',
  () => {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', resolve(__dirname, 'verify-signatures.test.ps1')],
      { encoding: 'utf8', windowsHide: true, timeout: 20_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('19 passed; interactive acceptance NOT_RUN');
  },
);

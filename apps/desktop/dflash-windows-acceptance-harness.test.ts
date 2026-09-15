import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('runs the eight DFlash harness guard units in the normal desktop suite', () => {
  expect(process.versions.node.split('.')[0]).toBe('22');
  // Select only the fixture unit file: never discover/import the opt-in GUI runners.
  const unitFile = fileURLToPath(
    new URL('../../tests/e2e/manual/dflash-windows-guard.test.cjs', import.meta.url),
  );
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', unitFile], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toMatch(/^# tests 8\r?$/m);
  expect(result.stdout).toMatch(/^# pass 8\r?$/m);
  expect(result.stdout).toMatch(/^# fail 0\r?$/m);
  expect(result.stdout).toMatch(/^# skipped 0\r?$/m);
});

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import {
  electronCacheMetadata,
  electronInstallFailure,
  installElectron,
} from '../../ci-install-electron.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const roots = [];
const action = parse(
  readFileSync(join(repository, '.github/actions/install-electron/action.yml'), 'utf8'),
);

function fixture(outcomes = []) {
  const root = mkdtempSync(join(tmpdir(), 'ci-electron-'));
  roots.push(root);
  mkdirSync(join(root, 'node_modules/electron'), { recursive: true });
  mkdirSync(join(root, 'node_modules/@electron'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(
    join(root, 'node_modules/electron/package.json'),
    JSON.stringify({ version: '43.5.0' }),
  );
  writeFileSync(join(root, 'node_modules/electron/checksums.json'), '{"archive.zip":"verified"}');
  symlinkSync(
    dirname(require.resolve('@electron/get/package.json')),
    join(root, 'node_modules/@electron/get'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  writeFileSync(join(root, 'outcomes.json'), JSON.stringify(outcomes));
  writeFileSync(
    join(root, 'node_modules/electron/install.js'),
    `
const {readFileSync, writeFileSync, existsSync} = require('node:fs');
const count = existsSync('attempts') ? Number(readFileSync('attempts', 'utf8')) : 0;
writeFileSync('attempts', String(count + 1));
const outcome = JSON.parse(readFileSync('outcomes.json', 'utf8'))[count];
if (outcome) {
  console.error(outcome.message);
  process.exitCode = outcome.exitCode || 1;
}
`,
  );
  return root;
}

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('Electron download retries', () => {
  it('recovers from HTTP and network failures with bounded exponential delays', async () => {
    const root = fixture([
      { message: 'HTTPError: Response code 500 (Internal Server Error)' },
      { message: 'RequestError: read ECONNRESET' },
    ]);
    const wait = vi.fn();
    const report = vi.fn();
    expect(await installElectron({ root, wait, report })).toBe(0);
    expect(readFileSync(join(root, 'attempts'), 'utf8')).toBe('3');
    expect(wait.mock.calls).toEqual([[2_000], [4_000]]);
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('stops after three failures and propagates the installer exit status', async () => {
    const root = fixture(
      Array.from({ length: 3 }, () => ({
        message: 'HTTPError: Response code 429 (Too Many Requests)',
        exitCode: 7,
      })),
    );
    const wait = vi.fn();
    expect(await installElectron({ root, wait, report: vi.fn() })).toBe(7);
    expect(readFileSync(join(root, 'attempts'), 'utf8')).toBe('3');
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it.each([
    'HTTPError: Response code 404 (Not Found) for https://example.invalid/private',
    'Error: Generated checksum for archive.zip did not match expected checksum.',
    'Error: end of central directory record signature not found',
    'Error: EACCES: permission denied, open archive.zip',
    'RequestError: certificate has expired',
    'RequestError: getaddrinfo ENOTFOUND example.invalid',
    'Error: unknown error\nHTTPError: Response code 500 (Internal Server Error)',
  ])('does not retry permanent or unknown failures: %s', async (message) => {
    const root = fixture([{ message, exitCode: 9 }]);
    const wait = vi.fn();
    const report = vi.fn();
    expect(await installElectron({ root, wait, report })).toBe(9);
    expect(readFileSync(join(root, 'attempts'), 'utf8')).toBe('1');
    expect(wait).not.toHaveBeenCalled();
    expect(report.mock.calls.flat().join('\n')).not.toContain(message);
  });

  it.each([
    'HTTPError: Response code 503 (Service Unavailable)',
    'RequestError: getaddrinfo EAI_AGAIN example.invalid',
    'RequestError: connect ETIMEDOUT',
    "TimeoutError: Timeout awaiting 'request' for 1000ms",
  ])('recognizes only supported transient failure headers: %s', (stderr) => {
    expect(electronInstallFailure({ status: 1, stderr }).retry).toBe(true);
  });

  it.each([
    { signal: 'SIGTERM', status: null },
    { error: new Error('spawn failed'), status: null },
  ])('fails without retrying a child signal or spawn error', async (result) => {
    const root = fixture();
    const run = vi.fn(() => ({
      ...result,
      stderr: 'HTTPError: Response code 500 (Internal Server Error)',
    }));
    const wait = vi.fn();
    expect(await installElectron({ root, run, wait, report: vi.fn() })).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('returns a nonzero CLI exit without disclosing installer URLs or credentials', () => {
    const secret = 'https://user:password@example.invalid/mirror';
    const root = fixture([
      { message: `HTTPError: Response code 403 (Forbidden) for ${secret}`, exitCode: 7 },
    ]);
    const result = spawnSync(process.execPath, [join(repository, 'ci-install-electron.mjs')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(result.status).toBe(7);
    expect(result.stderr).toContain('HTTP-403');
    expect(result.stdout + result.stderr).not.toContain(secret);
  });
});

describe('Electron download archive cache', () => {
  it('uses the same default cache as Forge and separates version, platform, architecture and checksums', () => {
    const root = fixture();
    const getRequire = createRequire(require.resolve('@electron/get/package.json'));
    const metadata = electronCacheMetadata(root, {
      ELECTRON_INSTALL_PLATFORM: 'linux',
      ELECTRON_INSTALL_ARCH: 'x64',
    });
    expect(metadata.path).toBe(getRequire('env-paths')('electron', { suffix: '' }).cache);
    expect(metadata.key).toMatch(/^electron-download-v1-43\.5\.0-linux-x64-[a-f0-9]{64}$/u);
    expect(
      electronCacheMetadata(root, { npm_config_platform: 'win32', npm_config_arch: 'x64' }).key,
    ).not.toBe(metadata.key);
    expect(
      electronCacheMetadata(root, {
        ELECTRON_INSTALL_PLATFORM: 'linux',
        ELECTRON_INSTALL_ARCH: 'arm64',
      }).key,
    ).not.toBe(metadata.key);
    writeFileSync(join(root, 'node_modules/electron/checksums.json'), '{"archive.zip":"changed"}');
    expect(
      electronCacheMetadata(root, {
        ELECTRON_INSTALL_PLATFORM: 'linux',
        ELECTRON_INSTALL_ARCH: 'x64',
      }).key,
    ).not.toBe(metadata.key);
    const other = fixture();
    writeFileSync(join(other, 'node_modules/electron/package.json'), '{"version":"43.6.0"}');
    expect(
      electronCacheMetadata(other, {
        ELECTRON_INSTALL_PLATFORM: 'linux',
        ELECTRON_INSTALL_ARCH: 'x64',
      }).key,
    ).not.toBe(metadata.key);
  });

  it('restores only exact ZIP-cache matches and always runs the verified installer', () => {
    const restore = action.runs.steps.find((step) => step.uses?.startsWith('actions/cache@'));
    expect(restore.with).toEqual({
      path: '${{ steps.electron.outputs.path }}',
      key: '${{ steps.electron.outputs.key }}',
    });
    const install = action.runs.steps.at(-1);
    expect(install.if).toBeUndefined();
    expect(install.env).toEqual({ electron_config_cache: '${{ steps.electron.outputs.path }}' });
    expect(install.run).toBe('node ci-install-electron.mjs');
  });

  it('uses the shared action for release validation, both release makers and acceptance packaging', () => {
    for (const [file, jobs] of [
      ['release-beta.yml', ['validate-desktop-tests', 'make', 'make-windows-signed']],
      ['computer-use-acceptance-build.yml', ['acceptance-build']],
    ]) {
      const workflow = parse(readFileSync(join(repository, '.github/workflows', file), 'utf8'));
      for (const job of jobs) {
        const steps = workflow.jobs[job].steps;
        const install = steps.findIndex(
          (step) => step.uses === './.github/actions/install-electron',
        );
        expect(install).toBeGreaterThan(steps.findIndex((step) => step.run === 'npm ci'));
        expect(steps.some((step) => step.run?.includes('node_modules/electron/install.js'))).toBe(
          false,
        );
      }
    }
  });
});

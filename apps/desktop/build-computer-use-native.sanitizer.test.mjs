import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sanitizedNativeBuildEnvironment } from '../../native-build-environment.mjs';

const desktopDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(desktopDirectory, '..', '..');
const buildScript = resolve(repositoryDirectory, 'build-computer-use-native.mjs');

describe('Computer Use native build environment sanitizer', () => {
  it('runs the controlled SQLite child-boundary regressions without ambient secrets', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-vm-modules',
        '--test',
        resolve(repositoryDirectory, 'build-better-sqlite3.boundary.test.mjs'),
      ],
      {
        cwd: repositoryDirectory,
        env: sanitizedNativeBuildEnvironment(process.env),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      },
    );
    expect(result.status, 'Controlled SQLite child-boundary regressions failed').toBe(0);
  });
  it('keeps the compiler environment but rejects ambient npm build controls and secrets', () => {
    const output = execFileSync(process.execPath, [buildScript, '--test-environment-sanitizer'], {
      cwd: repositoryDirectory,
      env: sanitizedNativeBuildEnvironment(process.env),
      encoding: 'utf8',
    });

    expect(output).toContain('Computer Use native build environment sanitizer: PASS');
  });

  it('keeps the sanitizer attached to every native build child process', () => {
    const source = readFileSync(buildScript, 'utf8');

    expect(source).toContain('env: sanitizedNativeBuildEnvironment(environment)');
    expect(source).not.toContain('npm_config_(?:arch|target_arch|runtime|target|dist_url');
    const policy = readFileSync(
      resolve(repositoryDirectory, 'native-build-environment.mjs'),
      'utf8',
    );
    expect(policy).toContain("npm_config_loglevel: 'error'");
    expect(source).toContain("from './native-build-environment.mjs'");
  });

  it('summarizes build child failures with the errno instead of inventing an exit code', () => {
    const source = readFileSync(buildScript, 'utf8');

    // result.error means the child never ran (ENOENT) or was killed, so it has no exit code at
    // all. Reporting "exit 1" stated something untrue and dropped the errno that separates a
    // missing compiler from a real compile failure.
    expect(source).not.toContain('exit ${result.error ? 1 : (result.status ?? 1)}');
    expect(source).toContain('nativeBuildFailureDetail(result)');
    // The build child's output is never read, so it is discarded at the file descriptor; capturing
    // nothing also means no maxBuffer ceiling can abort a noisy but healthy compile with ENOBUFS.
    expect(source).toContain("stdio: ['ignore', 'ignore', 'ignore']");
    expect(source).not.toContain('maxBuffer:');
  });
});

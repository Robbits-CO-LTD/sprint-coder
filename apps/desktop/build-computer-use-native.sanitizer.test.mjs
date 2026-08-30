import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const desktopDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(desktopDirectory, '..', '..');
const buildScript = resolve(repositoryDirectory, 'build-computer-use-native.mjs');

describe('Computer Use native build environment sanitizer', () => {
  it('keeps the compiler environment but rejects ambient npm build controls and secrets', () => {
    const output = execFileSync(process.execPath, [buildScript, '--test-environment-sanitizer'], {
      cwd: repositoryDirectory,
      encoding: 'utf8',
    });

    expect(output).toContain('Computer Use native build environment sanitizer: PASS');
  });

  it('keeps the sanitizer attached to every native build child process', () => {
    const source = readFileSync(buildScript, 'utf8');

    expect(source).toContain('env: sanitizedNativeBuildEnvironment(environment)');
    expect(source).not.toContain('npm_config_(?:arch|target_arch|runtime|target|dist_url');
    expect(source).toContain("npm_config_loglevel: 'error'");
  });
});

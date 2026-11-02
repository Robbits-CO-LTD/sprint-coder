import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../verify-computer-use-test-hang-absent.mjs';

const marker = 'SPRINT_CODER_COMPUTER_USE_TEST_HANG_MARKER';
const helper = 'sprint-coder-computer-use-host.exe';
const manifest = 'computer-use-native.manifest.json';
let directory;
let errors;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'computer-use-test-hang-'));
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((message) => errors.push(String(message)));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});
function artifact(dir, bytes = Buffer.from('synthetic helper'), overrides = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, helper), bytes);
  writeFileSync(
    join(dir, manifest),
    JSON.stringify({
      platform: 'win32',
      binaryDigest: createHash('sha256').update(bytes).digest('hex'),
      ...overrides,
    }),
  );
}
const run = (...args) => main([`--dir=${directory}`, ...args], 'win32');

describe('test-hang artifact exclusion', () => {
  it('runs the CLI entry point and fails for a missing required directory', () => {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../../verify-computer-use-test-hang-absent.mjs', import.meta.url)),
        '--require',
        `--dir=${join(directory, 'missing')}`,
      ],
      { encoding: 'utf8' },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[verify-test-hang] FAIL:');
  });
  it('rejects the UTF-16LE sidecar signature without the exported marker', () => {
    const bytes = Buffer.from('sprint-coder-test-hang.txt', 'utf16le');
    artifact(directory, bytes);
    expect(run('--require')).toBe(1);
    expect(errors.join('\n')).toContain('test-hang marker');
    artifact(directory);
    const out = join(directory, 'out');
    artifact(join(out, 'app', 'resources'), bytes);
    expect(run('--require', `--out=${out}`)).toBe(1);
  });
  it('accepts an unmarked helper pinned by its manifest', () => {
    artifact(directory);
    expect(run('--require')).toBe(0);
  });
  it.each(['utf8', 'utf16le'])('rejects a %s marker even when its digest matches', (encoding) => {
    artifact(
      directory,
      Buffer.concat([Buffer.from([0, 1]), Buffer.from(marker, encoding), Buffer.from([0, 255])]),
    );
    expect(run('--require')).toBe(1);
    expect(errors.join('\n')).toContain('test-hang marker');
  });
  it('rejects changed helper bytes before trusting the scan', () => {
    artifact(directory);
    writeFileSync(join(directory, helper), 'changed synthetic helper');
    expect(run()).toBe(1);
    expect(errors.join('\n')).toContain('digest');
  });
  it('skips missing optional artifacts but fails when required', () => {
    expect(run()).toBe(0);
    expect(run('--require')).toBe(1);
  });
  it('rejects missing helpers and invalid manifests', () => {
    writeFileSync(join(directory, manifest), '{}');
    expect(run()).toBe(1);
    artifact(directory, Buffer.from('synthetic helper'), { platform: 'darwin' });
    expect(run()).toBe(1);
    writeFileSync(join(directory, manifest), '{');
    expect(run()).toBe(1);
  });
  it('does not silently accept unsupported platforms with --require', () => {
    expect(main([], 'linux')).toBe(0);
    expect(main(['--require'], 'linux')).toBe(1);
  });
  it('checks every packaged resources helper against its own manifest', () => {
    artifact(directory);
    const out = join(directory, 'out');
    artifact(join(out, 'first', 'resources'));
    const second = join(out, 'second', 'resources');
    artifact(second, Buffer.from('synthetic signed helper'));
    expect(run('--require', `--out=${out}`)).toBe(0);
    artifact(second, Buffer.from(marker));
    expect(run('--require', `--out=${out}`)).toBe(1);
    expect(errors.join('\n')).toContain('test-hang marker');
  });
  it('rejects missing output, empty output and a package missing its helper', () => {
    artifact(directory);
    const out = join(directory, 'out');
    expect(run('--require', `--out=${out}`)).toBe(1);
    mkdirSync(out);
    expect(run('--require', `--out=${out}`)).toBe(1);
    artifact(join(out, 'valid', 'resources'));
    mkdirSync(join(out, 'incomplete', 'resources'), { recursive: true });
    expect(run('--require', `--out=${out}`)).toBe(1);
  });
  it('rejects a packaged digest mismatch', () => {
    artifact(directory);
    const out = join(directory, 'out');
    artifact(join(out, 'app', 'resources'), Buffer.from('synthetic helper'), {
      binaryDigest: '0'.repeat(64),
    });
    expect(run('--require', `--out=${out}`)).toBe(1);
    expect(errors.join('\n')).toContain('digest');
  });
});

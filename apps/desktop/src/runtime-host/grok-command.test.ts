import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGrokCommandCandidates } from './grok-command';
import { compatibilityFor, isSafeCliVersionText } from './cli-command-resolution';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('official Grok command resolution', () => {
  it('finds the native installer in a home containing spaces without PATH', () => {
    const root = mkdtempSync(join(tmpdir(), 'grok cli home '));
    roots.push(root);
    mkdirSync(join(root, '.grok', 'bin'), { recursive: true });
    const binary = join(root, '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok');
    writeFileSync(binary, 'synthetic', { mode: 0o700 });
    expect(
      resolveGrokCommandCandidates('grok', { HOME: root, USERPROFILE: root, PATH: '.' }),
    ).toEqual([{ executable: binary, source: 'user-local' }]);
  });
  it('requires an absolute explicit command and does not invoke shell shims', () => {
    expect(resolveGrokCommandCandidates('grok', { SPRINT_CODER_GROK_COMMAND: './grok' })).toEqual(
      [],
    );
    expect(
      resolveGrokCommandCandidates('grok', { SPRINT_CODER_GROK_COMMAND: 'grok.cmd' }, 'win32'),
    ).toEqual([]);
  });
  it('recognizes the official native version and gates uninspected major/old releases', () => {
    expect(isSafeCliVersionText('grok', 'grok 1.0.40 (eb1a2256660d)')).toBe(true);
    expect(isSafeCliVersionText('grok', '1.0.40')).toBe(false);
    expect(isSafeCliVersionText('grok', 'grok-cli 1.0.40')).toBe(false);
    expect(isSafeCliVersionText('grok', 'grok 1.0.40\nsecret')).toBe(false);
    expect(compatibilityFor('grok', 'grok 1.0.40 (eb1a2256660d)')).toBe('compatible');
    expect(compatibilityFor('grok', 'grok 1.0.39')).toBe('unsupported');
    expect(compatibilityFor('grok', 'grok 2.0.0')).toBe('unsupported');
  });
  it('accepts the Windows installer stable channel suffix without widening version compatibility', () => {
    const version = 'grok 1.0.40 (eb1a2256660d) [stable]';
    expect(isSafeCliVersionText('grok', version)).toBe(true);
    expect(isSafeCliVersionText('grok', 'grok 1.0.40 [stable]')).toBe(true);
    expect(compatibilityFor('grok', version)).toBe('compatible');
    expect(compatibilityFor('grok', 'grok 1.0.39 (eb1a2256660d) [stable]')).toBe('unsupported');
    expect(compatibilityFor('grok', 'grok 2.0.0 (eb1a2256660d) [stable]')).toBe('unsupported');
  });
  it.each([
    'grok 1.0.40 (eb1a2256660d) [unknown]',
    'grok 1.0.40 (eb1a2256660d) [stable] extra',
    'grok 1.0.40 (eb1a2256660d)\n[stable]',
    'grok 1.0.40 (eb1a2256660d) [stable]\nsecret',
  ])('rejects noncanonical channel output: %s', (version) => {
    expect(isSafeCliVersionText('grok', version)).toBe(false);
  });
});

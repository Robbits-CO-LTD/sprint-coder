import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readWindowsHostSource,
  windowsHostNativeDirectory,
} from '../../../../computer-use-windows-host-source.mjs';

const directories: string[] = [];
const hostName = 'computer_use_windows_host.cc';
const partName = 'computer_use_windows_host_part.inc';
const include = `#include "${partName}"`;

function fixture(host: string, parts: Record<string, string> = {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'windows-host-source-'));
  directories.push(directory);
  for (const [name, source] of Object.entries({ [hostName]: host, ...parts }))
    writeFileSync(join(directory, name), source, 'utf8');
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('Windows host source structure', () => {
  it('includes every real fragment exactly once, without nesting or changed line endings', () => {
    const host = readFileSync(join(windowsHostNativeDirectory, hostName), 'utf8');
    const parts = readdirSync(windowsHostNativeDirectory)
      .filter((name) => /^computer_use_windows_host_.*\.inc$/u.test(name))
      .sort();
    const includes = [
      ...host.matchAll(/^#include "(computer_use_windows_host_[a-z0-9_]+\.inc)"$/gmu),
    ]
      .map((match) => match[1]!)
      .sort();
    expect(includes).toEqual(parts);
    expect(new Set(includes).size).toBe(includes.length);
    expect(host).not.toContain('\r');
    for (const name of parts) {
      const source = readFileSync(join(windowsHostNativeDirectory, name), 'utf8');
      expect(source, name).not.toContain('#include "computer_use_windows_host_');
      expect(source.endsWith('\n'), name).toBe(true);
      expect(source, name).not.toContain('\r');
    }
    const expanded = readWindowsHostSource();
    if (parts.length === 0) expect(expanded).toBe(host);
  });

  it('replaces the whole include line, preserving fragment bytes and order', () => {
    const second = 'computer_use_windows_host_second.inc';
    const directory = fixture(`before\n${include}\n#include "${second}"\nafter\n`, {
      [partName]: 'first\n\n',
      [second]: 'second\n',
    });
    expect(readWindowsHostSource(directory)).toBe('before\nfirst\n\nsecond\nafter\n');
  });

  it('preserves an unsplit source and only expands exact include lines', () => {
    const source = `#include <string>\n// ${include}\n ${include}\n${include} // comment\n`;
    expect(readWindowsHostSource(fixture(source))).toBe(source);
  });

  it('expands an include at the end of the host without adding a newline', () => {
    expect(readWindowsHostSource(fixture(include, { [partName]: 'part\n' }))).toBe('part\n');
  });

  it.each([
    ['duplicate include', `${include}\n${include}\n`, { [partName]: 'part\n' }, /Duplicate/u],
    ['nested include', `${include}\n`, { [partName]: `${include}\n` }, /Nested/u],
    ['CR in host', 'host\r\n', {}, /CR/u],
    ['CR in fragment', `${include}\n`, { [partName]: 'part\r\n' }, /CR/u],
    ['missing fragment', `${include}\n`, {}, /ENOENT/u],
    ['unreferenced fragment', 'host\n', { [partName]: 'part\n' }, /Unreferenced/u],
    ['missing final newline', `${include}\n`, { [partName]: 'part' }, /newline/u],
  ] as const)('rejects %s', (_name, host, parts, error) => {
    expect(() => readWindowsHostSource(fixture(host, parts))).toThrow(error);
  });
});

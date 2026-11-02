import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as ts from 'typescript';
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

function unroutedReaders(root: string): string[] {
  const desktop = join(root, 'apps/desktop');
  const allowedReaders = new Set([
    // This test names the raw host file on purpose (fixtures and structure checks) and does not
    // import the helper as a reader, so the import check below cannot exempt it.
    join(desktop, 'src/main/computer-use-windows-host-source.test.ts'),
  ]);
  const files = [
    ...readdirSync(join(desktop, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.test.ts'))
      .map((name) => join(desktop, 'src', name)),
    ...readdirSync(root)
      .filter((name) => /^verify-.*\.mjs$/u.test(name) || name.endsWith('.test.mjs'))
      .map((name) => join(root, name)),
    ...readdirSync(desktop)
      .filter((name) => name.endsWith('.test.mjs'))
      .map((name) => join(desktop, name)),
  ];
  const printer = ts.createPrinter({ removeComments: true });
  return files.filter((file) => {
    if (allowedReaders.has(file)) return false;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    if (!printer.printFile(source).includes(hostName)) return false;
    return !source.statements.some(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        /(?:^|\/)computer-use-windows-host-source\.mjs$/u.test(statement.moduleSpecifier.text) &&
        !statement.importClause?.isTypeOnly &&
        statement.importClause?.namedBindings &&
        (ts.isNamespaceImport(statement.importClause.namedBindings) ||
          statement.importClause.namedBindings.elements.some(
            (element) =>
              !element.isTypeOnly &&
              (element.propertyName ?? element.name).text === 'readWindowsHostSource',
          )),
    );
  });
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('Windows host source structure', () => {
  it('returns the same decimal processStartTime field in both Windows start responses', () => {
    const source = readWindowsHostSource();
    expect(source.split(String.raw`\"processStartTime\":\"`).length - 1).toBe(2);
    expect(source.match(/JsonEscape\(session\.process_start\)/gu)).toHaveLength(2);
    expect(source).toContain('*output = std::to_string(ticks.QuadPart);');
    const host = readFileSync(join(__dirname, 'computer-use-native-host.ts'), 'utf8');
    expect(host).toContain("raw['processStartTime']");
  });

  it('routes host source reads in tests and the offline verifier through the helper', () => {
    expect(unroutedReaders(join(__dirname, '../../../..'))).toEqual([]);
  });

  it.each([
    'apps/desktop/src/main/direct.test.ts',
    'apps/desktop/src/renderer/nested/direct.test.ts',
    'verify-other.mjs',
    'direct.test.mjs',
    'apps/desktop/direct.test.mjs',
  ])('detects indirect host reads in %s', (name) => {
    const root = fixture('');
    mkdirSync(join(root, 'apps/desktop/src/main'), { recursive: true });
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `const path = '/native/${hostName}'; readFile(path);`);
    expect(unroutedReaders(root)).toEqual([file]);
  });

  it.each([
    [`const path = '${hostName}';`, false],
    [`const path = 'native\\\\${hostName}';`, false],
    [`// ${hostName}\n/* ${hostName} */`, true],
    [
      `// import { readWindowsHostSource } from './computer-use-windows-host-source.mjs';\nconst path = '${hostName}';`,
      false,
    ],
    [
      `import { readWindowsHostSource as read } from './computer-use-windows-host-source.mjs';\nconst path = '${hostName}';`,
      true,
    ],
    [
      `import { windowsHostNativeDirectory } from './computer-use-windows-host-source.mjs';\nconst path = '${hostName}';`,
      false,
    ],
    [
      `import { readWindowsHostSource, windowsHostNativeDirectory } from './computer-use-windows-host-source.mjs';\nconst path = '${hostName}';`,
      true,
    ],
    [`import { readWindowsHostSource } from './other.mjs';\nconst path = '${hostName}';`, false],
    [`import './computer-use-windows-host-source.mjs';\nconst path = '${hostName}';`, false],
    [
      `import type { readWindowsHostSource } from './computer-use-windows-host-source.mjs';\nconst path = '${hostName}';`,
      false,
    ],
  ])('checks helper imports without treating comments as code: %s', (source, allowed) => {
    const root = fixture('');
    mkdirSync(join(root, 'apps/desktop/src/main'), { recursive: true });
    const file = join(root, 'direct.test.mjs');
    writeFileSync(file, source);
    expect(unroutedReaders(root)).toEqual(allowed ? [] : [file]);
  });

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
    const source = `#include <string>\n// ${include}\n`;
    expect(readWindowsHostSource(fixture(source))).toBe(source);
  });

  it('expands an include at the end of the host without adding a newline', () => {
    expect(readWindowsHostSource(fixture(include, { [partName]: 'part\n' }))).toBe('part\n');
  });

  it.each([
    ...[
      '#include "computer_use_windows_input.inc"',
      '#include "windows_host_part.cc"',
      '#include "Computer_Use_Windows_Host_Part.inc"',
      '#include <computer_use_windows_host_part.inc>',
      '#include <windows_host_part.cc>',
      '#include <computer_use_windows_host_part.cpp>',
      '#include <part.inl>',
      '#include <part.hpp>',
    ].flatMap(
      (directive) =>
        [
          [directive, `${directive}\n`, {}, /Unsupported/u],
          [
            `fragment ${directive}`,
            `${include}\n`,
            { [partName]: `${directive}\n` },
            /Unsupported/u,
          ],
        ] as const,
    ),
    ['indented include', ` ${include}\n`, {}, /Unexpanded/u],
    ['include with trailing comment', `${include} // comment\n`, {}, /Unexpanded/u],
    [
      'subdirectory include',
      '#include "host/computer_use_windows_host_part.inc"\n',
      {},
      /Unexpanded/u,
    ],
    ['relative include', '#include "./computer_use_windows_host_part.inc"\n', {}, /Unexpanded/u],
    ['header include', '#include "computer_use_windows_host_part.h"\n', {}, /Unexpanded/u],
    ['angle header include', '#include <computer_use_windows_host_part.h>\n', {}, /Unexpanded/u],
    [
      'unexpanded include in fragment',
      `${include}\n`,
      { [partName]: '#include "host/computer_use_windows_host_part.inc"\n' },
      /Unexpanded/u,
    ],
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

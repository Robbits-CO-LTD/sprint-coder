import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const native = join(__dirname, '../../computer-use-native');
const source = join(native, 'computer_use_url_origin_test.cc');
const headerName = 'computer_use_url_origin.h';

type Command = { file: string; args: string[]; verbatim: boolean };
function compiler(output: string): Command | null {
  if (process.platform !== 'win32') {
    if (spawnSync('clang++', ['--version'], { stdio: 'ignore' }).status !== 0) return null;
    return {
      file: 'clang++',
      args: ['-std=c++20', '-Wall', '-Wextra', '-Werror', source, '-o', output],
      verbatim: false,
    };
  }
  const args = [
    '/nologo',
    '/std:c++20',
    '/EHsc',
    '/W4',
    '/WX',
    '/sdl',
    '/utf-8',
    source,
    `/Fe:${output}`,
    `/Fo:${output}.obj`,
  ];
  if (spawnSync('cl.exe', ['/?'], { stdio: 'ignore' }).status === 0)
    return { file: 'cl.exe', args, verbatim: false };
  const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
  if (!existsSync(vswhere)) return null;
  const found = spawnSync(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
    ],
    { encoding: 'utf8' },
  );
  const root = found.stdout?.trim();
  if (found.status !== 0 || !root) return null;
  const vcvars = join(root, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  if (!existsSync(vcvars)) return null;
  return {
    file: 'cmd.exe',
    args: [
      '/d',
      '/s',
      '/c',
      `"call "${vcvars}" >nul && cl.exe ${args.map((arg) => `"${arg}"`).join(' ')}"`,
    ],
    verbatim: true,
  };
}

describe('N11-B shared URL origin parser', () => {
  it('shares its parser with page classification and uses only portable headers', () => {
    const header = readFileSync(join(native, headerName), 'utf8');
    expect([...header.matchAll(/^#include <([^>]+)>/gmu)].map((match) => match[1])).toEqual([
      'string',
      'string_view',
    ]);
    const references: string[] = [];
    for (const entry of readdirSync(native, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:h|cc|mm)$/u.test(entry.name) || entry.name === headerName)
        continue;
      if (readFileSync(join(entry.parentPath, entry.name), 'utf8').includes(headerName))
        references.push(entry.name);
    }
    expect(references.sort()).toEqual([
      'computer_use_origin_classify.h',
      'computer_use_url_origin_test.cc',
    ]);
    expect(readFileSync(join(native, 'computer_use_origin_classify.h'), 'utf8')).toContain(
      'NormalizeUrlOrigin(url)',
    );
    expect(readFileSync(join(native, 'computer_use_effect_measurement.h'), 'utf8')).toContain(
      'ClassifyPageOrigin(url).normalized_origin',
    );
  });

  it('compiles and runs synthetic golden cases through the shared effect classifier', async (ctx) => {
    const directory = mkdtempSync(join(tmpdir(), 'sc-url-origin-'));
    // Only the fresh fixture directory under the resolved temporary root may be removed.
    const tempRoot = resolve(tmpdir());
    if (!resolve(directory).startsWith(`${tempRoot}${sep}`))
      throw new Error('Unexpected fixture directory');
    try {
      const output = join(directory, process.platform === 'win32' ? 'golden.exe' : 'golden');
      const build = compiler(output);
      if (!build) {
        if (process.env['CI']) throw new Error('Native compiler required in CI');
        ctx.skip();
        return;
      }
      await run(build.file, build.args, {
        cwd: directory,
        windowsVerbatimArguments: build.verbatim,
        windowsHide: true,
        timeout: 60_000,
      });
      const result = await run(output, [], { windowsHide: true, timeout: 10_000 });
      expect(result.stdout.trim()).toBe('URL origin golden + classifier handoff: PASS');
      expect(result.stderr).toBe('');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);
});

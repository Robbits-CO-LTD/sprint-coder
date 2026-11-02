import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
const nativeDirectory = join(__dirname, '../../computer-use-native');
const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
const libraries = [
  'ole32.lib',
  'oleaut32.lib',
  'uiautomationcore.lib',
  'user32.lib',
  'uuid.lib',
  'shell32.lib',
];

function compileArguments(path: string, output: string): string[] {
  return [
    '/nologo',
    '/std:c++20',
    '/EHsc',
    '/W4',
    '/permissive-',
    '/utf-8',
    '/DUNICODE',
    '/D_UNICODE',
    '/DNOMINMAX',
    '/D_WIN32_WINNT=0x0A00',
    `/I${nativeDirectory}`,
    path,
    `/Fe:${output}`,
    `/Fo:${output}.obj`,
    '/link',
    '/DEBUG:NONE',
    ...libraries,
  ];
}

type Build = Readonly<{ name: string; file: string; args: string[]; verbatim: boolean }>;

function findBuild(path: string, output: string): Build | null {
  if (process.platform !== 'win32') return null;
  if (spawnSync('cl.exe', ['/?'], { stdio: 'ignore' }).status === 0)
    return {
      name: 'cl.exe',
      file: 'cl.exe',
      args: compileArguments(path, output),
      verbatim: false,
    };
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
  const root = found.stdout.trim();
  const vcvars = join(root, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  if (found.status !== 0 || root === '' || !existsSync(vcvars)) return null;
  return {
    name: 'cl.exe (vcvars64)',
    file: 'cmd.exe',
    args: [
      '/d',
      '/s',
      '/c',
      `"call "${vcvars}" >nul && cl.exe ${compileArguments(path, output)
        .map((argument) => `"${argument}"`)
        .join(' ')}"`,
    ],
    verbatim: true,
  };
}

// MSVC and OS calls belong to the parent verification run, outside the implementation sandbox.
describe.skipIf(process.platform !== 'win32')('Windows association / selection seam', () => {
  it('runs the portable negative matrix and the OS failure / cancellation boundaries', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'computer-use-association-seam-'));
    try {
      const binary = join(scratch, 'seam.exe');
      const compiler = findBuild(
        join(nativeDirectory, 'computer_use_windows_association_seam.cc'),
        binary,
      );
      expect(compiler, 'MSVC is required; a missing compiler is not a passing seam').not.toBeNull();
      const built = spawnSync(compiler!.file, compiler!.args, {
        encoding: 'utf8',
        cwd: scratch,
        windowsVerbatimArguments: compiler!.verbatim,
        timeout: 180_000,
        env: { ...process.env, VSLANG: '1033' },
      });
      expect(built.status, built.stdout + built.stderr).toBe(0);
      const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 30_000 });
      expect(run.status, run.stdout + run.stderr).toBe(0);
      expect(run.stdout).toContain('OK');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 240_000);
});

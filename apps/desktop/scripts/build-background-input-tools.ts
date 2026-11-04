import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

type Build = {
  wrap: (args: string[]) => { file: string; args: string[]; verbatim: boolean };
};
const run = promisify(execFile);
export const fixtureDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../computer-use-native/fixtures/background-input',
);

export function findBuild(): Build | null {
  if (process.platform !== 'win32') return null;
  if (spawnSync('cl.exe', ['/?'], { stdio: 'ignore', windowsHide: true }).status === 0)
    return { wrap: (args) => ({ file: 'cl.exe', args, verbatim: false }) };
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
    { encoding: 'utf8', windowsHide: true },
  );
  const root = found.stdout?.trim() ?? '';
  const vcvars = join(root, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  if (found.status !== 0 || !root || !existsSync(vcvars)) return null;
  return {
    wrap: (args) => {
      // cmd expands these even inside quotes. Refuse rather than reinterpret a path.
      if ([vcvars, ...args].some((arg) => /["%\r\n!]/u.test(arg)))
        throw new Error('Unsupported character in MSVC build path');
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
    },
  };
}

export async function buildTools(output: string) {
  const build = findBuild();
  if (!build) throw new Error('MSVC required (Windows x64 developer tools)');
  const root = resolve(output);
  mkdirSync(root, { recursive: true });
  const binaries = { fixture: join(root, 'fixture.exe'), observer: join(root, 'observer.exe') };
  for (const name of ['fixture', 'observer'] as const) {
    const command = build.wrap([
      '/nologo',
      '/std:c++20',
      '/EHsc',
      '/W4',
      '/sdl',
      '/permissive-',
      '/utf-8',
      '/DUNICODE',
      '/D_UNICODE',
      '/DWIN32_LEAN_AND_MEAN',
      '/DNOMINMAX',
      '/D_WIN32_WINNT=0x0A00',
      join(fixtureDirectory, `${name}.cc`),
      `/Fe:${binaries[name]}`,
      `/Fo:${binaries[name]}.obj`,
      '/link',
      '/DEBUG:NONE',
      ...(name === 'fixture' ? ['/SUBSYSTEM:WINDOWS'] : []),
      'user32.lib',
      'gdi32.lib',
      'ole32.lib',
      'oleaut32.lib',
      'uiautomationcore.lib',
      'uuid.lib',
    ]);
    await run(command.file, command.args, {
      cwd: root,
      encoding: 'utf8',
      windowsVerbatimArguments: command.verbatim,
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, VSLANG: '1033' },
    });
  }
  return binaries;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output)
    throw new Error(
      'Usage: node --experimental-strip-types build-background-input-tools.ts <output-directory>',
    );
  buildTools(output)
    .then((binaries) => console.log(JSON.stringify(binaries)))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}

import { readWindowsHostSource } from '../../../../computer-use-windows-host-source.mjs';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
const nativeDirectory = join(__dirname, '../../computer-use-native');
const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
type Build = Readonly<{
  wrap: (arguments_: string[]) => { file: string; args: string[]; verbatim: boolean };
}>;

function findBuild(): Build | null {
  if (process.platform !== 'win32') return null;
  if (spawnSync('cl.exe', ['/?'], { stdio: 'ignore' }).status === 0)
    return { wrap: (args) => ({ file: 'cl.exe', args, verbatim: false }) };
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
  if (found.error) throw found.error;
  const root = found.stdout.trim();
  const vcvars = join(root, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  if (found.status !== 0 || root === '' || !existsSync(vcvars)) return null;
  return {
    wrap: (args) => ({
      file: 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        `"call "${vcvars}" >nul && cl.exe ${args.map((argument) => `"${argument}"`).join(' ')}"`,
      ],
      verbatim: true,
    }),
  };
}

const source = readWindowsHostSource();
function componentSource(): string {
  const stringStart = source.indexOf('bool ReadJsonStringValueAt(');
  const stringEnd = source.indexOf('\nbool ReadPendingWindowsStop(', stringStart);
  const timeStart = source.indexOf('bool ReadProcessStartIdentity(HANDLE');
  const timeEnd = source.indexOf('\nbool ReadProcessStartIdentity(std::uint32_t', timeStart);
  const begin = source.indexOf('// BEGIN windows target identity');
  const end = source.indexOf('// END windows target identity', begin);
  expect(stringStart).toBeGreaterThanOrEqual(0);
  expect(stringEnd).toBeGreaterThan(stringStart);
  expect(timeStart).toBeGreaterThanOrEqual(0);
  expect(timeEnd).toBeGreaterThan(timeStart);
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);
  return [
    source.slice(stringStart, stringEnd),
    source.slice(timeStart, timeEnd),
    source.slice(begin, end),
  ].join('\n');
}

it('uses the production identity parser and read-only process checks without UI access', () => {
  const implementation = componentSource();
  expect(implementation).toContain('SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION');
  expect(implementation).toContain('WaitForSingleObject(');
  expect(implementation).toContain('GetProcessTimes(');
  expect(implementation).toContain('CloseHandle(');
  expect(implementation).not.toMatch(
    /SendInput|SetForegroundWindow|UIAutomation|PROCESS_TERMINATE/u,
  );
});

describe.skipIf(process.platform !== 'win32')('Windows target identity component', () => {
  it('checks child lifetime, PID reuse, missing PID, error classification and strict bounds', ({
    skip,
  }) => {
    const build = findBuild();
    if (!build) {
      if (process.env.CI) throw new Error('MSVC required');
      skip();
      return;
    }
    const root = mkdtempSync(join(tmpdir(), 'sc-target-identity-'));
    try {
      writeFileSync(join(root, 'component-identity.inc'), componentSource());
      const file = join(root, 'component.cc');
      const binary = join(root, 'component.exe');
      writeFileSync(
        file,
        readFileSync(join(nativeDirectory, 'computer_use_windows_target_identity_test.cc'), 'utf8'),
      );
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
        file,
        `/Fe:${binary}`,
        `/Fo:${binary}.obj`,
        '/link',
        '/DEBUG:NONE',
      ]);
      const compiled = spawnSync(command.file, command.args, {
        encoding: 'utf8',
        windowsVerbatimArguments: command.verbatim,
        timeout: 60000,
        env: { ...process.env, VSLANG: '1033' },
      });
      if (compiled.error) throw compiled.error;
      expect(compiled.status, compiled.stdout + '\n' + compiled.stderr).toBe(0);
      const result = spawnSync(realpathSync.native(binary), [], {
        encoding: 'utf8',
        timeout: 45000,
      });
      if (result.error) throw result.error;
      expect(result.status, result.stdout + '\n' + result.stderr).toBe(0);
      expect(result.stdout).toContain('PASS: target identity component');
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 120000);
});

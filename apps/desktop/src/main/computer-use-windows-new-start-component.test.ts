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
const program = readFileSync(
  join(nativeDirectory, 'computer_use_windows_new_start_test.cc'),
  'utf8',
);
function replaceOne(value: string, pattern: string | RegExp, replacement: string): string {
  expect(
    typeof pattern === 'string'
      ? value.split(pattern).length - 1
      : [...value.matchAll(pattern)].length,
  ).toBe(1);
  return value.replace(pattern, replacement);
}
function componentSource(): string {
  const begin = source.indexOf('// BEGIN windows shared new start');
  const end = source.indexOf('// END windows shared new start', begin);
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);
  let shared = source.slice(begin, end);
  shared = replaceOne(
    shared,
    /CurrentWindowsTargetFactsContext\(input\.main_pid,\s*WindowsV2SelfSignerThumbprint\(\),\s*\/\*acceptance_mode=\*\/false,\s*still_valid\)/gu,
    'ComponentContext(input.main_pid)',
  );
  shared = replaceOne(
    shared,
    /AdmitWindowsV2StartInContext\([\s\S]*?&measured->not_web_file\)/gu,
    'ComponentAdmit(input, measured)',
  );
  const functions: Record<string, string> = {
    WindowsBackgroundStartGate: 'ComponentBackgroundGate',
    StartWindowsBackgroundMonitor: 'ComponentBackgroundMonitor',
    WindowsBackgroundMonitorCurrent: 'ComponentBackgroundMonitorReady',
    WindowsBackgroundTargetSupported: 'ComponentBackgroundSupported',
    MeasureWindowsBackgroundStartFacts: 'ComponentBackgroundFacts',
    CaptureWindowsBackgroundStartDialogs: 'ComponentBackgroundDialogs',
    OpenProcess: 'ComponentOpenProcess',
    OpenLockedProcessExecutable: 'ComponentOpenExecutable',
    IsProcessElevated: 'ComponentElevated',
    IsWindow: 'ComponentWindow',
    IsApplicationWindow: 'ComponentApplicationWindow',
    ClientBoundsPhysical: 'ComponentClientBounds',
    TargetWindowFacts: 'ComponentTargetFacts',
    ScreenBoundsPhysicalForWindow: 'ComponentScreenBounds',
    GetForegroundWindow: 'ComponentForeground',
    IsWindowEnabled: 'ComponentEnabled',
    IsNativeTakeoverWindow: 'ComponentTakeover',
    IsIconic: 'ComponentIconic',
    ShowWindow: 'ComponentShow',
    SetForegroundWindow: 'ComponentFocus',
    CoInitializeEx: 'ComponentCoInitialize',
    CoUninitialize: 'ComponentCoUninitialize',
  };
  for (const [name, replacement] of Object.entries(functions)) {
    const pattern = new RegExp(`\\b${name}\\(`, 'gu');
    expect([...shared.matchAll(pattern)].length, name).toBeGreaterThan(0);
    shared = shared.replace(pattern, replacement + '(');
  }
  shared = replaceOne(
    shared,
    '  try {\n    struct Apartment {',
    '  try {\n    ComponentBeforeMeasurement();\n    struct Apartment {',
  );
  const adoption = '  // Stop and final start adoption share this lock.';
  shared = replaceOne(shared, adoption, '  ComponentBeforeAdopt();\n' + adoption);
  expect(shared).not.toMatch(/\b(?:ShowWindow|SetForegroundWindow|SendInput|TargetWindowFacts)\(/u);
  const identityBegin = source.indexOf('bool CheckWindowsStartFocusIdentity(');
  const identityEnd = source.indexOf('bool WindowsSessionProcessMatches(', identityBegin);
  const identity = source
    .slice(identityBegin, identityEnd)
    .replaceAll('ReadProcessStartIdentity(', 'ComponentStartTime(')
    .replaceAll('GetWindowThreadProcessId(', 'ComponentWindowOwner(')
    .replaceAll('IsWindow(', 'ComponentWindow(');
  const prefix = source.slice(0, identityBegin) + identity + source.slice(identityEnd, begin);
  return (prefix + shared + source.slice(end)).replaceAll('CloseHandle(', 'ComponentCloseHandle(');
}

it('limits component substitutions to the shared measurement and retains real eligibility predicates', () => {
  const built = componentSource();
  expect(built).toContain('WindowsExecutableIdentityMatches(executable.identity');
  expect(built).toContain('IsSupportedWindowsV1Target(executable.identity)');
});

describe.skipIf(process.platform !== 'win32')('Windows shared new-start component matrix', () => {
  it('preserves basis-specific policy, geometry, epochs, ticket updates and cleanup without GUI', ({
    skip,
  }) => {
    const build = findBuild();
    if (!build) {
      if (process.env.CI) throw new Error('MSVC required');
      skip();
      return;
    }
    const root = mkdtempSync(join(tmpdir(), 'sc-new-start-components-'));
    try {
      writeFileSync(join(root, 'component-host.cc'), componentSource());
      const file = join(root, 'component.cc'),
        binary = join(root, 'component.exe');
      writeFileSync(file, program);
      const provenance = join(root, 'provenance.h');
      writeFileSync(
        provenance,
        '#pragma once\n#define SPRINT_CODER_SOURCE_COMMIT "0000000000000000000000000000000000000000"\n',
      );
      const command = build.wrap([
        '/nologo',
        '/std:c++20',
        '/EHsc',
        '/W4',
        '/we4062',
        '/sdl',
        '/permissive-',
        '/utf-8',
        '/DUNICODE',
        '/D_UNICODE',
        '/DWIN32_LEAN_AND_MEAN',
        '/DNOMINMAX',
        '/D_WIN32_WINNT=0x0A00',
        '/DSPRINT_CODER_ELIGIBILITY_V2=1',
        `/FI${provenance}`,
        `/I${nativeDirectory}`,
        file,
        `/Fe:${binary}`,
        `/Fo:${binary}.obj`,
        '/link',
        '/DEBUG:NONE',
        'ole32.lib',
        'oleaut32.lib',
        'uiautomationcore.lib',
        'user32.lib',
        'dwmapi.lib',
        'd3d11.lib',
        'dxgi.lib',
        'windowscodecs.lib',
        'bcrypt.lib',
        'advapi32.lib',
        'userenv.lib',
        'crypt32.lib',
        'wintrust.lib',
        'shell32.lib',
        'runtimeobject.lib',
        'windowsapp.lib',
        'uuid.lib',
      ]);
      const compiled = spawnSync(command.file, command.args, {
        encoding: 'utf8',
        windowsVerbatimArguments: command.verbatim,
        timeout: 500000,
        env: { ...process.env, VSLANG: '1033' },
      });
      expect(compiled.status, compiled.stdout + '\n' + compiled.stderr).toBe(0);

      const result = spawnSync(realpathSync.native(binary), [], {
        encoding: 'utf8',
        timeout: 120000,
      });
      expect(result.status, result.stdout + '\n' + result.stderr).toBe(0);
      expect(result.stdout).toContain(
        'PASS: 62 component cases, controlled focus only, no OS input',
      );
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 540000);
});

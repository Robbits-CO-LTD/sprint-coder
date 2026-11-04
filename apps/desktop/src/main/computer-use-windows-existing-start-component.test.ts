import { readWindowsHostSource } from '../../../../computer-use-windows-host-source.mjs';
import { execFile, spawnSync, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
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

// Keep the worker responsive to Vitest RPC while native builds and matrices run.
function runAsync(file: string, args: string[], options: ExecFileOptionsWithStringEncoding) {
  return new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
    signal: NodeJS.Signals | null;
    error: Error | undefined;
  }>((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      resolve({
        status: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        stdout,
        stderr,
        signal: error?.signal ?? null,
        error: error && typeof error.code !== 'number' ? error : undefined,
      });
    });
  });
}
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
  join(nativeDirectory, 'computer_use_windows_existing_start_test.cc'),
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
  const begin = source.indexOf('// BEGIN windows shared existing start');
  const end = source.indexOf('// END windows shared existing start', begin);
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);
  let shared = source.slice(begin, end);
  shared = replaceOne(
    shared,
    /CurrentWindowsTargetFactsContext\(input\.main_pid,\s*std::move\(signer\),\s*still_valid\)/gu,
    'ComponentContext(input.main_pid)',
  );
  shared = replaceOne(
    shared,
    /AdmitWindowsV2StartInContext\([\s\S]*?&not_web_file,\s*&explorer_scope, &explorer_admitted\)/gu,
    'ComponentAdmit(input, &measured)',
  );
  const functions: Record<string, string> = {
    WindowsBackgroundStartGate: 'ComponentBackgroundGate',
    StartWindowsBackgroundMonitor: 'ComponentBackgroundMonitor',
    WindowsBackgroundMonitorReady: 'ComponentBackgroundMonitorReady',
    WindowsBackgroundTargetSupported: 'ComponentBackgroundSupported',
    MeasureWindowsBackgroundStartFacts: 'ComponentBackgroundFacts',
    CaptureWindowsBackgroundStartDialogs: 'ComponentBackgroundDialogs',
    OpenProcess: 'ComponentOpenProcess',
    OpenLockedProcessExecutable: 'ComponentOpenExecutable',
    DuplicateHandle: 'ComponentDuplicateHandle',
    IsProcessElevated: 'ComponentElevated',
    IsWindow: 'ComponentWindow',
    IsApplicationWindow: 'ComponentApplicationWindow',
    ClientBoundsPhysical: 'ComponentClientBounds',
    TargetWindowFacts: 'ComponentTargetFacts',
    ScreenBoundsPhysicalForWindow: 'ComponentScreenBounds',
    GetForegroundWindow: 'ComponentForeground',
    IsIconic: 'ComponentIconic',
    ShowWindow: 'ComponentShow',
    SetForegroundWindow: 'ComponentFocus',
    ResolveWindowsExplicitResumeTarget: 'ComponentResolve',
    ResolveWindowsSessionRefocusTarget: 'ComponentRefocus',
    CaptureWindowsDialogSet: 'ComponentDialogs',
    CoInitializeEx: 'ComponentCoInitialize',
    CoUninitialize: 'ComponentCoUninitialize',
    ReadWindowsFileIdentity: 'ComponentReadHeld',
  };
  for (const [name, replacement] of Object.entries(functions)) {
    const pattern = new RegExp(`\\b${name}\\(`, 'gu');
    expect([...shared.matchAll(pattern)].length, name).toBeGreaterThan(0);
    shared = shared.replace(pattern, replacement + '(');
  }
  shared = replaceOne(
    shared,
    '    WindowsNewStartIoRegistration cancellation;',
    '    ComponentBeforeMeasurement();\n    WindowsNewStartIoRegistration cancellation;',
  );
  shared = replaceOne(
    shared,
    '  if (!v2 && before.identity_verified) {',
    '  ComponentBeforeTicket();\n  if (!v2 && before.identity_verified) {',
  );
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
  for (const [from, to] of [
    ['WindowsV2VerdictForWindowClass(WindowsV2Judgement', '// Judges one window'],
    ['TargetVerdict WindowsExplorerPrestartVerdict(', '// The core'],
    [
      'bool MeasureWindowsExplorerPrestart(const WindowsV2Judgement &process, HWND window,\n                                    const WindowsExplorerPrestartScope &scope) {',
      '// P5 REQUIREMENT (M2)',
    ],
  ] as const) {
    const begin = source.indexOf(from);
    const end = source.indexOf(to, begin);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(begin);
    expect(built).toContain(source.slice(begin, end));
  }
});

describe
  .skipIf(process.platform !== 'win32')
  .each(['explorer_gate_off', 'explorer_gate_off_with_hooks', 'explorer_gate_on'])(
  'Windows shared existing-start component matrix: %s',
  (variant) => {
    it('preserves basis-specific policy, geometry, epochs, ticket updates and cleanup without GUI', async ({
      skip,
    }) => {
      const build = findBuild();
      if (!build) {
        if (process.env.CI) throw new Error('MSVC required');
        skip();
        return;
      }
      const root = mkdtempSync(join(tmpdir(), 'sc-existing-start-components-'));
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
          ...(variant === 'explorer_gate_off_with_hooks'
            ? ['/DSPRINT_CODER_WINDOWS_EXPLORER_TEST_HOOKS=1']
            : []),
          ...(variant === 'explorer_gate_on'
            ? [
                '/DSPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD=1',
                '/DSPRINT_CODER_TEST_WINDOWS_EXPLORER_EXCEPTION=1',
              ]
            : []),
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
        const compiled = await runAsync(command.file, command.args, {
          encoding: 'utf8',
          windowsVerbatimArguments: command.verbatim,
          timeout: 500000,
          env: { ...process.env, VSLANG: '1033' },
        });
        expect(compiled.status, compiled.stdout + '\n' + compiled.stderr).toBe(0);

        const result = await runAsync(realpathSync.native(binary), [], {
          encoding: 'utf8',
          timeout: 120000,
        });
        expect(result.status, result.stdout + '\n' + result.stderr).toBe(0);
        expect(result.stdout).toContain(
          'PASS: 60 component cases, controlled focus only, no OS input',
        );
      } finally {
        rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      }
    }, 540000);
  },
);

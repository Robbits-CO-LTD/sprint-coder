import { findBuild } from './test-support/msvc-build';
import { readWindowsHostSource } from '../../../../computer-use-windows-host-source.mjs';
import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
    /CurrentWindowsTargetFactsContext\(input\.main_pid,\s*WindowsV2SelfSignerThumbprint\(\),\s*still_valid\)/gu,
    'ComponentContext(input.main_pid)',
  );
  shared = replaceOne(
    shared,
    /AdmitWindowsV2StartInContext\([\s\S]*?&measured->not_web_file,\s*&explorer_scope, &explorer_admitted\)/gu,
    'ComponentAdmit(input, measured, &explorer_scope, &explorer_admitted)',
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
    '    struct Apartment {',
    '    ComponentBeforeMeasurement();\n    struct Apartment {',
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
  let component = prefix + shared + source.slice(end);
  // Only the measured judgement is synthetic. Keep admission, session adoption, rejudge and
  // not-web binding as production code, so a lost file-key handoff fails the Store case.
  for (const call of [
    'JudgeWindowsV2Target(work.pid, work.window, context, &judged, &explorer_scope);',
    'JudgeWindowsV2Target(pid, window, context, &judged, explorer_scope);',
  ]) {
    component = replaceOne(
      component,
      call,
      call.replace('JudgeWindowsV2Target', 'ComponentStoreJudgement'),
    );
  }
  return component
    .replaceAll('CloseHandle(', 'ComponentCloseHandle(')
    .replaceAll('DuplicateHandle(', 'ComponentDuplicateHandle(')
    .replaceAll('CancelSynchronousIo(', 'ComponentCancelSynchronousIo(');
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

  expect(built).toContain('/*session_recorded=*/true, judged.not_web_package);');
  expect(built).toContain('/*session_recorded=*/false, judged.not_web_package)');
  expect(built).toContain('session.not_web_file = measured.not_web_file;');
});

it('registers cancellation only for measurement and refuses occupied sessions before I/O', () => {
  expect(source).toContain('HANDLE new_start_thread = nullptr;');
  expect(source).toContain('CancelSynchronousIo(control.new_start_thread)');
  const start = source.slice(source.indexOf('bool StartWindowsNewSession('));
  expect(start.indexOf('if (!sessions.empty())')).toBeLessThan(
    start.indexOf('MeasureWindowsNewStart(input'),
  );
  expect(start).toContain('WindowsNewStartIoRegistration cancellation;');
});

const componentMatrix = describe
  .skipIf(process.platform !== 'win32')
  .each([
    'store_not_web_is_absent_in_default_build',
    'store_not_web_enabled_acceptance_build',
    'store_not_web_enabled_final_build',
    'explorer_gate_off_with_hooks',
    'explorer_gate_on',
  ]);
componentMatrix('Windows shared new-start component matrix: %s', (variant) => {
  it('preserves basis-specific policy, geometry, epochs, ticket updates and cleanup without GUI', async ({
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
        ...(variant === 'store_not_web_enabled_acceptance_build'
          ? [
              '/DSPRINT_CODER_ELIGIBILITY_V2=1',
              '/DSPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD=1',
              '/DSPRINT_CODER_TEST_WINDOWS_STORE_NOTEPAD_NOT_WEB=1',
            ]
          : []),
        ...(variant === 'store_not_web_enabled_final_build'
          ? [
              'FROM_BUILD=1',
              'V2=1',
              'RULESET_VERSION=4',
              'CLASSIFIER_VERSION=3',
              'LEXICON_VERSION=3',
              'TICKET_REQUIRED=1',
              'INTERLOCK_ENFORCED=1',
            ].map((definition) => '/DSPRINT_CODER_ELIGIBILITY_' + definition)
          : []),
        ...(variant === 'explorer_gate_off_with_hooks'
          ? ['/DSPRINT_CODER_WINDOWS_EXPLORER_TEST_HOOKS=1']
          : []),
        ...(variant === 'explorer_gate_on'
          ? [
              '/DSPRINT_CODER_ELIGIBILITY_V2=1',
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
        'PASS: 68 component cases, controlled focus only, no OS input',
      );
      expect(result.stdout).toContain(
        variant.startsWith('store_not_web_enabled_')
          ? 'CASE:store-notepad-start-rejudge-changed-key'
          : 'CASE:store_not_web_is_absent_in_default_build',
      );
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 540000);
});

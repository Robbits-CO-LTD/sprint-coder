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
  join(nativeDirectory, 'computer_use_windows_background_observe_test.cc'),
  'utf8',
);
function componentSource(): string {
  const begin = source.indexOf('bool ObserveWindowsWindow(');
  const end = source.indexOf('// BEGIN artifact read', begin);
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);
  let observe = source.slice(begin, end);
  const functions: Record<string, string> = {
    ValidateWindowsObservationSession: 'ObserveValidate',
    ReadUiaObservation: 'ObserveTree',
    CaptureWindowsControlBindings: 'ObserveBindings',
    ClassifyWindowsFocusedElement: 'ObserveFocus',
    WindowsFocusedElementSignature: 'ObserveSignature',
    ScreenBoundsPhysicalForWindow: 'ObserveScreen',
    CaptureWindowWithGraphicsCapture: 'ObserveCapture',
    ReadWindowsPngPatchGrid: 'ObservePng',
  };
  for (const [name, replacement] of Object.entries(functions)) {
    expect(observe).toContain(name + '(');
    observe = observe.replaceAll(name + '(', replacement + '(');
  }
  expect(observe).not.toMatch(
    /\b(?:SetForegroundWindow|ShowWindow|SetFocus|SetCursorPos|SendInput|GetForegroundWindow)\(/u,
  );
  return source.slice(0, begin) + observe + source.slice(end);
}

it('runs the production observation publisher with target-only read substitutions', () => {
  expect(componentSource()).toContain('session.observation_revision = next_revision;');
  expect(program.match(/Run\((?:true|false)\)/gu)).toHaveLength(7);
});
describe.skipIf(process.platform !== 'win32')(
  'Windows background observation component matrix',
  () => {
    it('preserves foreground focus and refuses incomplete background observations', async ({
      skip,
    }) => {
      const build = findBuild();
      if (!build) {
        if (process.env.CI) throw new Error('MSVC required');
        skip();
        return;
      }
      const root = mkdtempSync(join(tmpdir(), 'sc-background-observe-components-'));
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
        expect(result.stdout).toContain('PASS: 8 background observation component cases');
      } finally {
        rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      }
    }, 540000);
  },
);

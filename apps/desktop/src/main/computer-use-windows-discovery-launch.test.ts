import { execFile, spawnSync } from 'node:child_process';
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
import { computerUseNativeDiscoveryStopReceiptSchema } from '@sprint-coder/contracts';
const nativeDirectory = join(__dirname, '../../computer-use-native');
const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
type Build = Readonly<{
  wrap: (arguments_: string[]) => { file: string; args: string[]; verbatim: boolean };
}>;

// A long synchronous compiler/native run prevents the worker from receiving Vitest RPC replies.
function runNative(
  file: string,
  args: string[],
  options: {
    encoding: 'utf8';
    timeout: number;
    windowsVerbatimArguments?: boolean;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      resolve({
        status: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
        stdout,
        stderr: stderr || error?.message || '',
      });
    });
  });
}

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

const source = readFileSync(join(nativeDirectory, 'computer_use_windows_host.cc'), 'utf8');
const program = readFileSync(
  join(nativeDirectory, 'computer_use_windows_discovery_launch_test.cc'),
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
  const launchFrom = source.indexOf('bool LaunchVerifiedExecutable(');
  const launchTo = source.indexOf('// BEGIN windows v2 targets', launchFrom);
  expect(launchFrom).toBeGreaterThan(0);
  expect(launchTo).toBeGreaterThan(launchFrom);
  let launch = source.slice(launchFrom, launchTo);
  launch = replaceOne(
    launch,
    '  if (claim && !claim()) return false;',
    '  FixtureBeforeClaim();\n  if (claim && !claim()) return false;',
  );
  launch = replaceOne(launch, 'CreateProcessW(', 'FixtureCreate(');
  launch = replaceOne(
    launch,
    'OpenLockedProcessExecutable(child.process.value, &launched_image)',
    'FixtureImage(child.process.value, &launched_image)',
  );
  launch = replaceOne(
    launch,
    'TerminateProcess(process.value, ERROR_INVALID_IMAGE_HASH)',
    'FixtureTerminate(process.value, ERROR_INVALID_IMAGE_HASH)',
  );
  let generated = source.slice(0, launchFrom) + launch + source.slice(launchTo);
  const measureFrom = generated.indexOf('bool MeasureWindowsDiscovery(');
  const measureTo = generated.indexOf(
    '// END windows cancellable discovery measurement',
    measureFrom,
  );
  expect(measureFrom).toBeGreaterThan(0);
  expect(measureTo).toBeGreaterThan(measureFrom);
  let measure = generated.slice(measureFrom, measureTo);
  measure = replaceOne(
    measure,
    'IsSupportedWindowsV1Target(current_executable.identity)',
    'FixtureSupported(current_executable.identity)',
  );
  expect(measure.split('EnumerateWindowsForExecutable(')).toHaveLength(3);
  measure = measure.replaceAll('EnumerateWindowsForExecutable(', 'FixtureEnumerate(');
  generated = generated.slice(0, measureFrom) + measure + generated.slice(measureTo);
  generated = replaceOne(
    generated,
    '    std::thread([pending, lease, metadata, serial]() mutable {',
    '    std::thread([pending, lease, metadata, serial]() mutable {\n      FixtureWorkerStarted();',
  );
  generated = replaceOne(
    generated,
    '  DrainWindowsDiscoveryLaunchesForExit();',
    '  if (FixtureRetainLaunchOnExit()) DrainWindowsDiscoveryLaunchesForExit();',
  );
  return generated
    .replaceAll('ShowWindow(', 'RefuseShow(')
    .replaceAll('SetForegroundWindow(', 'RefuseFocus(')
    .replaceAll('SendInput(', 'RefuseInput(');
}

it('keeps launch guards and real image/exit work while limiting qualification to the owned fixture', () => {
  const generated = componentSource();
  expect(generated).toContain('owner->launch_in_flight = true');
  expect(generated).toContain('WaitForSingleObject(process.value, INFINITE)');
  expect(program).toContain('flags | CREATE_NO_WINDOW');
  expect(program).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE');
});

describe.skipIf(process.platform !== 'win32')('Windows discovery launch lifetime component', () => {
  it('orders Stop against launch claims and confirms failed child exit before terminal evidence', async ({
    skip,
  }) => {
    const build = findBuild();
    if (!build) {
      if (process.env.CI) throw new Error('MSVC required');
      skip();
      return;
    }
    const root = mkdtempSync(join(tmpdir(), 'sc-discovery-launch-'));
    try {
      writeFileSync(join(root, 'launch-host.cc'), componentSource());
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
      const compiled = await runNative(command.file, command.args, {
        encoding: 'utf8',
        windowsVerbatimArguments: command.verbatim,
        timeout: 500000,
        env: { ...process.env, VSLANG: '1033' },
      });
      expect(compiled.status, compiled.stdout + '\n' + compiled.stderr).toBe(0);

      for (const mode of [
        'observer-rights',
        'normal',
        'create-failure',
        'before-claim',
        'claim-before-api',
        'after-create-read',
        'image-mismatch',
        'termination-unconfirmed',
        'post-create-exception',
        'helper-exit-control',
        'helper-exit-mismatch',
        'helper-exit-verified',
      ]) {
        const result = await runNative(realpathSync.native(binary), [mode], {
          encoding: 'utf8',
          timeout: 90000,
        });
        expect(result.status, mode + '\n' + result.stdout + '\n' + result.stderr).toBe(0);
        if (mode === 'observer-rights') {
          expect(result.stdout).toContain('PASS: old observer lacks PID query access');
          console.log('native_discovery_old_observer_rights: confirmed');
          continue;
        }
        if (mode === 'helper-exit-control') {
          expect(result.stdout).toContain(
            'CONTROL: normal helper exit abandoned held unverified child; observer cleaned it',
          );
          const state = result.stdout
            .split(/\r?\n/u)
            .find((line) => line.startsWith('CONTROLSTATE:'));
          const facts: unknown = JSON.parse(state!.slice('CONTROLSTATE:'.length));
          expect(facts).toEqual({ helperExit: 0, childAlive: true, reads: 0, terminations: 0 });
          console.log(JSON.stringify({ kind: 'native_discovery_helper_exit_control', facts }));
          continue;
        }
        if (mode.startsWith('helper-exit-')) {
          expect(result.stdout).toContain(
            'PASS: ' + mode + ' helper lifetime preserves launch ownership',
          );
          console.log(
            JSON.stringify({
              kind: 'native_discovery_helper_exit',
              case: mode,
              inputPerformed: false,
            }),
          );
          continue;
        }
        expect(result.stdout).toContain(
          'PASS: ' + mode + ' child cleanup, no OS input, no public qualification',
        );
        const lines = result.stdout.split(/\r?\n/u).filter((line) => line.startsWith('RECEIPT:'));
        expect(lines, mode).toHaveLength(1);
        const receipt = computerUseNativeDiscoveryStopReceiptSchema.parse(
          JSON.parse(lines[0]!.slice(8)),
        );
        expect(receipt.discoveryId).toBe('launch:' + mode);
        expect(receipt.launchAttemptCount).toBe(mode === 'before-claim' ? 0 : 1);
        console.log(
          JSON.stringify({
            kind: 'native_discovery_launch_component',
            case: mode,
            childExited: true,
            inputPerformed: false,
          }),
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 540000);
});

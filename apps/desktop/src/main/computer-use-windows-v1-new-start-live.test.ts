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
import { z } from 'zod';
import { computerUseNativeCloseReceiptSchema } from '@sprint-coder/contracts';
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

const source = readFileSync(join(nativeDirectory, 'computer_use_windows_host.cc'), 'utf8');
const program = readFileSync(
  join(nativeDirectory, 'computer_use_windows_v1_start_live_test.cc'),
  'utf8',
);
const resultSchema = z
  .object({
    measurement: z.enum(['PASS', 'NOT_RUN']),
    nativeStart: z.enum(['PASS', 'NOT_RUN']),
    reason: z.string().max(80),
    inputAttempts: z.number().int().nonnegative().optional(),
    childExited: z.literal(true),
    publicAppUi: z.literal('NOT_RUN').optional(),
  })
  .strict();

it('requires Store absence and verified ownership before resuming the real V1 fixture', () => {
  expect(program.indexOf('GetPackagesByPackageFamily(')).toBeLessThan(
    program.indexOf('CreateProcessAsUserW('),
  );
  expect(program.indexOf('AssignProcessToJobObject(')).toBeLessThan(
    program.indexOf('ResumeThread('),
  );
  expect(program.indexOf('exact running image before execution')).toBeLessThan(
    program.indexOf('ResumeThread('),
  );
  expect(program).toContain('GetForegroundWindow() == window');
  expect(program).not.toMatch(/SetForegroundWindow\(|ShowWindow\(|SendInput\(/u);
});

describe.skipIf(process.platform !== 'win32')('Windows real V1 new-start measurement', () => {
  it('measures an owned signed target and separately records the native Start prerequisite', ({
    skip,
  }) => {
    const build = findBuild();
    if (!build) {
      if (process.env.CI) throw new Error('MSVC required');
      skip();
      return;
    }
    const root = mkdtempSync(join(tmpdir(), 'sc-v1-real-start-'));
    try {
      writeFileSync(join(root, 'live-host.cc'), source);
      const file = join(root, 'live.cc'),
        binary = join(root, 'live.exe');
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
        '/DSPRINT_CODER_ELIGIBILITY_V2=0',
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
      const rows = result.stdout.split(/\r?\n/u).filter((line) => line.startsWith('RESULT:'));
      expect(rows).toHaveLength(1);
      const measured = resultSchema.parse(JSON.parse(rows[0]!.slice(7)));
      console.log(JSON.stringify({ ...measured, kind: 'native_v1_owned_target' }));
      if (measured.measurement === 'NOT_RUN') {
        if (process.env.CI) throw new Error(`Real V1 measurement unavailable: ${measured.reason}`);
        skip();
        return;
      }
      expect(measured.measurement).toBe('PASS');
      const receipts = result.stdout.split(/\r?\n/u).filter((line) => line.startsWith('RECEIPT:'));
      if (measured.nativeStart === 'PASS') {
        expect(receipts).toHaveLength(1);
        const receipt = computerUseNativeCloseReceiptSchema.parse(
          JSON.parse(receipts[0]!.slice(8)),
        );
        expect(receipt.sessionId).toBe('v1-owned-notepad');
        expect(receipt.inputAttemptCount).toBe(measured.inputAttempts);
        expect(receipt.cancelEpoch).toBeGreaterThan(0);
      } else {
        expect(measured.reason).toBe('owned_window_not_foreground');
        expect(receipts).toHaveLength(0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 540000);
});

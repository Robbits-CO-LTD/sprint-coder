import { findBuild } from './test-support/msvc-build';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { computerUseNativeCloseReceiptSchema } from '@sprint-coder/contracts';
import { readWindowsHostSource } from '../../../../computer-use-windows-host-source.mjs';
const nativeDirectory = join(__dirname, '../../computer-use-native');

const source = readWindowsHostSource();
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
  let root: string | undefined;
  let binary: string | undefined;
  beforeAll(() => {
    const build = findBuild();
    if (!build) {
      if (process.env.CI) throw new Error('MSVC required');
      return;
    }
    root = mkdtempSync(join(tmpdir(), 'sc-v1-real-start-'));
    writeFileSync(join(root, 'live-host.cc'), source);
    const file = join(root, 'live.cc');
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
  }, 540000);
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it('joins the pipe thread and reports an unexpected handshake reply', ({ skip }) => {
    if (!binary) {
      skip();
      return;
    }
    const cleanup = spawnSync(realpathSync.native(binary), ['--handshake-failure'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(cleanup.status, cleanup.stdout + '\n' + cleanup.stderr).toBe(1);
    expect(cleanup.stderr).toContain('FAIL: bound native reply');
    console.log('native_v1_handshake_failure_cleanup: PASS');
  });

  it('measures an eligible owned target and reports missing environment prerequisites', ({
    skip,
  }) => {
    if (!binary) {
      skip();
      return;
    }
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
      expect(['store_notepad_present', 'v1_baseline_not_eligible']).toContain(measured.reason);
      skip();
      return;
    }
    expect(measured.measurement).toBe('PASS');
    const receipts = result.stdout.split(/\r?\n/u).filter((line) => line.startsWith('RECEIPT:'));
    if (measured.nativeStart === 'PASS') {
      expect(receipts).toHaveLength(1);
      const receipt = computerUseNativeCloseReceiptSchema.parse(JSON.parse(receipts[0]!.slice(8)));
      expect(receipt.sessionId).toBe('v1-owned-notepad');
      expect(receipt.inputAttemptCount).toBe(measured.inputAttempts);
      expect(receipt.cancelEpoch).toBeGreaterThan(0);
    } else {
      expect(measured.reason).toBe('owned_window_not_foreground');
      expect(receipts).toHaveLength(0);
    }
  }, 130000);
});

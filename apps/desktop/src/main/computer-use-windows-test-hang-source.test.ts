import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readWindowsHostSource,
  windowsHostNativeDirectory,
} from '../../../../computer-use-windows-host-source.mjs';

const flag = 'SPRINT_CODER_COMPUTER_USE_TEST_HANG';
const root = join(__dirname, '../../../..');
const hooks = [
  ['WindowsV1UiaTimed(', 'UiaCall', 'HRESULT result = call();'],
  ['InvokeWindowsSemanticInput(', 'SemanticPattern', 'struct Returned {'],
  [
    'CaptureWindowWithGraphicsCaptureOnWorker(',
    'Capture',
    'const auto frame = frame_pool.TryGetNextFrame();',
  ],
  ['ReadAuthenticodeSignerDigest(', 'WinVerifyTrust', 'const LONG verified = WinVerifyTrust('],
  ['OpenLockedWindowsExecutable(', 'CreateFileW', 'ScopedKernelHandle file(CreateFileW('],
] as const;

describe('Windows test-only hang hooks', () => {
  it.each(hooks)('guards the single %s hook at its intended boundary', (name, point, call) => {
    const source = readWindowsHostSource();
    const block = `#if defined(${flag})\n  WindowsTestHang(WindowsTestHangPoint::${point});\n#endif`;
    const normalized = source.replace(/^ {4}WindowsTestHang/gmu, '  WindowsTestHang');
    expect(normalized.split(block)).toHaveLength(2);
    const start = normalized.indexOf(name);
    const hook = normalized.indexOf(block);
    expect(start).toBeGreaterThan(-1);
    expect(hook).toBeGreaterThan(start);
    expect(
      normalized
        .slice(hook + block.length)
        .trimStart()
        .startsWith(call),
    ).toBe(true);
    if (point === 'SemanticPattern') {
      expect(normalized.slice(start, hook)).toContain('pending->input_in_flight = true;');
      expect(normalized.slice(start, hook)).toContain('*accepted = true;');
      expect(normalized.slice(start, hook).trimEnd().endsWith('*accepted = true;\n  }')).toBe(true);
      expect(normalized.slice(hook).replace(/\s+/gu, ' ')).toContain(
        '} returned{pending}; return call();',
      );
    }
  });

  it('keeps the entire header behind the flag, with production guards and a retained marker', () => {
    const header = readFileSync(
      join(windowsHostNativeDirectory, 'computer_use_windows_test_hang.h'),
      'utf8',
    );
    expect(header.trimStart().startsWith(`#if defined(${flag})\n`)).toBe(true);
    expect(header.trimEnd().endsWith('#endif')).toBe(true);
    expect(header).toMatch(
      /#if defined\(SPRINT_CODER_ELIGIBILITY_FROM_BUILD\) \|\|\s*\\?\s*defined\(SPRINT_CODER_REQUIRE_WINDOWS_GRAPHICS_CAPTURE\)\s*\n#error/u,
    );
    expect(header).toContain('SPRINT_CODER_COMPUTER_USE_TEST_HANG_MARKER');
    expect(header).toContain('__declspec(dllexport)');
    expect(header).toContain('GetModuleFileNameW(nullptr,');
    expect(header).toContain('sprint-coder-test-hang.txt');
    expect(header).toContain('WaitForSingleObject(event, INFINITE)');
    expect(header).not.toMatch(/SetEvent|GetEnvironmentVariable/u);
    for (const [, point] of hooks) expect(header).toContain(point);
    const source = readWindowsHostSource();
    expect(source.split('#include "computer_use_windows_test_hang.h"')).toHaveLength(2);
    expect(source.indexOf('#include "computer_use_windows_test_hang.h"')).toBeLessThan(
      source.indexOf('namespace {'),
    );
    expect(source.match(/#if defined\(SPRINT_CODER_COMPUTER_USE_TEST_HANG\)/gu)).toHaveLength(5);
  });

  it('never enables the flag in production build inputs or any workflow', () => {
    const files = [
      'build-computer-use-native.mjs',
      ...readdirSync(join(root, '.github/workflows')).map((name) => `.github/workflows/${name}`),
    ];
    for (const file of files)
      expect(readFileSync(join(root, file), 'utf8'), file).not.toContain(flag);
  });

  it('checks the native gate, release builds and both packaged release paths', () => {
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    const release = readFileSync(join(root, '.github/workflows/release-beta.yml'), 'utf8');
    const acceptance = readFileSync(
      join(root, '.github/workflows/computer-use-acceptance-build.yml'),
      'utf8',
    );
    const command = 'node verify-computer-use-test-hang-absent.mjs --require';
    expect(ci).toContain(`if: runner.os == 'Windows'\n        run: ${command}`);
    expect(ci.indexOf(command)).toBeGreaterThan(
      ci.indexOf('run: npm run build:computer-use-native'),
    );
    expect(release.split(command)).toHaveLength(4);
    expect(release.split(`${command} --out=apps/desktop/out`)).toHaveLength(3);
    expect(acceptance).toContain(`${command} --out=apps/desktop/out`);
    expect(acceptance.indexOf(command)).toBeGreaterThan(acceptance.indexOf('npm run make:windows'));
  });
});

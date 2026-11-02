import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readWindowsHostSource,
  windowsHostNativeDirectory,
} from '../../../../computer-use-windows-host-source.mjs';

const flag = 'SPRINT_CODER_COMPUTER_USE_TEST_HANG';
const root = join(__dirname, '../../../..');
function job(source: string, name: string) {
  const block = source.split(`\n  ${name}:\n`)[1];
  if (block === undefined) throw new Error(`Missing job: ${name}`);
  return block.split(/\n  [\w-]+:\n/u)[0] ?? '';
}
function step(source: string, name: string) {
  const block = source.split(`      - name: ${name}\n`)[1];
  if (block === undefined) throw new Error(`Missing step: ${name}`);
  return block.split('      - name: ')[0] ?? '';
}
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
    expect(header).toMatch(/#if !SPRINT_CODER_HAS_WINDOWS_GRAPHICS_CAPTURE\s*\n#error/u);
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
    for (const value of [0, 1]) {
      const define = source.indexOf(`#define SPRINT_CODER_HAS_WINDOWS_GRAPHICS_CAPTURE ${value}`);
      expect(define).toBeGreaterThan(-1);
      expect(define).toBeLessThan(source.indexOf('#include "computer_use_windows_test_hang.h"'));
    }
    expect(source.match(/#if defined\(SPRINT_CODER_COMPUTER_USE_TEST_HANG\)/gu)).toHaveLength(5);
  });

  it('caches the sidecar path but rereads selections and diagnoses unknown nonempty names', () => {
    const header = readFileSync(
      join(windowsHostNativeDirectory, 'computer_use_windows_test_hang.h'),
      'utf8',
    );
    const initialization = header
      .split('static const std::wstring sidecar = [] {')[1]
      ?.split('}();')[0];
    expect(initialization).toContain('GetModuleFileNameW');
    expect(initialization).toContain('wchar_t executable[32768]');
    expect(initialization).toContain('sprint-coder-test-hang.txt');
    expect(header.indexOf('ReadFile(')).toBeGreaterThan(header.indexOf('}();'));
    for (const [, point] of hooks) expect(header).toContain(`selected != "${point}"`);
    expect(header).toContain('OutputDebugStringA(');
    expect(header).toContain('std::fputs(message, stderr)');
    expect(header).toContain('count == sizeof(bytes)');
    expect(header).toContain('470 ms');
    expect(header).toContain('accessibility_timeout');
  });

  it('never enables the flag in production build inputs or any workflow', () => {
    const files = [
      'build-computer-use-native.mjs',
      'native-build-environment.mjs',
      'build-computer-use-eligibility.mjs',
      'apps/desktop/forge.config.ts',
      'apps/desktop/computer-use-native/binding.gyp',
      ...readdirSync(join(root, 'apps/desktop/scripts')).map(
        (name) => `apps/desktop/scripts/${name}`,
      ),
      ...readdirSync(join(root, '.github/workflows')).map((name) => `.github/workflows/${name}`),
    ];
    for (const file of files)
      expect(readFileSync(join(root, file), 'utf8'), file).not.toContain(flag);
    for (const file of ['package.json', 'apps/desktop/package.json']) {
      const { scripts } = JSON.parse(readFileSync(join(root, file), 'utf8'));
      expect(JSON.stringify(scripts), file).not.toContain(flag);
    }
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
    for (const [jobName, buildName, checkName, buildCommand, packaged] of [
      [
        'make',
        'Build Computer Use native artifact for Gate 0',
        'Reject test hang hooks in the Windows helper',
        'npm run build:computer-use-native',
        false,
      ],
      [
        'make',
        'Make and verify unsigned Windows release artifacts',
        'Reject test hang hooks in Windows release artifacts',
        'npm run make:windows',
        true,
      ],
      [
        'make-windows-signed',
        'Make signed Windows gate artifacts',
        'Reject test hang hooks in signed Windows release artifacts',
        'npm run make:windows',
        true,
      ],
    ] as const) {
      const block = job(release, jobName);
      expect(step(block, buildName)).toContain(buildCommand);
      const check = step(block, checkName);
      expect(check).toContain("if: runner.os == 'Windows'");
      expect(check).toContain(`run: ${command}${packaged ? ' --out=apps/desktop/out' : ''}\n`);
      expect(block.indexOf(`- name: ${checkName}\n`)).toBeGreaterThan(
        block.indexOf(`- name: ${buildName}\n`),
      );
    }
    expect(acceptance).toContain(`${command} --out=apps/desktop/out`);
    expect(acceptance.indexOf(command)).toBeGreaterThan(acceptance.indexOf('npm run make:windows'));
  });

  it('checks CI Windows packages after packaging and before upload', () => {
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    for (const [jobName, buildName] of [
      ['package-windows-build', 'Build the shared Windows production package'],
      ['package-windows', 'Make Windows wizard installer'],
    ] as const) {
      const block = job(ci, jobName);
      const checkName = 'Reject test hang hooks in Windows package artifacts';
      expect(step(block, checkName)).toContain(
        'run: node verify-computer-use-test-hang-absent.mjs --require --out=apps/desktop/out',
      );
      expect(step(block, checkName)).not.toMatch(/\bif:|working-directory:/u);
      expect(block.indexOf(checkName)).toBeGreaterThan(block.indexOf(buildName));
      if (jobName === 'package-windows-build') {
        expect(block.indexOf(checkName)).toBeLessThan(
          block.indexOf('Upload the shared Windows production package'),
        );
      }
    }
  });
});

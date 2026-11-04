import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computerWindowsTargetFactsSchema } from '@sprint-coder/contracts';
import { nativeAcceptanceBuildHeader } from '../../../../build-computer-use-acceptance.mjs';
import { computerUseAcceptanceBuildForEnv } from '../../computer-use-acceptance-build';
import {
  assertComputerUseAcceptanceBuildAllowed,
  assertPackagedComputerUseAcceptanceConsistency,
  writeComputerUseAcceptanceBuildReceipt,
} from '../../forge.config';
import {
  computerUseBackgroundAcceptanceOptions,
  computerUseWindowsSignerWaived,
} from './computer-use-acceptance-mode';
import { backgroundAcceptanceTargetVerdict } from './computer-use-native-targets';
import { classifyTarget } from './computer-use-target-eligibility';

const mode = 'windows-background-acceptance';
const flag = 'SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD';
const roots: string[] = [];
const source = (name: string) =>
  readFileSync(join(__dirname, '../../computer-use-native', name), 'utf8');
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function build() {
  const root = mkdtempSync(join(tmpdir(), 'sc-background-acceptance-'));
  roots.push(root);
  const path = join(root, 'fixture.exe');
  // Minimal synthetic PE metadata, not executable code; these tests never start a process.
  const bytes = Buffer.alloc(256);
  bytes.write('MZ');
  bytes.writeUInt32LE(64, 60);
  bytes.write('PE\0\0', 64);
  bytes.writeUInt16LE(2, 156);
  writeFileSync(path, bytes);
  const environment = { [flag]: mode, SPRINT_CODER_BACKGROUND_ACCEPTANCE_FIXTURE: path };
  const compiled = computerUseAcceptanceBuildForEnv(environment, 'win32')!;
  vi.stubGlobal('__SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD__', compiled);
  return { compiled, environment, path, bytes };
}

function facts() {
  const golden: unknown = JSON.parse(source('target-eligibility-golden.json'));
  if (!golden || typeof golden !== 'object' || !('base' in golden)) throw new Error('Missing base');
  return {
    ...computerWindowsTargetFactsSchema.parse(golden.base),
    imageRoot: 'other' as const,
    imageLeaf: 'fixture.exe',
    imageRelativePath: 'fixture.exe',
    signature: 'unsigned' as const,
    windowClass: 'P7aFixture',
    peSubsystem: 'gui' as const,
  };
}

describe('P7b background acceptance build', () => {
  it('records the background fixture digest and checks it against packaged Main bytes', () => {
    const { compiled, environment, path } = build();
    const sourceCommit = 'a'.repeat(40);
    expect(
      writeComputerUseAcceptanceBuildReceipt(dirname(path), 'win32', sourceCommit, environment),
    ).toBe(true);
    const receipt = JSON.parse(
      readFileSync(join(dirname(path), 'computer-use-acceptance-build.json'), 'utf8'),
    );
    expect(receipt).toEqual({ mode, sourceCommit, fixtureDigest: compiled.fixtureDigest });
    const main = JSON.stringify(compiled);
    expect(() =>
      assertPackagedComputerUseAcceptanceConsistency(main, true, mode, receipt),
    ).not.toThrow();
    for (const fixtureDigest of [undefined, 'b'.repeat(64), 'A'.repeat(64), 'a'.repeat(63), 123]) {
      expect(() =>
        assertPackagedComputerUseAcceptanceConsistency(main, true, mode, {
          ...receipt,
          fixtureDigest,
        }),
      ).toThrow('fixtureDigest');
    }
    expect(() => assertPackagedComputerUseAcceptanceConsistency(main, false, mode)).toThrow();
    expect(() =>
      assertPackagedComputerUseAcceptanceConsistency(
        JSON.stringify({ ...compiled, fixtureDigest: undefined }),
        true,
        mode,
        receipt,
      ),
    ).toThrow('fixtureDigest');
  });

  it('preserves BG-8 focus_required for unsupported new starts in acceptance builds', () => {
    const targets = source('computer_use_windows_host_v2_targets.inc');
    const start = targets.slice(
      targets.indexOf('bool StartWindowsNewSession('),
      targets.indexOf('bool StartWindowsExistingSession('),
    );
    expect(start).toContain(
      'const bool background = background_gate && foreground != input.window;',
    );
    expect(start).toMatch(
      /if \(background && !WindowsBackgroundTargetSupported\(measured.executable\)\) \{\s*\*reason = "focus_required";\s*return false;/u,
    );
    expect(start).toContain('if (!background_gate && GetForegroundWindow() != input.window)');
  });

  it('filters fixture facts and denials before acquiring executable identity', () => {
    const targets = source('computer_use_windows_host_v2_targets.inc');
    const acceptance = targets.slice(
      targets.indexOf(
        '#if SPRINT_CODER_WINDOWS_BACKGROUND_ACCEPTANCE',
        targets.indexOf('WindowsV2VerdictForWindowClass('),
      ),
      targets.indexOf(
        '#endif',
        targets.indexOf(
          '#if SPRINT_CODER_WINDOWS_BACKGROUND_ACCEPTANCE',
          targets.indexOf('WindowsV2VerdictForWindowClass('),
        ),
      ),
    );
    expect(acceptance).toMatch(
      /if \(WindowsBackgroundFixtureFactsVerdict\(for_window.facts\).kind == TargetVerdictKind::kEligible &&\s*!IsKnownProxyExecutable\(for_window.image_path\) &&\s*!IsDisallowedTargetExecutable\(for_window.image_path\) && !IsProcessElevated\(for_window.pid\) &&\s*EnsureWindowsV2Identity\(process\)\)/u,
    );
    expect(acceptance).toContain('WindowsBackgroundFixtureVerdict(for_window.facts,');
    const cheap = targets.slice(
      targets.indexOf('WindowsBackgroundFixtureFactsVerdict('),
      targets.indexOf('WindowsBackgroundFixtureVerdict('),
    );
    for (const condition of [
      '!TargetFactsAreComplete(facts)',
      'facts.platform != TargetPlatform::kWin32',
      'facts.running_image_matches != true',
      'facts.image_volume != "fixed"',
      'facts.signature != "unsigned"',
      'facts.packaged != std::optional<bool>(false)',
      'facts.pe_subsystem != "gui"',
      'facts.window_class != "P7aFixture"',
      'return ClassifyTarget(scoped);',
    ])
      expect(cheap).toContain(condition);
    expect(cheap).not.toMatch(/digest|EnsureWindowsV2Identity/u);
    expect(targets).toMatch(
      /if \(!WindowsBackgroundFixtureDigestMatches\(digest\)\) return \{\};\s*return WindowsBackgroundFixtureFactsVerdict\(facts\);/u,
    );
  });

  it('pins identical fixture bytes in Main and native while including unsigned acceptance', () => {
    const { compiled, environment, bytes } = build();
    const digest = createHash('sha256').update(bytes).digest('hex');
    expect(compiled.fixtureDigest).toBe(digest);
    expect(nativeAcceptanceBuildHeader(environment, 'win32')).toContain(`SHA256 "${digest}"`);
    expect(nativeAcceptanceBuildHeader(environment, 'win32')).toContain(`${flag} 1`);
    expect(computerUseWindowsSignerWaived('win32', null)).toBe(true);
    expect(computerUseWindowsSignerWaived('win32', 'signed')).toBe(false);
    expect(computerUseWindowsSignerWaived('darwin', null)).toBe(false);
    expect(computerUseBackgroundAcceptanceOptions()).toEqual({
      windowsBackgroundInputForTesting: true,
    });
    const main = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    expect(main).toMatch(
      /createComputerUseNativeHost\([\s\S]*?\.\.\.computerUseBackgroundAcceptanceOptions\(\)/u,
    );
  });

  it('fails closed for missing pins, console fixtures and non-Windows build hosts', () => {
    expect(() => computerUseAcceptanceBuildForEnv({ [flag]: mode }, 'win32')).toThrow();
    const { environment, bytes, path } = build();
    expect(() => computerUseAcceptanceBuildForEnv(environment, 'darwin')).toThrow();
    expect(() => nativeAcceptanceBuildHeader(environment, 'darwin')).toThrow();
    bytes.writeUInt16LE(3, 156);
    writeFileSync(path, bytes);
    expect(() => computerUseAcceptanceBuildForEnv(environment, 'win32')).toThrow(/GUI/u);
    expect(() => nativeAcceptanceBuildHeader(environment, 'win32')).toThrow(/GUI/u);
  });

  it('keeps ordinary and unsigned-only builds closed despite runtime environment changes', () => {
    for (const compiled of [null, { mode: 'windows-unsigned-acceptance' }]) {
      vi.stubGlobal('__SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD__', compiled);
      vi.stubEnv(flag, mode);
      expect(computerUseBackgroundAcceptanceOptions()).toEqual({});
      expect(backgroundAcceptanceTargetVerdict(facts(), 'a'.repeat(64))).toEqual({
        kind: 'denied',
      });
    }
    expect(nativeAcceptanceBuildHeader({}, 'win32')).not.toContain('BACKGROUND_ACCEPTANCE 1');
    expect(
      nativeAcceptanceBuildHeader({ [flag]: 'windows-unsigned-acceptance' }, 'win32'),
    ).not.toContain('BACKGROUND_ACCEPTANCE 1');
  });

  it('refuses release packaging and detects the compiled marker after environment removal', () => {
    const { environment, compiled } = build();
    expect(() =>
      assertComputerUseAcceptanceBuildAllowed(
        { ...environment, SPRINT_CODER_RELEASE: '1' },
        'win32',
      ),
    ).toThrow(/never published/u);
    expect(() =>
      assertPackagedComputerUseAcceptanceConsistency(JSON.stringify(compiled), true, null),
    ).toThrow();
    const verify = readFileSync(
      join(__dirname, '../../scripts/verify-computer-use-acceptance-build.mjs'),
      'utf8',
    );
    expect(verify).toContain(compiled.marker);
    expect(verify).toContain("marked !== (expected === 'present')");
  });

  it('runs the release verifier against background acceptance bytes without packaging', async () => {
    const { compiled } = build();
    const script = readFileSync(
      join(__dirname, '../../scripts/verify-computer-use-acceptance-build.mjs'),
      'utf8',
    )
      .replace(/^#!.*$/mu, '')
      .replace(/^import .*;\r?$/gmu, '')
      .replace(
        "await import('@electron/asar')",
        'await Promise.resolve({ extractFile: fixtureExtractFile })',
      );
    const run = (expected: string, receipt: unknown = compiled) =>
      runInNewContext(`(async () => { ${script} })()`, {
        existsSync: () => true,
        readFileSync: () => JSON.stringify(receipt),
        readdirSync: () => [
          { name: 'app.asar', isSymbolicLink: () => false, isDirectory: () => false },
        ],
        statSync: () => ({ isFile: () => true }),
        dirname,
        join,
        resolve,
        fixtureExtractFile: () => Buffer.from(JSON.stringify(compiled)),
        console: { error: () => undefined, log: () => undefined },
        process: {
          argv: ['node', 'verify.mjs', '--expect', expected, '--out', '/synthetic'],
          exit: (code: number) => {
            throw new Error(`verifier exit ${code}`);
          },
        },
      });
    await expect(run('absent')).rejects.toThrow('verifier exit 1');
    await expect(run('present')).resolves.toBeUndefined();
    for (const fixtureDigest of [
      undefined,
      '',
      'A'.repeat(64),
      'a'.repeat(63),
      'a'.repeat(65),
      123,
    ]) {
      await expect(run('present', { mode, fixtureDigest })).rejects.toThrow('verifier exit 1');
    }
    await expect(run('present', { mode: 'windows-unsigned-acceptance' })).resolves.toBeUndefined();
  });

  it('admits only the pinned GUI fixture and rejudges changed facts without rewriting evidence', () => {
    const { compiled, path, bytes, environment } = build();
    const original = facts();
    const digest = compiled.fixtureDigest!;
    expect(classifyTarget(original)).toEqual({ kind: 'denied' });
    expect(backgroundAcceptanceTargetVerdict(original, digest)).toEqual({
      kind: 'eligible',
      maximumMode: 'full_access_app',
    });
    expect(original.signature).toBe('unsigned');
    expect(original.imageRoot).toBe('other');
    expect(backgroundAcceptanceTargetVerdict(original, 'b'.repeat(64))).toEqual({ kind: 'denied' });
    for (const change of [
      { runningImageMatches: false },
      { tokenElevated: true },
      { tokenOtherUser: true },
      { tokenOtherSession: true },
      { ownDescendant: true },
      { descendantShell: true },
      { imageVolume: 'network' as const },
      { imageRoot: 'self_install' as const },
      { peSubsystem: 'console' as const },
      { windowClass: 'Other' },
    ])
      expect(backgroundAcceptanceTargetVerdict({ ...original, ...change }, digest).kind).not.toBe(
        'eligible',
      );
    bytes[200] = 1;
    writeFileSync(path, bytes);
    const rebuilt = computerUseAcceptanceBuildForEnv(environment, 'win32')!;
    expect(rebuilt.fixtureDigest).not.toBe(digest);
    expect(backgroundAcceptanceTargetVerdict(original, rebuilt.fixtureDigest!)).toEqual({
      kind: 'denied',
    });
  });

  it('connects native start, rejudge, pre-input and provider checks to the same build pin', () => {
    const targets = source('computer_use_windows_host_v2_targets.inc');
    expect(targets).toContain('WindowsBackgroundFixtureVerdict(for_window.facts,');
    expect(targets).toContain('WindowsBackgroundFixtureDigestMatches(identity.executable_digest)');
    expect(targets).toContain('JudgeWindowsV2Target(work.pid, work.window, context, &judged');
    expect(source('computer_use_windows_host_input.inc')).toContain(
      'WindowsBackgroundTargetSupported(current.identity)',
    );
    const semantic = source('computer_use_windows_host_uia_semantic.inc');
    expect(semantic).toContain(
      'WindowsBackgroundFixtureProviderMatches(executable.identity.executable_digest,',
    );
    expect(source('computer_use_windows_target_facts.h')).toContain('framework == "P7aSynthetic"');
    expect(source('computer_use_windows_target_facts.h')).toContain(
      'control_class == "P7aControl"',
    );
    expect(semantic).toContain('acceptance_executable = std::move(current)');
    expect(semantic).toContain(
      '#if SPRINT_CODER_BACKGROUND_EXECUTOR_TEST || SPRINT_CODER_WINDOWS_BACKGROUND_ACCEPTANCE',
    );
    expect(source('computer_use_protocol.h')).toContain(
      '#else\ninline constexpr bool kWindowsBackgroundInputEnabled = false;',
    );
    expect(source('fixtures/background-input/fixture.cc')).toContain('int WINAPI wWinMain(');
  });
});

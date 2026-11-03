import { readWindowsHostSource } from '../../../../computer-use-windows-host-source.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const nativeDirectory = join(__dirname, '../../computer-use-native');
const native = (name: string): string => readFileSync(join(nativeDirectory, name), 'utf8');
const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
type Build = Readonly<{
  wrap: (arguments_: string[]) => { file: string; args: string[]; verbatim: boolean };
}>;

// The same MSVC discovery as the *-component tests: cl.exe on PATH, else vcvars64 from vswhere.
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

describe('background executor native entry', () => {
  it('connects semantic scroll to timed single-call execution and native readback tests', () => {
    const executor = native('computer_use_windows_background_executor.h');
    const semantic = native('computer_use_windows_host_uia_semantic.inc');
    expect(executor).toContain('PrepareScroll');
    expect(executor).toContain('ScrollMatches');
    expect(executor).toContain('timed([&] { return scroll->Scroll(horizontal, vertical); })');
    expect(executor).toContain('scroll->SetScrollPercent(horizontal_percent, vertical_percent)');
    expect(semantic).toContain('work.kind == "semantic_scroll"');
    // The background dispatch entry routes semantic_scroll to the executor, not to a handoff.
    const input = native('computer_use_windows_host_input.inc');
    const background = input.slice(
      input.indexOf('if (!RevalidateWindowsTarget(session, bounds, expected_epoch)) {'),
    );
    expect(background.slice(0, background.indexOf('#endif'))).toContain(
      'kind != "semantic_scroll"',
    );
    expect(semantic).toContain('UIA_ScrollPatternId');
    expect(semantic).toContain('windows_background_executor_detail::CallScroll(');
    expect(semantic).toContain('return WindowsV1UiaContact(result, call);');
    expect(native('computer_use_protocol_fuzz.cc')).toContain('CheckBackgroundScroll()');
    const tests = native('computer_use_windows_background_executor_test.h');
    for (const name of [
      'BG01_scroll_units_and_readback',
      'BG01_scroll_same_percent_noop',
      'BG06_scroll_unknown_never_retries_or_falls_back',
    ]) {
      expect(tests).toContain(name);
    }
    expect(executor).not.toContain('ScrollIntoView(');
    const adapter = semantic.slice(
      semantic.indexOf('struct WindowsBackgroundPatternOperations'),
      semantic.indexOf('// END background pattern adapter'),
    );
    expect(adapter).not.toMatch(/ScrollIntoView|SendInput|SetFocus|SetCursorPos/u);
  });

  it('routes every background pattern effect through the V1 timed contact', () => {
    const executor = native('computer_use_windows_background_executor.h');
    const semantic = native('computer_use_windows_host_uia_semantic.inc');
    expect(executor.match(/->(?:Invoke|Toggle|Select|SetValue|Expand|Collapse)\(/gu)).toHaveLength(
      6,
    );
    expect(
      executor.match(
        /timed\(\[&\] \{ return \w+->(?:Invoke|Toggle|Select|SetValue|Expand|Collapse)\(/gu,
      ),
    ).toHaveLength(6);
    expect(semantic).toContain('windows_background_executor_detail::CallPattern(');
    expect(semantic).toContain('return WindowsV1UiaContact(result, call);');
  });

  it('registers the BG01 BG05 BG06 native regression cases', () => {
    expect(native('computer_use_protocol_fuzz.cc')).toContain('CheckBackgroundExecutor()');
    const tests = native('computer_use_windows_background_executor_test.h');
    for (const name of [
      'BG01_background_forbidden_api_attempts_zero',
      'BG01_invoke_checks_window_not_old_content',
      'BG01_pattern_readback_and_noop',
      'BG06_claimed_uia_never_retries_or_falls_back',
      'BG05_unissued_action_requires_handoff',
      'BG05_guard_failure_never_falls_back',
      'BG01_call_pattern_one_timed_provider_call',
      'BG01_real_device_completed_blocked_until_own_call_attribution',
    ]) {
      expect(tests).toContain(name);
    }
  });

  it('keeps the executor behind a closed build gate and connects monitor boundaries', () => {
    const semantic = native('computer_use_windows_host_uia_semantic.inc');
    expect(semantic).toContain('#if SPRINT_CODER_BACKGROUND_EXECUTOR_TEST');
    expect(semantic).toContain('background_monitor->state.Claim(');
    expect(semantic).toContain('background_monitor->state.Finish(');
    expect(semantic).toContain('RunBackgroundExecutor(operations)');
    expect(native('computer_use_windows_background_executor.h')).toContain(
      '#define SPRINT_CODER_BACKGROUND_EXECUTOR_TEST 0',
    );
    expect(native('computer_use_windows_host_input.inc')).toContain('awaiting_foreground_handoff');
  });

  it('passes SetValue a BSTR and claims under the foreground claim boundary set', () => {
    const semantic = native('computer_use_windows_host_uia_semantic.inc');
    const start = semantic.indexOf('struct WindowsBackgroundPatternOperations');
    const adapter = semantic.slice(
      start,
      semantic.indexOf('// END background pattern adapter', start),
    );
    expect(adapter).toContain('SysAllocStringLen(text.data(), static_cast<UINT>(text.size()))');
    expect(adapter).toContain('if (allocated == nullptr) return Preparation::kRejected;');
    expect(adapter).toContain('*text_value.Receive(), desired,');
    expect(adapter).not.toContain('text.c_str()');
    expect(adapter).toContain('SecureZeroMemory(allocated, SysStringByteLen(allocated))');
    const claim = adapter.slice(
      adapter.indexOf('std::uint64_t Claim()'),
      adapter.indexOf('bool Call()'),
    );
    expect(claim).toContain(
      '(pending->round_trip && !pending->round_trip->MayInput(MonotonicNowNs() / 1000000))',
    );
  });

  it('refuses a background session before every direct cursor move', () => {
    const input = native('computer_use_windows_host_input.inc');
    const direct = [...input.matchAll(/cursor_set = SetCursorPos\(/gu)];
    expect(direct).toHaveLength(2);
    for (const match of direct) {
      const before = input.slice(Math.max(0, (match.index ?? 0) - 700), match.index);
      expect(before).toContain(
        'if (session.input_session.kind == sprint_coder::computer_use::InputSessionKind::kBackground) {',
      );
    }
  });

  it('records that real-device BG01 completed is blocked until own-call attribution', () => {
    const follow = 'N9 P4a-attr claim-scoped own-call WinEvent attribution';
    expect(native('computer_use_windows_host_background_monitor.inc')).toContain(follow);
    expect(native('computer_use_windows_host_uia_semantic.inc')).toContain(follow);
    expect(native('computer_use_windows_background_executor_test.h')).toContain(follow);
  });

  it('does not expose foreground APIs to the background pattern adapter', () => {
    const semantic = native('computer_use_windows_host_uia_semantic.inc');
    const start = semantic.indexOf('struct WindowsBackgroundPatternOperations');
    const end = semantic.indexOf('// END background pattern adapter', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(semantic.slice(start, end)).not.toMatch(
      /SetForegroundWindow|ShowWindow|SetFocus|SetCursorPos|SendInput|paste/iu,
    );
  });
});

describe.skipIf(process.platform !== 'win32')('background executor test build', () => {
  // No product build defines the flag, so this is the only place the real UIA adapter
  // (WindowsBackgroundPatternOperations and the flag-1 input branches) is compiled.
  it('compiles the host translation unit with SPRINT_CODER_BACKGROUND_EXECUTOR_TEST=1', ({
    skip,
  }) => {
    const build = findBuild();
    if (!build) {
      if (process.env.CI) throw new Error('MSVC required');
      skip();
      return;
    }
    const root = mkdtempSync(join(tmpdir(), 'sc-background-executor-build-'));
    try {
      const provenance = join(root, 'provenance.h');
      writeFileSync(
        provenance,
        '#pragma once\n#define SPRINT_CODER_SOURCE_COMMIT "0000000000000000000000000000000000000000"\n',
      );
      // The same expanded host translation unit the component tests compile.
      const host = join(root, 'background-executor-host.cc');
      writeFileSync(host, readWindowsHostSource());
      const object = join(root, 'host.obj');
      const command = build.wrap([
        '/nologo',
        '/c',
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
        '/DSPRINT_CODER_BACKGROUND_EXECUTOR_TEST=1',
        `/FI${provenance}`,
        `/I${nativeDirectory}`,
        host,
        `/Fo:${object}`,
      ]);
      const compiled = spawnSync(command.file, command.args, {
        encoding: 'utf8',
        windowsVerbatimArguments: command.verbatim,
        timeout: 500000,
        env: { ...process.env, VSLANG: '1033' },
      });
      expect(compiled.status, compiled.stdout + '\n' + compiled.stderr).toBe(0);
      expect(existsSync(object)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 540000);
});

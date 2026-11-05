import { readWindowsHostSource } from '../../../../computer-use-windows-host-source.mjs';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findBuild } from './test-support/msvc-build';

const nativeDirectory = join(__dirname, '../../computer-use-native');
const native = (name: string): string => readFileSync(join(nativeDirectory, name), 'utf8');
type Run = Readonly<{ status: number | null; stdout: string; stderr: string }>;
// Compiles run asynchronously: a spawnSync longer than 60s blocks the vitest worker RPC.
function run(
  file: string,
  args: string[],
  options: { verbatim?: boolean; timeout: number; env?: NodeJS.ProcessEnv },
): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        windowsHide: true,
        windowsVerbatimArguments: options.verbatim ?? false,
        timeout: options.timeout,
        maxBuffer: 64 * 1024 * 1024,
        ...(options.env ? { env: options.env } : {}),
      },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === 'number' ? error.code : error ? null : 0;
        resolve({ status: code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

describe('background executor native entry', () => {
  it('pins bound-page checks before the claim and BeginCall without foreground focus', () => {
    const executor = native('computer_use_windows_background_executor.h');
    expect(executor).toContain('if (!ops.CheckPage()) return Outcome::kRejected;');
    expect(executor).toContain('if (ops.CheckPage() && ops.BeginCall(claim))');
    const semantic = native('computer_use_windows_host_uia_semantic.inc');
    expect(semantic).toContain('work->observed_page = session.observed_page;');
    expect(semantic).toContain(
      'RecheckWindowsBoundPageOnLane(work.window, work.pid, work.observed_page,',
    );
    expect(semantic).toContain('pending->page_invalidated.load(std::memory_order_acquire)');
    expect(semantic).toContain('InvalidateWindowsPage(session);');
    const preflight = native('computer_use_windows_host_preflight.inc');
    const start = preflight.indexOf('bool RecheckWindowsBoundPageOnLane(');
    const end = preflight.indexOf('bool RecheckWindowsPageBeforeInput(', start);
    expect(preflight.slice(start, end)).not.toMatch(/Focused|GetForegroundWindow/u);
    const tests = native('computer_use_windows_background_executor_test.h');
    for (const name of [
      'background_action_checks_bound_page',
      'background_page_change_blocks_commit',
      'stop_before_or_during_page_check_blocks_input',
      'electron_background_page_check_is_neutral',
    ])
      expect(tests).toContain(name);
  });

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
      'BG01_attributed_event_or_other_hwnd_takeover',
      'BG01_attribution_does_not_replace_readback',
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

  it('binds attribution to the resolved element outside locks and preserves Stop ordering', () => {
    const semantic = native('computer_use_windows_host_uia_semantic.inc');
    const claim = semantic.slice(
      semantic.indexOf('std::uint64_t Claim()'),
      semantic.indexOf('bool Call()'),
    );
    const prepare = semantic.slice(
      semantic.indexOf('Preparation Prepare()'),
      semantic.indexOf('bool ReadScroll('),
    );
    expect(prepare).toContain('target->get_CurrentNativeWindowHandle(&hwnd)');
    expect(prepare).toContain('!ElementWindowValid()) return Preparation::kHandoff;');
    expect(claim.indexOf('!ElementWindowValid()')).toBeLessThan(claim.indexOf('stop_mutex'));
    expect(claim).toContain('window_handoff = true; return 0;');
    expect(semantic).toContain(
      'outcome == Outcome::kAwaitingForegroundHandoff || operations.window_handoff',
    );
    expect(claim).toContain('work.kind, reinterpret_cast<std::uintptr_t>(hwnd)');
    expect(claim).toContain('state.Claim(pending->background_epoch, permission)');
    const stop = semantic.slice(
      semantic.indexOf('bool StopWindowsSemanticInput'),
      semantic.indexOf('bool AwaitWindowsSemanticValidation'),
    );
    expect(stop).toContain('session.background_monitor->state.Pause()');
    expect(stop).toContain('active->background_monitor->state.Pause()');
    expect(native('computer_use_windows_background_executor_test.cc')).toContain(
      'BG01_scroll_attributed_event_or_other_hwnd_takeover',
    );
  });

  it('pins generation time, grace exclusion, dedicated child HWNDs and per-kind fail-closed limits', () => {
    const monitor = native('computer_use_windows_background_monitor.h');
    expect(monitor).toContain('return ::GetTickCount();');
    expect(monitor).not.toContain('#include <windows.h>');
    expect(monitor).toContain('call_tick_ = tick_clock_();');
    expect(monitor).toContain('static_cast<std::int32_t>(event_tick - call_tick_) > 0');
    expect(monitor).toContain('(grace_ && now < grace_deadline_)');
    expect(monitor).toContain('kind_counts_[kind] < permission_.limits[kind]');
    expect(monitor).not.toContain('0x8002, 0x8003');
    expect(monitor).not.toContain('0x12, 0x13');
    const host = native('computer_use_windows_host_background_monitor.inc');
    expect(host).toContain('object, child, event_tick);');
    for (const guard of [
      'IsWindow(hwnd)',
      'pid == target_pid',
      'hwnd != target_window',
      'GetAncestor(hwnd, GA_ROOT) != hwnd',
      'IsChild(target_window, hwnd)',
    ])
      expect(host).toContain(guard);
    expect(host).toContain('foreground && mouse && objects && movement && capture && scrolling');
    const tests = native('computer_use_windows_background_monitor_test.cc');
    for (const name of [
      'ATTR_generation_before_or_same_tick_delivered_after_claim',
      'ATTR_generation_tick_wrap',
      'ATTR_grace_refuses_claim_until_deadline',
      'ATTR_each_kind_first_excess_pauses',
      'ATTR_total_first_excess_pauses',
      'ATTR_show_hide_scrolling_never_exempt',
      'ATTR_element_hwnd_requires_live_same_pid_descendant_not_root',
      'ATTR_scrolling_hook_registration_failure_pauses',
    ])
      expect(tests).toContain(name);
    const fixture = native('fixtures/background-input/fixture.cc');
    expect(fixture).toContain('i < 6');
    expect(fixture).toContain('WS_CHILD | WS_VISIBLE');
    expect(fixture).toContain('main_window, nullptr, cls.hInstance, controls[i]');
  });

  it('limits attribution to the provider call and EndCall grace with Stop-first locks', () => {
    const executor = native('computer_use_windows_background_executor.h');
    expect(executor.indexOf('ops.BeginCall(claim)')).toBeLessThan(executor.indexOf('ops.Call()'));
    expect(executor.indexOf('const bool ended = ops.EndCall(claim)')).toBeLessThan(
      executor.indexOf('ops.Readback()'),
    );
    expect(executor).toContain('catch (...) { ops.EndCall(claim); throw; }');
    const semantic = native('computer_use_windows_host_uia_semantic.inc');
    for (const boundary of ['BeginCall', 'EndCall']) {
      const body =
        semantic.slice(semantic.indexOf('bool ' + boundary + '(')).split('\n  }')[0] ?? '';
      expect(body.indexOf('stop_mutex')).toBeLessThan(body.indexOf('state.' + boundary));
    }
    const tests = native('computer_use_windows_background_monitor_test.cc');
    for (const name of [
      'ATTR_before_begin_call_pauses',
      'ATTR_call_and_end_grace_but_not_expired_before_finish',
      'ATTR_generation_before_or_at_begin_call_pauses',
      'ATTR_invalid_call_boundary_order_or_claim_pauses',
      'ATTR_finish_without_end_call_pauses_and_revokes_permission',
      'ATTR_finish_without_begin_call_pauses_and_revokes_permission',
      'ATTR_finish_does_not_restart_end_call_grace',
    ])
      expect(tests).toContain(name);
    expect(native('computer_use_windows_background_executor_test.cc')).toContain(
      'ATTR_executor_call_window_readback_window_and_exception',
    );
  });

  it('connects the bounded monitor matrix and WinEvent metadata without widening the public gate', () => {
    const monitor = native('computer_use_windows_background_monitor.h');
    expect(monitor).toContain('kBackgroundEventGraceMs = 150');
    expect(monitor).toContain('kBackgroundEventLimit = 16');
    expect(monitor).toContain('observed < grace_deadline_');
    expect(monitor).toContain('exempted_ < kBackgroundEventLimit');
    const host = native('computer_use_windows_host_background_monitor.inc');
    expect(host).toContain('state.TargetEvent(Owner::kTarget, event,');
    expect(host).toContain('reinterpret_cast<std::uintptr_t>(hwnd), object, child');
    expect(host).toContain('EVENT_SYSTEM_SCROLLINGSTART, EVENT_SYSTEM_SCROLLINGEND');
    expect(host).toContain('movement, capture, scrolling}');
    const tests = native('computer_use_windows_background_monitor_test.cc');
    for (const name of [
      'ATTR_arrival_before_during_after_finish_grace_and_next_claim',
      'ATTR_each_pattern_expected_event',
      'ATTR_wrong_hwnd_kind_object_child_owner_time_or_missing_hwnd',
      'ATTR_known_child_matches',
      'ATTR_limit_shared_by_claim_and_grace',
      'ATTR_foreground_capture_movesize_popup_never_exempt',
      'ATTR_stop_exit_reregister_health_revoke_permission',
      'ATTR_fresh_monitor_does_not_inherit_grace',
      'ATTR_callback_passes_metadata',
      'ATTR_native_stop_revokes_grace',
      'ATTR_old_finish_cannot_end_next_claim',
      'ATTR_next_claim_gets_fresh_count',
      'ATTR_old_finish_cannot_extend_grace',
      'ATTR_unattributed_next_claim_discards_old_permission',
      'ATTR_stop_before_or_after_claim_linearization',
    ])
      expect(tests).toContain(name);
  });

  it('opens every executor guard, including the Stop pauses, in the P7b acceptance build too', () => {
    for (const name of [
      'computer_use_windows_host_uia_semantic.inc',
      'computer_use_windows_host_input.inc',
    ]) {
      const guards = native(name).match(/^#if SPRINT_CODER_BACKGROUND_EXECUTOR_TEST\b.*$/gmu) ?? [];
      expect(guards.length, name).toBeGreaterThan(0);
      for (const guard of guards)
        expect(guard, name).toContain('|| SPRINT_CODER_WINDOWS_BACKGROUND_ACCEPTANCE');
    }
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
  it('page_change_between_chunks_stops_remaining_input', async ({ skip }) => {
    const build = findBuild();
    if (!build) {
      skip();
      return;
    }
    const root = mkdtempSync(join(tmpdir(), 'sc-page-chunks-'));
    try {
      const input = native('computer_use_windows_host_input.inc');
      const boundary = input.slice(
        input.indexOf('UINT SendInputForBoundTarget('),
        input.indexOf('bool SetWindowsApprovedCursor('),
      );
      const source = join(root, 'chunks.cc');
      const binary = join(root, 'chunks.exe');
      writeFileSync(
        source,
        `
#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <iostream>
using UINT = unsigned;
struct RECT {};
struct INPUT {};
using LPINPUT = INPUT *;
struct WindowsSession {
  int active_window = 1;
  struct { bool web = true; } observed_page;
  std::uint64_t approved_deadline_ns = 0, approved_started_ns = 0;
  std::uint64_t approved_helper_generation = 1, approved_stop_serial = 1;
  std::shared_ptr<std::atomic<std::uint64_t>> input_api_attempts =
      std::make_shared<std::atomic<std::uint64_t>>(0);
};
struct Control { std::mutex stop_mutex; } control;
Control &WindowsTargetListControl() { return control; }
std::uint64_t windows_helper_generation = 1, serial = 1;
std::uint64_t MonotonicNowNs() { return 100; }
std::uint64_t WindowsValidationFrameStopSerial() { return 1; }
bool WindowsValidationStillCurrent(std::uint64_t, std::uint64_t expected) { return serial == expected; }
bool WindowsSemanticInputInFlight() { return false; }
bool WindowsSemanticInputInFlightLocked() { return false; }
bool WindowsRoundTripMayInput(const WindowsSession &) { return true; }
int foreground_window = 1;
int GetForegroundWindow() { return foreground_window; }
bool RevalidateWindowsTarget(const WindowsSession &, const RECT &, std::uint64_t) { return serial == 1; }
bool page_matches = true, stop_during_read = false, ticket_valid = true;
int reads = 0, sends = 0;
bool RecheckWindowsPageBeforeInput(const WindowsSession &session) {
  if (!session.observed_page.web) return true;
  ++reads;
  if (stop_during_read) serial = 2;
  if (!page_matches) ticket_valid = false;
  return page_matches;
}
UINT SendInput(UINT count, LPINPUT, int) { ++sends; return count; }
${boundary}
int main() {
  WindowsSession session; RECT bounds; INPUT events[2];
  const auto send = [&] { return SendInputForBoundTarget(session, bounds, 1, 2, events); };
  if (send() != 2 || sends != 1) return 1;
  page_matches = false;
  if (send() != 0 || sends != 1 || ticket_valid || *session.input_api_attempts != 1) return 2;
  std::cout << "page_change_between_chunks_blocks_remaining: PASS\\n";
  serial = 2; page_matches = true;
  const int previous_reads = reads;
  if (send() != 0 || sends != 1 || reads != previous_reads) return 3;
  std::cout << "stop_before_page_check_blocks_input: PASS\\n";
  serial = 1; stop_during_read = true;
  if (send() != 0 || sends != 1) return 4;
  std::cout << "stop_during_page_check_blocks_input: PASS\\n";
  serial = 1; stop_during_read = false; page_matches = false;
  session.observed_page.web = false;
  const int electron_reads = reads;
  if (send() != 2 || sends != 2 || reads != electron_reads) return 5;
  std::cout << "electron_chunk_page_check_is_neutral: PASS\\n";
  session.observed_page.web = true; page_matches = true;
  session.approved_deadline_ns = 200;
  if (send() != 2 || sends != 3) return 6;
  page_matches = false;
  if (send() != 0 || sends != 3 || *session.input_api_attempts != 3) return 8;
  page_matches = true;
  foreground_window = 2;
  if (send() != 0 || sends != 3) return 7;
  return 0;
}
`,
      );
      const command = build.wrap([
        '/nologo',
        '/std:c++20',
        '/EHsc',
        source,
        `/Fo:${join(root, 'chunks.obj')}`,
        `/Fe:${binary}`,
      ]);
      const compiled = await run(command.file, command.args, {
        verbatim: command.verbatim,
        timeout: 120000,
      });
      expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
      const result = await run(binary, [], { timeout: 10000 });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('page_change_between_chunks_blocks_remaining: PASS');
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 150000);

  // Compile-only matrix; never launches the helper or sends OS input.
  describe.each(['test', 'background-acceptance', 'production'] as const)(
    'native build %s',
    (variant) => {
      it('compiles the host translation unit and checks the fixture predicate', async ({
        skip,
      }) => {
        const build = findBuild();
        if (!build) {
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
          if (variant === 'background-acceptance') {
            writeFileSync(
              provenance,
              readFileSync(provenance, 'utf8') +
                '#define SPRINT_CODER_COMPUTER_USE_ACCEPTANCE_BUILD 1\n' +
                '#define SPRINT_CODER_WINDOWS_BACKGROUND_ACCEPTANCE 1\n' +
                '#define SPRINT_CODER_BACKGROUND_FIXTURE_SHA256 "' +
                'a'.repeat(64) +
                '"\n',
            );
          }
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
            ...(variant === 'test' ? ['/DSPRINT_CODER_BACKGROUND_EXECUTOR_TEST=1'] : []),
            `/FI${provenance}`,
            `/I${nativeDirectory}`,
            host,
            `/Fo:${object}`,
          ]);
          const compiled = await run(command.file, command.args, {
            verbatim: command.verbatim,
            timeout: 500000,
            env: { ...process.env, VSLANG: '1033' },
          });
          expect(compiled.status, compiled.stdout + '\n' + compiled.stderr).toBe(0);
          expect(existsSync(object)).toBe(true);
          const hostSource = readWindowsHostSource();
          const verdictStart = hostSource.indexOf(
            '// BEGIN background acceptance fixture verdicts',
          );
          const verdictEnd = hostSource.indexOf('// END background acceptance fixture verdicts');
          expect(verdictStart).toBeGreaterThanOrEqual(0);
          expect(verdictEnd).toBeGreaterThan(verdictStart);
          const fixtureVerdicts = hostSource.slice(verdictStart, verdictEnd);
          const predicateSource = join(root, 'acceptance-predicate.cc');
          const predicateBinary = join(root, 'acceptance-predicate.exe');
          writeFileSync(
            predicateSource,
            `
#include "computer_use_protocol.h"
#include "computer_use_windows_target_facts.h"
#include "computer_use_target_eligibility_golden_generated.h"
using namespace sprint_coder::computer_use;
${fixtureVerdicts}
int main() {
  auto facts = TargetGoldenCases().front().facts;
  facts.image_root = "other";
  facts.image_leaf = "fixture.exe";
  facts.signature = "unsigned";
  facts.window_class = "P7aFixture";
  const auto admitted = [&](const TargetFacts &value, std::string_view digest) {
#if SPRINT_CODER_WINDOWS_BACKGROUND_ACCEPTANCE
    return WindowsBackgroundFixtureVerdict(value, digest).kind == TargetVerdictKind::kEligible;
#else
    (void)value;
    (void)digest;
    return false;
#endif
  };
  const std::string pin(64, 'a');
  if (admitted(facts, pin) != bool(SPRINT_CODER_WINDOWS_BACKGROUND_ACCEPTANCE)) return 1;
  if (kWindowsBackgroundInputEnabled != bool(SPRINT_CODER_WINDOWS_BACKGROUND_ACCEPTANCE)) return 2;
  if (admitted(facts, std::string(64, 'b'))) return 3;
  auto changed = facts; changed.token_elevated = true;
  if (admitted(changed, pin)) return 4;
  changed = facts; changed.running_image_matches = false;
  if (admitted(changed, pin)) return 5;
  changed = facts; changed.pe_subsystem = "console";
  if (admitted(changed, pin)) return 6;
  changed = facts; changed.image_volume = "network";
  if (admitted(changed, pin)) return 7;
  changed = facts; changed.own_descendant = true;
  if (admitted(changed, pin)) return 8;
  changed = facts; changed.window_class = "Other";
  if (admitted(changed, pin)) return 9;
  changed = facts; changed.image_root = "self_install";
  if (admitted(changed, pin)) return 10;
  changed = facts; changed.token_other_user.reset();
  if (admitted(changed, pin)) return 11;
  for (int slot = 0; slot < 6; ++slot)
    if (WindowsBackgroundFixtureProviderMatches(pin, "P7aSynthetic", "P7aControl",
        "slot-" + std::to_string(slot)) != bool(SPRINT_CODER_WINDOWS_BACKGROUND_ACCEPTANCE)) return 12;
  if (WindowsBackgroundFixtureProviderMatches(pin, "Other", "P7aControl", "slot-0") ||
      WindowsBackgroundFixtureProviderMatches(pin, "P7aSynthetic", "Other", "slot-0") ||
      WindowsBackgroundFixtureProviderMatches(pin, "P7aSynthetic", "P7aControl", "slot-6") ||
      WindowsBackgroundFixtureProviderMatches(std::string(64, 'b'), "P7aSynthetic", "P7aControl", "slot-0")) return 13;
  return 0;
}
`,
          );
          const predicateCommand = build.wrap([
            '/nologo',
            '/std:c++20',
            '/EHsc',
            '/W4',
            '/sdl',
            '/permissive-',
            `/FI${provenance}`,
            `/I${nativeDirectory}`,
            predicateSource,
            `/Fo:${join(root, 'predicate.obj')}`,
            `/Fe:${predicateBinary}`,
          ]);
          const predicateBuild = await run(predicateCommand.file, predicateCommand.args, {
            verbatim: predicateCommand.verbatim,
            timeout: 120000,
            env: { ...process.env, VSLANG: '1033' },
          });
          expect(predicateBuild.status, predicateBuild.stdout + predicateBuild.stderr).toBe(0);
          const checked = await run(predicateBinary, [], { timeout: 10000 });
          expect(checked.status).toBe(0);
        } finally {
          rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
        }
      }, 540000);
    },
  );
});

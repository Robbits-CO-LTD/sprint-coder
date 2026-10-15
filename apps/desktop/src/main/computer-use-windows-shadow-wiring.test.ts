import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source contracts for the Windows shadow wiring (classifier v2, S5-b-2b). The scheduler is run by
// the portable harness (computer_use_protocol_fuzz.cc, MSVC and clang) with a fake launcher and a
// fake UI Automation tree; the real UI Automation source is Windows-only. What is tied here is where
// the host calls it: after the V1 preflight has its answer, never on the serial lane's reads, never
// able to change the receipt, with the shadow's own thread and its own COM apartment.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const read = (name: string): string => readFileSync(join(nativeDirectory, name), 'utf8');
const scheduler = read('computer_use_windows_shadow_scheduler.h');
const host = read('computer_use_windows_host.cc');
const harness = read('computer_use_protocol_fuzz.cc');

/** The code of a file without its line comments (a comment may name what the code must not do). */
const code = (text: string): string => text.replace(/\/\/.*$/gmu, '');

/** The text between two markers, or a failure: an extraction that finds nothing must not pass. */
function between(text: string, begin: string, end: string): string {
  const start = text.indexOf(begin);
  expect(start, begin).toBeGreaterThanOrEqual(0);
  const stop = text.indexOf(end, start + begin.length);
  expect(stop, end).toBeGreaterThan(start);
  const body = text.slice(start, stop);
  expect(body.length, begin).toBeGreaterThan(40);
  return body;
}

const wiring = between(host, '// BEGIN effect shadow wiring', '// END effect shadow wiring');
const preflight = between(
  host,
  'bool HandleWindowsPreflight(HANDLE pipe, const Frame &request,',
  'bool ObserveWindowsWindow(',
);

describe('Windows shadow scheduler decides nothing and reads nothing itself', () => {
  it('is portable: no platform header, no thread of its own, no ring of its own', () => {
    const allowedIncludes = new Set([
      '"computer_use_windows_shadow_reader.h"',
      '<atomic>',
      '<functional>',
      '<memory>',
      '<string>',
      '<string_view>',
      '<utility>',
    ]);
    for (const match of scheduler.matchAll(/^\s*#\s*include\s+(\S+)/gmu))
      expect(allowedIncludes.has(match[1]!), match[1]).toBe(true);
    const text = code(scheduler);
    expect(text).not.toMatch(/#\s*if(n?def)?\s+.*(_WIN32|__APPLE__|__linux__|_MSC_VER)/u);
    expect(text).not.toMatch(
      /windows\.h|UIAutomation|IUIAutomation|CoCreateInstance|CoInitialize|<thread>|std::thread|<mutex>|chrono|<random>|fstream|getenv|SetThreadPriority/iu,
    );
    expect(text).not.toMatch(/single_use_approval|SingleUseApproval|ticket|approve/iu);
    // The ring is handed in, not reached for; the process ring is the host's to name.
    expect(text).not.toContain('ProcessShadowLog');
    expect(text).not.toMatch(/kNativePreflightClassifierVersion|classifierVersion/u);
  });

  it('reads nothing when V1 is not valid, takes one capture at a time, and hands the work to a launcher', () => {
    const schedule = between(scheduler, 'void Schedule(', 'private:');
    const v1 = schedule.indexOf('if (!v1_valid)');
    const busy = schedule.indexOf('in_flight_.exchange(true)');
    const launch = schedule.indexOf('launcher_(');
    expect(v1).toBeGreaterThanOrEqual(0);
    expect(busy).toBeGreaterThan(v1);
    expect(launch).toBeGreaterThan(busy);
    // The scheduling call itself reads nothing: no source, no reader, no capture.
    expect(code(schedule)).not.toMatch(/open_source|WindowsShadowReader|Capture\(|still_valid/u);
    expect(schedule).toContain('kShadowGapV1Invalid');
    expect(schedule).toContain('kShadowGapBusy');
    // The slot is freed after the work, and when the launcher itself failed.
    expect(schedule).toMatch(/Run\(job, environment\);\s*in_flight_\.store\(false\);/u);
    expect(schedule).toMatch(/if \(claimed && !handed_over\) in_flight_\.store\(false\);/u);
    expect(schedule).toContain('} catch (...) {');
    expect(schedule).toMatch(/noexcept/u);
  });

  it('checks the cancel at the start, again at the end, and records a cancel as a skipped record', () => {
    const run = between(scheduler, 'void Run(', 'EffectShadowLog &ring_;');
    const valid = run.indexOf('environment.still_valid()');
    const open = run.indexOf('environment.open_source()');
    const capture = run.indexOf('reader.Capture(');
    const canceled = run.indexOf('reader.Canceled()');
    const classify = run.indexOf('WindowsShadowClassify(');
    expect(valid).toBeGreaterThanOrEqual(0);
    expect(open).toBeGreaterThan(valid);
    expect(capture).toBeGreaterThan(open);
    expect(canceled).toBeGreaterThan(capture);
    expect(classify).toBeGreaterThan(canceled);
    expect(run).toContain('kShadowGapCanceled');
    expect(run).toContain('kShadowGapReadFailed');
    expect(run).toMatch(/noexcept/u);
    expect(run).toContain('} catch (...) {');
    // Whatever is recorded is an enum-only ShadowRecord: the capture's strings stay in this function.
    expect(run).toMatch(
      /ring_\.Record\(WindowsShadowClassify\(capture, info, job\.v1_ordinary\)\)/u,
    );
  });

  it('is built and run by the harness on both compilers', () => {
    expect(harness).toContain('#include "computer_use_windows_shadow_scheduler.h"');
    expect(harness).toContain('CheckWindowsShadowScheduler()');
    expect(harness).toContain('Computer Use native Windows shadow scheduler: PASS');
    for (const name of [
      'winsched-v1-invalid-reads-nothing',
      'winsched-schedule-reads-nothing-on-the-callers-thread',
      'winsched-second-capture-is-busy',
      'winsched-canceled-before-start-reads-nothing',
      'winsched-canceled-mid-capture-is-skipped',
      'winsched-no-uia-is-a-read-gap',
      'winsched-launcher-exception-frees-the-slot',
      'winsched-v1-verdict-is-carried',
    ])
      expect(harness, name).toContain(name);
  });
});

describe('Windows host calls the shadow only after V1, and only to watch', () => {
  it('includes the scheduler and the source, and uses the reader only through the scheduler', () => {
    expect(host).toContain('#include "computer_use_windows_uia_source.h"');
    expect(host).toContain('#include "computer_use_windows_shadow_scheduler.h"');
    const text = code(host);
    for (const name of [
      'WindowsShadowReader',
      'WindowsShadowClassify',
      'BuildWindowsShadowFacts',
      'ShadowGate',
      '.Capture(',
    ])
      expect(text, name).not.toContain(name);
    // The UI Automation source is created only inside the open_source function the shadow thread runs.
    expect(text.match(/WindowsUiaShadowSource::Create/gu)?.length).toBe(1);
    expect(wiring).toMatch(
      /environment\.open_source = \[window, point, still_valid\]\(\)\s*->\s*std::unique_ptr<ShadowUiaSource> \{\s*return WindowsUiaShadowSource::Create\(window, point, still_valid\);/u,
    );
    // The process ring is named in exactly one place: the wiring.
    expect(text.match(/ProcessShadowLog\(\)/gu)?.length).toBe(1);
    expect(wiring).toContain('ProcessShadowLog()');
  });

  it('calls ScheduleWindowsEffectShadow from HandleWindowsPreflight only: once without V1, once after the receipt is out', () => {
    const calls = [...code(host).matchAll(/ScheduleWindowsEffectShadow\(/gu)];
    // the definition and the two calls
    expect(calls.length).toBe(3);
    const inPreflight = [...code(preflight).matchAll(/ScheduleWindowsEffectShadow\(/gu)];
    expect(inPreflight.length).toBe(2);
    const text = code(preflight);
    const validate = text.indexOf('ValidateWindowsDispatchBinding(');
    const denied = text.indexOf(
      'ScheduleWindowsEffectShadow(session, metadata, kind, false, false)',
    );
    const receipt = text.indexOf('std::string receipt = WindowsPreflightReceipt(');
    const respond = text.indexOf('Respond(pipe, request, MessageType::kPreflightResult, receipt)');
    const issued = text.indexOf(
      'ScheduleWindowsEffectShadow(session, metadata, kind, true, issued)',
    );
    expect(validate).toBeGreaterThanOrEqual(0);
    // Without a valid V1 binding the shadow only records that it read nothing, and the denial stays.
    expect(denied).toBeGreaterThan(validate);
    expect(denied).toBeLessThan(receipt);
    expect(text.slice(denied, receipt)).toContain('"denied"');
    // With one, it is scheduled after the receipt has been built AND sent: it cannot change it.
    expect(receipt).toBeGreaterThan(denied);
    expect(respond).toBeGreaterThan(receipt);
    expect(issued).toBeGreaterThan(respond);
    // It is the last thing before the return, and the V1 verdict it carries is `issued`.
    expect(text.slice(issued)).toMatch(/^[^;]*;\s*return sent;\s*\}/u);
    // The receipt arguments name no shadow state.
    expect(text.slice(receipt, respond)).not.toMatch(/shadow/iu);
    // No other message path (observe, dispatch, cancel) schedules a capture.
    const outsidePreflight = code(host).replace(code(preflight), '').replace(code(wiring), '');
    expect(outsidePreflight).not.toContain('ScheduleWindowsEffectShadow');
  });

  it('runs on its own low-priority thread with its own COM apartment, and never on the caller', () => {
    const text = code(wiring);
    const launch = between(text, 'void LaunchWindowsShadowThread(', 'WindowsEffectShadow() {');
    expect(launch).toContain('std::thread(');
    expect(launch).toContain('.detach()');
    expect(launch).toContain('SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_LOWEST)');
    expect(launch.indexOf('CoInitializeEx(nullptr, COINIT_MULTITHREADED)')).toBeLessThan(
      launch.indexOf('work();'),
    );
    expect(launch.indexOf('work();')).toBeLessThan(launch.indexOf('CoUninitialize()'));
    // The scheduler and the launcher live for the life of the process (a capture may outlive main).
    expect(text).toMatch(
      /static sprint_coder::computer_use::WindowsShadowScheduler \*const scheduler =\s*new sprint_coder::computer_use::WindowsShadowScheduler\(\s*sprint_coder::computer_use::ProcessShadowLog\(\), LaunchWindowsShadowThread\)/u,
    );
  });

  it('copies what the capture needs by value, holds no lock, and touches no host state', () => {
    const schedule = code(wiring).slice(code(wiring).indexOf('void ScheduleWindowsEffectShadow('));
    expect(schedule).toMatch(/noexcept \{/u);
    expect(schedule).toContain('} catch (...) {');
    expect(schedule).not.toMatch(
      /lock_guard|unique_lock|\bmutex\b|sessions\b|ticket_states|InvalidateWindowsTicket|response_cache/u,
    );
    // The cancel check compares the global epoch with the one the preflight was bound to.
    expect(schedule).toContain('const std::uint64_t expected_epoch = session.cancel_epoch;');
    expect(schedule).toMatch(
      /cancellation_epoch\.load\(std::memory_order_acquire\) == expected_epoch/u,
    );
    // Nothing reads UI Automation here: no method call on an element, no input API.
    expect(schedule).not.toMatch(
      /->\w+\(|SendInput|SetFocus|SetForegroundWindow|PostMessage|SendMessage/u,
    );
    // The click point is computed as the dispatch computes it.
    expect(schedule).toContain('bounds.right - bounds.left - 1');
    expect(schedule).toContain('bounds.bottom - bounds.top - 1');
  });

  it('changes no version and no receipt: the V1 answer is unchanged', () => {
    expect(host).toContain('kNativePreflightClassifierVersion');
    // The receipt constructor and its two calls still build the V1 answer from V1 inputs only.
    const text = code(preflight);
    expect((text.match(/WindowsPreflightReceipt\(/gu) ?? []).length).toBe(3);
    expect(text).toContain('issued ? "ordinary" : "denied"');
    expect(text).not.toMatch(/ProcessShadowLog|Snapshot\(|Total\(\)/u);
  });
});

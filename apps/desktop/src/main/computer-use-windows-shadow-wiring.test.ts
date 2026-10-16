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
      '<mutex>',
      '<string>',
      '<string_view>',
      '<utility>',
      '<vector>',
    ]);
    for (const match of scheduler.matchAll(/^\s*#\s*include\s+(\S+)/gmu))
      expect(allowedIncludes.has(match[1]!), match[1]).toBe(true);
    const text = code(scheduler);
    expect(text).not.toMatch(/#\s*if(n?def)?\s+.*(_WIN32|__APPLE__|__linux__|_MSC_VER)/u);
    expect(text).not.toMatch(
      /windows\.h|UIAutomation|IUIAutomation|CoCreateInstance|CoInitialize|<thread>|std::thread|chrono|<random>|fstream|getenv|SetThreadPriority/iu,
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
      /EmitFromShadow\(WindowsShadowClassify\(capture, info, job\.v1_ordinary\)\)/u,
    );
    // The cancel is looked at after the last call of the capture too, not only by the gate.
    expect(run).toContain('reader.Canceled() || !environment.still_valid()');
  });

  it("keeps every record in the ring at once and never tells the observer on the caller's thread", () => {
    const text = code(scheduler);
    // The ring is written in one place and the observer called in one place.
    expect(text.match(/ring_\.Record\(/gu)?.length).toBe(1);
    expect(text.match(/observer_\(record\)/gu)?.length).toBe(1);
    // The records the caller's side makes (V1 invalid, busy) only wait; the observer is never called
    // there, because its output may block on something outside the helper (the debug-output reader).
    const caller = between(
      text,
      'void EmitFromCaller(const ShadowRecord &record) noexcept {',
      'void EmitFromShadow(',
    );
    expect(caller).toContain('Keep(record);');
    expect(caller).not.toContain('Notify');
    expect(caller).not.toContain('observer_');
    const schedule = between(text, 'void Schedule(', 'private:');
    expect(schedule).toContain('EmitFromCaller(');
    expect(schedule).not.toMatch(/EmitFromShadow|Notify|observer_/u);
    // The shadow's thread keeps, announces, and then passes on what the caller's side left waiting.
    const shadow = between(
      text,
      'void EmitFromShadow(const ShadowRecord &record) noexcept {',
      'static constexpr',
    );
    expect(shadow.indexOf('Keep(record)')).toBeLessThan(shadow.indexOf('Notify(record)'));
    expect(shadow.indexOf('Notify(record)')).toBeLessThan(shadow.indexOf('Notify(earlier)'));
    // Run (the shadow's thread) never uses the caller's path.
    const run = between(text, 'void Run(', 'void Keep(');
    expect(run).not.toContain('EmitFromCaller');
    // The observer sees a ShadowRecord, which is enums and counters (trivially copyable) and nothing else.
    expect(text).toContain(
      'using WindowsShadowObserver = std::function<void(const ShadowRecord &)>;',
    );
    expect(read('computer_use_effect_shadow.h')).toMatch(
      /static_assert\(std::is_trivially_copyable_v<ShadowRecord>/u,
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
    // The UI Automation source is created inside the open_source function the shadow thread runs, and
    // (S5-c-1) once more in the synchronous interlock entry, which nothing calls yet (its own contract
    // is in computer-use-windows-interlock-capture.test.ts).
    expect(text.match(/WindowsUiaShadowSource::Create/gu)?.length).toBe(2);
    expect(wiring.match(/WindowsUiaShadowSource::Create/gu)?.length).toBe(1);
    expect(wiring).toMatch(
      /environment\.open_source = \[window, point, still_valid, point_known, needs_point\]\(\)\s*->\s*std::unique_ptr<ShadowUiaSource> \{\s*if \(needs_point && !point_known\)\s*return nullptr;\s*return WindowsUiaShadowSource::Create\(\s*window, point, still_valid,\s*WindowsUiaShadowSource::kShadowUiaTimeoutMs,\s*windows_uia_source_detail::ShellLookupRunning\(\)\);/u,
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
    const deniedSent = text.indexOf('const bool denied_sent =');
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
    expect(deniedSent).toBeGreaterThan(validate);
    expect(denied).toBeGreaterThan(deniedSent);
    expect(denied).toBeLessThan(receipt);
    // The denial is on the wire BEFORE the shadow is told: the shadow never holds the V1 answer.
    expect(text.slice(deniedSent, denied)).toContain('"denied"');
    expect(text.slice(deniedSent, denied)).toContain(
      'Respond(pipe, request, MessageType::kPreflightResult',
    );
    expect(text.slice(denied, receipt)).toContain('return denied_sent;');
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
      /static sprint_coder::computer_use::WindowsShadowScheduler \*const scheduler =\s*new sprint_coder::computer_use::WindowsShadowScheduler\(\s*sprint_coder::computer_use::ProcessShadowLog\(\), LaunchWindowsShadowThread,\s*ReportWindowsEffectShadow\);/u,
    );
  });

  it('reports each record to the debug output as enums and counters only', () => {
    const report = between(
      code(wiring),
      'void ReportWindowsEffectShadow(',
      'WindowsEffectShadow() {',
    );
    // The line carries the numbers of the record and nothing else: no string argument, no %s.
    expect(report).toContain('OutputDebugStringA(line)');
    const format = /"(computer-use effect shadow[^"]*)"/u.exec(report)?.[1];
    expect(format).toBeDefined();
    expect(format).not.toMatch(/%(?![ud])/u);
    expect(format).not.toMatch(/%s|%ls|%S/u);
    expect(format!.match(/%[ud]/gu)?.length).toBe(6);
    const args = [
      ...report.matchAll(/static_cast<unsigned>\(record\.(\w+)\)|record\.(\w+) \? 1 : 0/gu),
    ].map((match) => match[1] ?? match[2]);
    expect(args).toEqual(['action', 'effect_class', 'kind', 'reason', 'gaps', 'v1_ordinary']);
    // Exactly the six numbers, and no other argument (the only string after a comma is the format).
    expect(report.match(/record\./gu)?.length).toBe(6);
    expect(report.match(/,\s*"/gu)?.length).toBe(1);
    // Nothing of the capture (strings, paths, names) is in reach of this function.
    expect(report).not.toMatch(/ShadowUiaCapture|document_url|item_name|process_path|\.name\b/u);
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
    // The click point is the one mapping the dispatch uses (S5-c-2 PR-1), not a copy of it.
    expect(schedule).toContain('WindowsActionPoint(session.observation_bounds, metadata, &point)');
    expect(schedule).not.toContain('std::lround');
  });

  it('maps a click or scroll point in one place, used by the dispatch, the shadow and the synchronous entry', () => {
    const text = code(host);
    // The formula appears once (left + lround(x * max(0, w - 1))), inside the one function.
    expect(text.match(/bounds\.right - bounds\.left - 1/gu)).toHaveLength(1);
    expect(text.match(/bounds\.bottom - bounds\.top - 1/gu)).toHaveLength(1);
    const point = between(host, '// BEGIN windows action point', '// END windows action point');
    expect(code(point)).toContain('bounds.right - bounds.left - 1');
    expect(code(point)).toContain('x < 0 || x > 1 || y < 0 || y > 1');
    // Three callers: the click and the scroll of the dispatch, the shadow, the synchronous entry.
    expect(text.match(/WindowsActionPoint\(/gu)).toHaveLength(5); // the definition and four calls
    const dispatch = between(host, 'bool DispatchWindowsAction(', 'std::string ProbeJson(');
    expect(code(dispatch).match(/WindowsActionPoint\(bounds, metadata, &/gu)).toHaveLength(2);
    expect(code(wiring)).toContain('WindowsActionPoint(session.observation_bounds');
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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source contracts for the Windows synchronous interlock entry (classifier v2, S5-c-1). It is a
// behaviour-neutral twin of the macOS S4-1b-1: the UI Automation capture of the shadow can be run
// synchronously and answered by the interlock map, as "a verdict" or "no verdict, and why". The
// behaviour of the portable half is in the harness (computer_use_protocol_fuzz.cc, MSVC and clang,
// against a fake UI Automation tree). What is tied here: the header is portable, canceled / budget /
// incomplete are answered BEFORE the map, and NOTHING in the preflight or the dispatch calls the
// entry yet (S5-c-2 is the producer). The shadow's own wiring is not the entry's business.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const read = (name: string): string => readFileSync(join(nativeDirectory, name), 'utf8');
const header = read('computer_use_windows_interlock_capture.h');
const host = read('computer_use_windows_host.cc');
const harness = read('computer_use_protocol_fuzz.cc');

const BEGIN = '// BEGIN sync interlock entry (classifier v2 S5-c-1)';
const END = '// END sync interlock entry';
const SHADOW_BEGIN = '// BEGIN effect shadow wiring';
const SHADOW_END = '// END effect shadow wiring';
const code = (text: string): string =>
  text.replace(/\/\/.*$/gmu, '').replace(/"(?:[^"\\]|\\.)*"/gu, '""');

function between(text: string, begin: string, end: string): string {
  const from = text.indexOf(begin);
  const to = text.indexOf(end, from + begin.length);
  expect(from, begin).toBeGreaterThanOrEqual(0);
  expect(to, end).toBeGreaterThan(from);
  return text.slice(from + begin.length, to);
}

const entry = between(host, BEGIN, END);
const outside = host.replace(BEGIN + entry + END, '');
const shadow = between(host, SHADOW_BEGIN, SHADOW_END);

describe('Windows synchronous interlock entry (classifier v2, S5-c-1)', () => {
  it('is portable: the two portable cores only, no platform header, no thread, no clock of its own', () => {
    expect(header).toContain('#pragma once');
    const allowed = new Set([
      '"computer_use_native_interlock_capture.h"',
      '"computer_use_windows_shadow_reader.h"',
      '<string_view>',
    ]);
    for (const match of header.matchAll(/^\s*#\s*include\s+(\S+)/gmu))
      expect(allowed.has(match[1]!), match[1]).toBe(true);
    expect(header).not.toMatch(/#\s*if(n?def)?\s+.*(_WIN32|__APPLE__|__linux__|_MSC_VER)/u);
    expect(header).not.toMatch(
      /windows\.h|UIAutomation|<chrono>|<thread>|getenv|fopen|fstream|clock_gettime|napi/iu,
    );
    expect(header).not.toMatch(/kNativePreflightClassifierVersion|classifierVersion/u);
  });

  it('answers no verdict for cancel, then budget, then incomplete facts, before the map is asked', () => {
    const squashed = code(header).replace(/\s+/gu, ' ');
    const cancel = squashed.indexOf('if (stopped_by_cancel) {');
    const budget = squashed.indexOf('if (capture.budget_exhausted) {');
    const complete = squashed.indexOf('if (!interlock_detail::FactsAreComplete(built.facts)) {');
    const map = squashed.indexOf('InterlockForFacts(built.facts, ruleset)');
    expect(cancel).toBeGreaterThan(0);
    expect(budget).toBeGreaterThan(cancel);
    expect(complete).toBeGreaterThan(budget);
    expect(map).toBeGreaterThan(complete);
    // A file item of a file manager whose real path is unknown is no verdict, asked before the map.
    const item = squashed.indexOf(
      'capture.item_kind == ShadowItemKind::kFile && !(capture.item_name_read && capture.item_name_is_real_path)',
    );
    expect(item).toBeGreaterThan(complete);
    expect(map).toBeGreaterThan(item);
    expect(squashed).toContain('result.no_verdict = InterlockNoVerdict::kCanceled;');
    expect(squashed).toContain('result.no_verdict = InterlockNoVerdict::kBudget;');
    expect(squashed).toContain('result.no_verdict = InterlockNoVerdict::kIncomplete;');
    // The shadow's own reader and gate, and the end-of-capture check the shadow asks.
    expect(squashed).toContain('WindowsShadowReader reader(source);');
    expect(squashed).toContain('reader.Canceled() || !source.ActionStillValid()');
  });

  it('is defined once in the host and referenced nowhere else (S5-c-2 wires it)', () => {
    expect(entry.length).toBeGreaterThan(200);
    expect(host).toContain('#include "computer_use_windows_interlock_capture.h"');
    expect(host.match(/\bEvaluateWindowsInterlockOnLane\(/gu)).toHaveLength(1);
    // THIS EXPECTATION IS REMOVED IN S5-c-2, which is the producer.
    expect(outside).not.toMatch(
      /EvaluateWindowsInterlockOnLane|EvaluateWindowsInterlockOnSource|EvaluateWindowsInterlockFromCapture|InterlockEvaluation|InterlockNoVerdict|InterlockVerdict/u,
    );
    // No refusal can come out of the host yet: the adapter does not name the codes or the receipt.
    expect(code(entry)).not.toMatch(
      /native_\w+_blocked|native_approval_not_enabled|Receipt|decision|reasonCode/u,
    );
  });

  it('takes the rule set from its caller, answers an exception or a missing source as no verdict, and changes nothing', () => {
    const body = code(entry);
    expect(body).toContain('const sprint_coder::computer_use::EffectRuleset &ruleset');
    expect(body).toContain(
      'EvaluateWindowsInterlockOnSource(*source, kind, target_id, info, ruleset)',
    );
    expect(body).toContain('unavailable.no_verdict = InterlockNoVerdict::kIncomplete;');
    expect(body).toContain('catch (...) {');
    // A click or scroll without a point of the window is not looked up at the screen's origin.
    expect(entry).toMatch(
      /kind == "click" \|\| kind == "scroll"\) && !point_known\)\s*return unavailable/u,
    );
    // The same source and cancellation epoch as the shadow.
    expect(body).toContain(
      'WindowsUiaShadowSource::Create(session.active_window, point, still_valid)',
    );
    expect(body).toContain('cancellation_epoch.load(std::memory_order_acquire) == expected_epoch');
    // No lock, no input API, no write: the caller holds the lane.
    expect(body).not.toMatch(
      /lock_guard|unique_lock|scoped_lock|mutex|SendInput|mouse_event|keybd_event|SetForegroundWindow|SetFocus|PostMessage|SendMessage|WriteFile|std::thread/u,
    );
  });

  it('does not schedule the shadow, and looks at the cancellation before it creates anything', () => {
    const body = code(entry);
    expect(body).not.toMatch(
      /\.Schedule\(|WindowsEffectShadow|ScheduleWindowsEffectShadow|ProcessShadowLog/u,
    );
    const canceled = body.indexOf('if (!still_valid()) {');
    const create = body.indexOf('WindowsUiaShadowSource::Create(');
    expect(canceled).toBeGreaterThan(0);
    expect(create).toBeGreaterThan(canceled);
  });

  it('leaves the shadow wiring as it was: the scheduler, the ring and the observer only', () => {
    expect(shadow).toContain('WindowsEffectShadow().Schedule(');
    expect(shadow).toContain('LaunchWindowsShadowThread');
    expect(shadow).not.toMatch(/Interlock/u);
    expect(host.match(/ProcessShadowLog\(\)/gu)).toHaveLength(1);
  });

  it('is exercised by the harness, moves no version', () => {
    expect(harness).toContain('#include "computer_use_windows_interlock_capture.h"');
    expect(harness).toContain('CheckWindowsInterlockCapture()');
    expect(harness).toContain('Computer Use native Windows interlock capture: PASS');
    const eligibility = JSON.parse(read('eligibility.json')) as {
      versions: Record<string, number>;
    };
    expect(eligibility.versions).toEqual({
      rulesetVersion: 1,
      classifierVersion: 1,
      lexiconVersion: 1,
    });
  });
});

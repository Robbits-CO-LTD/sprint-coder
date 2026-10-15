import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source contracts for the synchronous interlock evaluation (classifier v2, S4-1b-1). It is a
// behaviour-neutral refactor: the facts capture of the C2 shadow is reachable from a synchronous
// call, and the portable half answers "a verdict" or "no verdict, and why". The behaviour of the
// portable half is in the harness (computer_use_protocol_fuzz.cc, MSVC and clang). What is tied
// here: the header is portable, a canceled / out-of-budget / incomplete round is checked BEFORE
// the map, and NOTHING in the preflight or the dispatch calls it yet (S4-1b-2 is the producer).

const nativeDirectory = join(__dirname, '../../computer-use-native');
const read = (name: string): string => readFileSync(join(nativeDirectory, name), 'utf8');
const header = read('computer_use_native_interlock_capture.h');
const macos = read('computer_use_macos.mm');
const harness = read('computer_use_protocol_fuzz.cc');

const BEGIN = '// BEGIN sync interlock capture (classifier v2 S4-1b-1)';
const END = '// END sync interlock capture';
const from = macos.indexOf(BEGIN);
const to = macos.indexOf(END);
const section = macos.slice(from + BEGIN.length, to);
const outside = macos.slice(0, from) + macos.slice(to + END.length);
const code = (text: string): string =>
  text.replace(/\/\/.*$/gmu, '').replace(/"(?:[^"\\]|\\.)*"/gu, '""');

describe('synchronous interlock evaluation (classifier v2, S4-1b-1)', () => {
  it('is portable: standard headers and the two portable cores only, no platform conditional', () => {
    expect(header).toContain('#pragma once');
    const allowed = new Set([
      '"computer_use_effect_shadow.h"',
      '"computer_use_native_interlock.h"',
      '<cstdint>',
    ]);
    for (const match of header.matchAll(/^\s*#\s*include\s+(\S+)/gmu))
      expect(allowed.has(match[1]!), match[1]).toBe(true);
    expect(header).not.toMatch(/#\s*if(n?def)?\s+.*(_WIN32|__APPLE__|__linux__|_MSC_VER)/u);
    expect(header).not.toMatch(
      /windows\.h|UIAutomation|CoreFoundation|ApplicationServices|<chrono>|getenv|fopen|fstream|clock_gettime|napi/iu,
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
    expect(squashed).toContain('result.no_verdict = InterlockNoVerdict::kCanceled;');
    expect(squashed).toContain('result.no_verdict = InterlockNoVerdict::kBudget;');
    expect(squashed).toContain('result.no_verdict = InterlockNoVerdict::kIncomplete;');
    // Only a complete, positive match refuses.
    expect(squashed).toContain(
      'return no_verdict == InterlockNoVerdict::kNone && verdict.Refuses();',
    );
  });

  it('is read by the macOS adapter only through a function nothing calls yet (S4-1b-2 wires it)', () => {
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    expect(macos).toContain('#include "computer_use_native_interlock_capture.h"');
    // The map itself is not reached from the .mm except through the portable evaluation.
    expect(macos).not.toContain('#include "computer_use_native_interlock.h"');
    expect(macos).not.toContain('MapEffectToInterlock');
    expect(macos).not.toContain('InterlockForFacts');
    // The adapter is defined once and referenced nowhere else: neither the shadow, nor the
    // preflight, nor the dispatch guard. THIS EXPECTATION IS REMOVED IN S4-1b-2, which is the
    // producer.
    expect(macos.match(/\bEvaluateInterlockOnLane\(/gu)).toHaveLength(1);
    expect(section.match(/\bEvaluateInterlockOnLane\(/gu)).toHaveLength(1);
    expect(outside).not.toMatch(
      /EvaluateInterlockOnLane|EvaluateInterlockFromCapture|InterlockEvaluation|InterlockNoVerdict|InterlockVerdict/u,
    );
    // No refusal can come out of the native yet: the reason codes are the receipt table's, and the
    // adapter does not name them.
    expect(code(section)).not.toMatch(
      /native_\w+_blocked|NativePreflightReceipt|decision|reasonCode/u,
    );
  });

  it('reads through the shadow capture, on its budget and cancellation, and changes nothing', () => {
    const body = code(section);
    // The capture is the one the shadow and the approval measurement take.
    expect(body).toContain('CaptureShadowTargetFacts(reader, &capture)');
    expect(body).toContain('ShadowReader reader(request);');
    expect(body).toContain('capture.budget_exhausted = reader.budget.Exhausted();');
    expect(body).toContain('EvaluateInterlockFromCapture(capture, info, reader.canceled, ruleset)');
    // An exception or a missing session is "no verdict", never a refusal.
    expect(body).toContain('unavailable.no_verdict = InterlockNoVerdict::kIncomplete;');
    expect(body).toContain('catch (...) {');
    // No lock, no N-API, no write: the caller holds the lane.
    expect(body).not.toMatch(
      /mac_dispatch_serial_mutex|lock_guard|unique_lock|scoped_lock|napi_|AXUIElementPerformAction|AXUIElementSetAttributeValue|AXUIElementCopyAttributeValue|CGEvent|dispatch_async|NSWorkspace/u,
    );
  });

  it('leaves the C2 shadow as it was: scheduled off the lane, one function records it', () => {
    expect(macos.match(/\bRecordEffectShadow\(/gu)).toHaveLength(2);
    expect(macos.match(/\bCaptureShadowTargetFacts\(/gu)).toHaveLength(4);
    const preflight = /NativePreflightReceipt PerformNativePreflight\([\s\S]*?\n\}\n/u.exec(macos);
    expect(preflight).not.toBeNull();
    expect(preflight![0]).toContain(
      'ScheduleEffectShadow(request, receipt.decision == "ordinary", v1_validation);',
    );
    expect(preflight![0]).not.toMatch(/Interlock/u);
  });

  it('is exercised by the harness, moves no version', () => {
    expect(harness).toContain('#include "computer_use_native_interlock_capture.h"');
    expect(harness).toContain('CheckNativeInterlockCapture()');
    expect(harness).toContain('Computer Use native interlock capture: PASS');
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

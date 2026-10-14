import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const nativeDirectory = join(__dirname, '../../computer-use-native');
const read = (name: string): string => readFileSync(join(nativeDirectory, name), 'utf8');
const shadowHeader = read('computer_use_effect_shadow.h');
const macos = read('computer_use_macos.mm');
const harness = read('computer_use_protocol_fuzz.cc');

const BEGIN = '// BEGIN effect shadow capture (classifier v2 C2)';
const END = '// END effect shadow capture';

/** The shadow capture section of the macOS source, markers excluded. */
function shadowSection(): string {
  const from = macos.indexOf(BEGIN);
  const to = macos.indexOf(END);
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return macos.slice(from + BEGIN.length, to);
}

describe('Computer Use effect shadow (classifier v2, C2)', () => {
  it('keeps the portable half free of anything that reads the process', () => {
    const includes = [...shadowHeader.matchAll(/^#include <([^>]+)>/gmu)].map((entry) => entry[1]);
    for (const include of includes)
      expect([
        'array',
        'cstddef',
        'cstdint',
        'mutex',
        'string',
        'string_view',
        'type_traits',
        'vector',
      ]).toContain(include);
    expect(shadowHeader).toContain('#include "computer_use_effect_classifier.h"');
    expect(shadowHeader).not.toMatch(
      /getenv|environ|argv|napi|<chrono>|<random>|#import|CoreGraphics/u,
    );
    expect(shadowHeader).not.toContain('single_use_approval');
  });

  it('is built into macOS only, and the Windows host does not know it', () => {
    expect(macos).toContain('#include "computer_use_effect_shadow.h"');
    const windows = read('computer_use_windows_host.cc');
    expect(windows).not.toContain('computer_use_effect_shadow.h');
    expect(windows).not.toContain('computer_use_effect_classifier.h');
    expect(harness).toContain('#include "computer_use_effect_shadow.h"');
    expect(harness).toContain('Computer Use native effect shadow: PASS');
    expect(harness).toContain('Computer Use native effect page scroll: PASS');
  });

  it('changes no version and attests nothing', () => {
    expect(read('computer_use_preflight_classifier.h')).toContain(
      'kNativePreflightClassifierVersion = 1;',
    );
    const table = JSON.parse(read('eligibility.json')) as { versions: Record<string, number> };
    expect(table.versions).toEqual({ rulesetVersion: 1, classifierVersion: 1, lexiconVersion: 1 });
    expect(macos).not.toContain('single_use_approval');
  });

  it('calls the core only through the shadow, and only from the shadow section', () => {
    expect(macos).not.toContain('ClassifyEffect(');
    expect(macos.match(/ShadowClassify\(/gu)).toHaveLength(1);
    expect(shadowSection()).toContain('ShadowClassify(capture, info, v1_ordinary)');
  });

  it('returns the v1 receipt exactly as built, and cannot throw out of the shadow', () => {
    const wrapper =
      /NativePreflightReceipt PerformNativePreflight\(const NativeDispatchRequest& request\) \{\s*NativePreflightReceipt receipt = PerformNativePreflightV1\(request\);\s*RecordEffectShadow\(request, receipt\.decision == "ordinary"\);\s*return receipt;\s*\}/u;
    expect(macos).toMatch(wrapper);
    expect(shadowSection()).toContain(
      'void RecordEffectShadow(const NativeDispatchRequest& request, bool v1_ordinary) noexcept {',
    );
    expect(shadowSection()).toContain('catch (...)');
    // Nothing else calls the shadow, and the preflight worker still issues the ticket from the receipt.
    expect(macos.match(/RecordEffectShadow\(/gu)).toHaveLength(2);
    expect(macos).toContain('work->receipt = PerformNativePreflight(work->request);');
    expect(macos).toContain('work->receipt = IssueOrdinaryTicket(work->request, work->owner);');
  });

  it('reaches no input API, AX action or AX write, and never counts an input attempt', () => {
    const section = shadowSection();
    expect(section).not.toMatch(
      /AXUIElementPerformAction|AXUIElementSetAttributeValue|AXUIElementSetMessagingTimeout|AXUIElementPostKeyboardEvent|CGEventPost|CGEventCreate|CGWarpMouse|CGDisplayMoveCursor|NSEvent|activateWithOptions|input_api_attempts|FocusedWindow\b.*Set|Perform[A-Za-z]*Dispatch\(|RevalidateBoundTarget|OutcomeForValidation|MakeDispatchOutcome|IssueOrdinaryTicket|session->state_mutex|state_lock|ticket/u,
    );
  });

  it('reads a closed set of AX attributes, and the value of static text only', () => {
    const section = shadowSection();
    const attributes = new Set(
      [...section.matchAll(/\bkAX([A-Za-z]+)Attribute\b/gu)].map((entry) => entry[1]),
    );
    expect([...attributes].sort()).toEqual(
      [
        'Children',
        'Description',
        'FocusedUIElement',
        'FocusedWindow',
        'Filename',
        'Help',
        'Identifier',
        'Parent',
        'PlaceholderValue',
        'Role',
        'Subrole',
        'Title',
        'URL',
        'Value',
      ].sort(),
    );
    const valueRead = section.indexOf('kAXValueAttribute');
    expect(valueRead).toBeGreaterThan(0);
    expect(section.slice(valueRead - 120, valueRead)).toContain('node.role == "AXStaticText"');
    expect(section.match(/kAXValueAttribute/gu)).toHaveLength(1);
  });

  it('logs enum values and counters only, never a label, a title, a URL or a path', () => {
    const section = shadowSection();
    const log = /os_log_info\(([\s\S]*?)\);/u.exec(section);
    expect(log).not.toBeNull();
    const call = log![1]!;
    expect(call).not.toMatch(
      /%s|%@|%\{public\}s|%\{private\}|c_str\(\)|\.label|\.title|\.url|path/u,
    );
    for (const field of [
      'record.action',
      'record.effect_class',
      'record.kind',
      'record.reason',
      'record.gaps',
    ])
      expect(call).toContain(field);
    expect(shadowHeader).toContain('std::is_trivially_copyable_v<ShadowRecord>');
  });

  it('keeps the bounds of the core: nodes, label bytes and neighbours', () => {
    expect(shadowHeader).toContain('kShadowMaxCaptureNodes = kEffectMaxChainNodes + 1');
    expect(shadowHeader).toContain('kEffectMaxLabelBytes');
    expect(shadowHeader).toContain('kEffectMaxNeighborLabels');
    const section = shadowSection();
    expect(section).toContain('kShadowMaxCaptureNodes');
    expect(section).toContain('kEffectMaxNeighborLabels');
    expect(section).toContain('maximum <= 4096');
  });

  it('runs on the serial lane the v1 preflight already holds', () => {
    const worker = /void ExecuteNativePreflight\(napi_env env, void\* data\) \{[\s\S]*?\n\}/u.exec(
      macos,
    );
    expect(worker).not.toBeNull();
    expect(worker![0]).toContain(
      'std::lock_guard<std::mutex> serial_lock(mac_dispatch_serial_mutex);',
    );
    expect(worker![0].indexOf('serial_lock')).toBeLessThan(
      worker![0].indexOf('PerformNativePreflight('),
    );
  });

  it('is recorded in the ADR with the C2 scope and what is left to a real device', () => {
    const adr = readFileSync(
      join(__dirname, '../../../../tasks/designs/adr-computer-use-agent-driven-v2.md'),
      'utf8',
    );
    expect(adr).toContain('classifier v2 の shadow（C2）');
    expect(adr).toContain('実機（#777）で測る事項');
  });
});

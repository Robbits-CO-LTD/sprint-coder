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

/** The section without comments and string contents, so only code is looked at. */
function shadowCode(): string {
  return shadowSection()
    .replace(/\/\/.*$/gmu, '')
    .replace(/"(?:[^"\\]|\\.)*"/gu, '""');
}

/** Every function-like name the section calls or defines (member calls are not names). */
function calledNames(): string[] {
  const keywords = new Set([
    'if',
    'for',
    'while',
    'switch',
    'catch',
    'return',
    'sizeof',
    'static_cast',
    'const_cast',
    'reinterpret_cast',
    'decltype',
    'noexcept',
    'operator',
  ]);
  const code = shadowCode().replace(/(?:\.|->)\s*[A-Za-z_]\w*\s*\(/gu, '(');
  const names = new Set<string>();
  for (const match of code.matchAll(/\b([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*\(/gu))
    if (!keywords.has(match[1]!)) names.add(match[1]!);
  return [...names].sort();
}

/** What the section may call: AX / CF reads, its own helpers, the portable shadow, the log. */
const ALLOWED_CALLS = new Set([
  'AXUIElementCopyAttributeValue',
  'AXUIElementCopyElementAtPosition',
  'AXUIElementCreateApplication',
  'AXUIElementGetTypeID',
  'CFArrayGetCount',
  'CFArrayGetTypeID',
  'CFArrayGetValueAtIndex',
  'CFEqual',
  'CFGetTypeID',
  'CFRelease',
  'CFRetain',
  'CFStringGetCString',
  'CFStringGetLength',
  'CFStringGetMaximumSizeForEncoding',
  'CFStringGetTypeID',
  'CFURLGetString',
  'CFURLGetTypeID',
  'CGPointMake',
  'CaptureShadowChain',
  'CaptureShadowNeighbors',
  'CopyShadowTarget',
  'DispatchCancellationStillValid',
  'EffectShadowRing',
  'EmitShadowRecord',
  'FindShadowSemanticTarget',
  'ReadShadowElement',
  'ReadShadowNode',
  'ReadShadowString',
  'RecordEffectShadow',
  'ShadowCfRef',
  'ShadowClassify',
  'ShadowReader',
  'ShadowSkippedRecord',
  'clock_gettime_nsec_np',
  'os_log_info',
  'std::move',
  // Local variables and lambdas written as `name(...)` initializers.
  'Element',
  'Get',
  'Reset',
  'Step',
  'application',
  'available',
  'budget',
  'buffer',
  'candidate',
  'chain',
  'children_holder',
  'current',
  'focused_window',
  'holder',
  'length',
  'neighbors',
  'output',
  'parent',
  'read',
  'reader',
  'ref_',
  'request',
  'target',
  'text',
]);

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
      /getenv|environ|argv|napi|<chrono>|<random>|#import|CoreGraphics|clock_gettime/u,
    );
    expect(shadowHeader).not.toContain('single_use_approval');
  });

  it('is built into macOS only, and the Windows host does not know it', () => {
    expect(macos).toContain('#include "computer_use_effect_shadow.h"');
    const windows = read('computer_use_windows_host.cc');
    expect(windows).not.toContain('computer_use_effect_shadow.h');
    expect(windows).not.toContain('computer_use_effect_classifier.h');
    expect(harness).toContain('#include "computer_use_effect_shadow.h"');
    for (const line of [
      'Computer Use native effect shadow: PASS',
      'Computer Use native effect shadow bounds: PASS',
      'Computer Use native effect page scroll: PASS',
    ])
      expect(harness).toContain(line);
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
    expect(shadowSection()).toContain(
      'EmitShadowRecord(ShadowClassify(capture, info, v1_ordinary));',
    );
  });

  it('returns the v1 receipt exactly as built, and cannot throw out of the shadow', () => {
    const wrapper =
      /NativePreflightReceipt PerformNativePreflight\(const NativeDispatchRequest& request\) \{\s*NativeTargetValidation v1_validation = NativeTargetValidation::kStaleObservation;\s*NativePreflightReceipt receipt = PerformNativePreflightV1\(request, &v1_validation\);\s*RecordEffectShadow\(request, receipt\.decision == "ordinary", v1_validation\);\s*return receipt;\s*\}/u;
    expect(macos).toMatch(wrapper);
    expect(shadowSection()).toContain('NativeTargetValidation v1_validation) noexcept {');
    expect(shadowSection()).toContain('catch (...)');
    // Nothing else calls the shadow, and the preflight worker still issues the ticket from the receipt.
    expect(macos.match(/RecordEffectShadow\(/gu)).toHaveLength(2);
    expect(macos).toContain('work->receipt = PerformNativePreflight(work->request);');
    expect(macos).toContain('work->receipt = IssueOrdinaryTicket(work->request, work->owner);');
  });

  it('leaves the body of the v1 preflight alone: it only reports how its first validation ended', () => {
    const v1 = /NativePreflightReceipt PerformNativePreflightV1\([\s\S]*?\n\}\n/u.exec(macos);
    expect(v1).not.toBeNull();
    const body = v1![0];
    expect(body.match(/\*initial_validation = /gu)).toHaveLength(1);
    expect(body).not.toMatch(/Shadow|RecordEffect/u);
    // The rest of the v1 sequence is still there, in order.
    const order = [
      'RevalidateBoundTarget(request)',
      'FindBoundSemanticTarget(',
      'ClassifyElementAtPoint(',
      'FreshVisualPatchMatches(',
      'ClassifyFocusedElement(',
      'MakeNullReceipt("ordinary")',
    ].map((needle) => body.indexOf(needle));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('reaches no input API, AX action or AX write: it may call only a closed list of functions', () => {
    const unexpected = calledNames().filter((name) => !ALLOWED_CALLS.has(name));
    expect(unexpected).toEqual([]);
    const code = shadowCode();
    // Not by name and not by constant: no AX action, no string-named attribute, no state change.
    expect(code).not.toMatch(
      /\bkAX\w*Action\b|CFSTR\s*\(|SetAttributeValue|PerformAction|PostKeyboardEvent/u,
    );
    // Not by Objective-C either: no message send, no bridged NSAccessibility attribute, no
    // AppKit / Quartz event or workspace type. The only bracket is the lambda capture.
    expect(code.replaceAll('[&]', '')).not.toMatch(/[[\]]/u);
    expect(code).not.toMatch(
      /NSAccessibility\w*|__bridge|activateWithOptions|NSEvent|CGEvent|NSWorkspace|NSRunningApplication|NSAppleScript|NSTask|NSURLSession|\bsystem\s*\(|\bpopen\s*\(/u,
    );
    expect(code).not.toMatch(
      /input_api_attempts|state_mutex|state_lock|\bticket\b|Perform\w*Dispatch|MakeDispatchOutcome|RevalidateBoundTarget|IssueOrdinaryTicket/u,
    );
    expect(shadowSection()).not.toMatch(/AXUIElementSetMessagingTimeout\(/u);
  });

  it('reads a closed set of AX attributes, and the value of static text only', () => {
    const attributes = new Set(
      [...shadowCode().matchAll(/\bkAX([A-Za-z]+)Attribute\b/gu)].map((entry) => entry[1]),
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
    // The value is read in exactly one place, under exactly this condition.
    expect(shadowCode().match(/kAXValueAttribute/gu)).toHaveLength(1);
    expect(shadowCode()).toMatch(
      /if \(read_static_text_value && node\.role == ""\) read\(kAXValueAttribute, &node\.value\);/u,
    );
    expect(shadowSection()).toContain('node.role == "AXStaticText"');
  });

  it('logs enum values and counters only, never a label, a title, a URL or a path', () => {
    const code = shadowCode();
    // Exactly one logging call in the whole section, and no other way out of the process.
    expect(
      code.match(
        /\b(?:os_log\w*|NSLog|v?f?printf|dprintf|syslog|f?puts|perror)\b|std::(?:cout|cerr|clog)\b/gu,
      ),
    ).toEqual(['os_log_info']);
    expect(code).not.toMatch(/\bf?write\s*\(|std::o?fstream|\bfopen\s*\(/u);
    const log = /os_log_info\(([\s\S]*?)\);/u.exec(shadowSection());
    expect(log).not.toBeNull();
    const call = log![1]!;
    const format = [...call.matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map((entry) => entry[1]).join('');
    // Every conversion is a public unsigned (five of them) or signed (one) integer.
    expect([...format.matchAll(/%\{[a-z]+\}[a-z]+/gu)].map((entry) => entry[0])).toEqual([
      '%{public}u',
      '%{public}u',
      '%{public}u',
      '%{public}u',
      '%{public}u',
      '%{public}d',
    ]);
    expect(format.match(/%/gu)).toHaveLength(6);
    const args = call.slice(call.lastIndexOf('",') + 2);
    for (const field of [
      'record.action',
      'record.effect_class',
      'record.kind',
      'record.reason',
      'record.gaps',
      'record.v1_ordinary',
    ])
      expect(args).toContain(field);
    // Nothing but the record's fields is passed.
    expect(
      args.replace(/static_cast<unsigned>\(record\.\w+\)|record\.v1_ordinary \? 1 : 0|[\s,]/gu, ''),
    ).toBe('');
    expect(shadowHeader).toContain('std::is_trivially_copyable_v<ShadowRecord>');
  });

  it('does not read when v1 could not re-validate the target, or the action was canceled', () => {
    const record = /void RecordEffectShadow\([\s\S]*?\n\}\n/u.exec(shadowSection());
    expect(record).not.toBeNull();
    const body = record![0];
    const skip = body.indexOf('v1_validation != NativeTargetValidation::kValid');
    const cancel = body.indexOf('!DispatchCancellationStillValid(request)');
    const firstRead = body.indexOf('CopyShadowTarget(reader)');
    expect(skip).toBeGreaterThan(0);
    expect(cancel).toBeGreaterThan(skip);
    expect(firstRead).toBeGreaterThan(cancel);
    expect(body).toContain('request.session == nullptr');
    expect(body).toContain('kShadowGapV1Invalid');
    expect(body).toContain('kShadowGapCanceled');
    // A capture that was canceled is not classified.
    expect(body.indexOf('if (reader.canceled)')).toBeGreaterThan(0);
    expect(body.indexOf('if (reader.canceled)')).toBeLessThan(body.indexOf('ShadowClassify('));
  });

  it('spends a budget before every AX read, checks cancellation with it, and stops at the first refusal', () => {
    const section = shadowSection();
    const reader = /struct ShadowReader \{[\s\S]*?\n\};/u.exec(section);
    expect(reader).not.toBeNull();
    expect(reader![0]).toContain('DispatchCancellationStillValid(request)');
    expect(reader![0]).toContain('budget.Spend(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW))');
    expect(reader![0]).toContain('budget(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW))');
    // Every function that reads through AX takes the reader and steps it first.
    for (const name of [
      'ReadShadowString',
      'ReadShadowElement',
      'FindShadowSemanticTarget',
      'CopyShadowTarget',
      'CaptureShadowNeighbors',
    ]) {
      const definition = new RegExp(`\\n[\\w:<>&* ]*\\b${name}\\([\\s\\S]*?\\n\\}\\n`, 'u').exec(
        section,
      );
      expect(definition, name).not.toBeNull();
      expect(definition![0], name).toContain('reader.Step()');
    }
    // Every AX read is preceded, in the same function, by a step.
    const code = shadowCode();
    const reads = [...code.matchAll(/AXUIElementCopy(?:Attribute|ElementAt)\w*\(/gu)];
    expect(reads).toHaveLength(5);
    for (const read of reads) {
      const before = code.slice(0, read.index);
      expect(before.slice(before.lastIndexOf('\n}') + 2)).toContain('reader.Step()');
    }
    // Loops over children stop when the budget does.
    expect(section).toContain('reader.canceled || reader.budget.Exhausted()');
  });

  it('searches for a semantic target with the bound v1 uses, and a failed read is no match', () => {
    const section = shadowSection();
    expect(section).toContain('constexpr std::size_t kSearchStringUnits = 1365;');
    expect(section).not.toMatch(/kAX(?:Identifier|Title)Attribute, 256/u);
    const search = /ShadowCfRef FindShadowSemanticTarget\([\s\S]*?\n\}\n/u.exec(section);
    expect(search).not.toBeNull();
    // An identifier or title that failed, was too long or was cut off, a children read that
    // failed, and an exhausted budget each make the search incomplete.
    expect(search![0].match(/reader\.search_incomplete = true;/gu)!.length).toBeGreaterThanOrEqual(
      4,
    );
    expect(section).toContain('matches == 1 && !reader.search_incomplete');
    expect(section).toContain('if (reader.search_incomplete) capture.read_failed = true;');
  });

  it('never turns a long or failed attribute into an empty string', () => {
    const section = shadowSection();
    expect(section).toContain('return ShadowRead::kTooLong;');
    expect(section).toContain('return ShadowRead::kFailed;');
    // "No value" and "unsupported" are the only absences.
    expect(section).toMatch(
      /error == kAXErrorNoValue \|\| error == kAXErrorAttributeUnsupported \|\|\s*error == kAXErrorNotImplemented/u,
    );
    expect(section).toContain('node.oversize = true;');
    expect(section).toContain('node.read_failed = true;');
    expect(section).toContain('capture.read_failed = true;');
    // The old read helpers, which returned false (empty) over 4096, are not used by the shadow.
    expect(shadowCode()).not.toContain('CopyAccessibilityString');
    expect(shadowCode()).not.toContain('CopyAccessibilityElementAttribute');
    // The chain reaches the root only at a window or the application element.
    expect(section.match(/chain_reached_root = true;/gu)).toHaveLength(1);
  });

  it('keeps the bounds of the core: nodes, label bytes and neighbours', () => {
    expect(shadowHeader).toContain('kShadowMaxCaptureNodes = kEffectMaxChainNodes + 1');
    expect(shadowHeader).toContain('kEffectMaxLabelBytes');
    expect(shadowHeader).toContain('kEffectMaxNeighborLabels');
    const section = shadowSection();
    expect(section).toContain('kShadowMaxCaptureNodes');
    expect(section).toContain('kEffectMaxNeighborLabels');
    expect(section).toContain('kEffectMaxLabelBytes');
    expect(shadowHeader).toMatch(/kShadowMaxAxCalls = 640;/u);
    expect(shadowHeader).toMatch(/kShadowDeadlineNs = 150'000'000;/u);
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

  it('is recorded in the ADR with the C2 scope, the budget and what is left to a real device', () => {
    const adr = readFileSync(
      join(__dirname, '../../../../tasks/designs/adr-computer-use-agent-driven-v2.md'),
      'utf8',
    );
    expect(adr).toContain('classifier v2 の shadow（C2）');
    expect(adr).toContain('実機（#777）で測る事項');
    expect(adr).toContain('150 ms');
    expect(adr).toContain('640');
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source contracts for the portable half of the Windows shadow (classifier v2, S5-b-1). The facts
// and decisions are exercised by the portable harness (computer_use_protocol_fuzz.cc, MSVC and
// clang); what is tied here is the shape: no platform header, no wiring into the Windows host yet
// (S5-b-2 reads UI Automation), the shared helpers the macOS shadow uses too, and no change of any
// attested version.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const read = (name: string): string => readFileSync(join(nativeDirectory, name), 'utf8');
const windowsShadow = read('computer_use_windows_shadow.h');
const sharedShadow = read('computer_use_effect_shadow.h');
const macos = read('computer_use_macos.mm');
const windowsHost = read('computer_use_windows_host.cc');
const harness = read('computer_use_protocol_fuzz.cc');

describe('Windows shadow core (classifier v2, S5-b-1)', () => {
  it('is portable: no Windows or UI Automation header, no clock, no I/O, no approval vocabulary', () => {
    expect(windowsShadow).toContain('#pragma once');
    expect(windowsShadow).toContain('#include "computer_use_effect_shadow.h"');
    for (const header of [sharedShadow, windowsShadow]) {
      expect(header).not.toMatch(
        /<windows\.h>|UIAutomation|IUIAutomation|CoCreateInstance|NormalizeString|<chrono>|<thread>|<random>|<fstream>|getenv|fopen|clock_gettime|QueryPerformanceCounter/u,
      );
      expect(header).not.toMatch(/single_use_approval|SingleUseApproval|ticket/u);
    }
  });

  it('is not wired into the Windows host yet, and changes no version', () => {
    // S5-b-2 reads UI Automation and records the shadow; until then the host does not know it.
    expect(windowsHost).not.toContain('computer_use_windows_shadow.h');
    expect(windowsHost).not.toContain('computer_use_effect_shadow.h');
    expect(windowsHost).not.toContain('computer_use_effect_classifier.h');
    // The versions are candidates only, in the classifier core; nothing here names an attested one.
    for (const header of [sharedShadow, windowsShadow])
      expect(header).not.toMatch(/kNativePreflightClassifierVersion|classifierVersion/u);
    const eligibility = JSON.parse(read('eligibility.json')) as Record<string, unknown>;
    expect(JSON.stringify(eligibility)).not.toMatch(/"classifier[A-Za-z]*":\s*2\b/u);
  });

  it('shares the read helpers with the macOS shadow instead of copying them', () => {
    for (const name of [
      'enum class ShadowReadResult',
      'inline bool ShadowSettle(',
      'ShadowCheckText(',
      'ShadowUnitsTooLong(',
      'class ShadowGate',
      'ProcessShadowLog()',
      'inline void ApplyShadowOrigin(',
    ])
      expect(sharedShadow, name).toContain(name);
    // The Windows header builds on BuildShadowFacts rather than a second copy of the rules.
    expect(windowsShadow).toContain('BuildShadowFacts(ax, shared)');
    // The byte bound is on UTF-8 and nothing is truncated: the check refuses, it never cuts.
    const check = /ShadowCheckText\([\s\S]*?\n\}/u.exec(sharedShadow)?.[0] ?? '';
    expect(check).toContain('normalized_utf8.size() > maximum_bytes');
    expect(check).toContain('IsValidUtf8');
    expect(check).not.toMatch(/substr|resize|erase|truncate/u);
  });

  it('folds and compares roles the same way for every fact (carry-over from C2)', () => {
    // The ideographic space and the voiced half-width W row fold like NFKC.
    expect(sharedShadow).toContain('code == 0x3000');
    expect(sharedShadow).toContain('0x30F7');
    expect(sharedShadow).toContain('0x30FA');
    // The application element and the page root are recognized after folding.
    expect(sharedShadow).toContain('Lowercase(CompatFold(nodes.back().role)) == "axapplication"');
    expect(sharedShadow).toContain('Lowercase(fact.role) == "axwebarea"');
    expect(sharedShadow).not.toContain('Lowercase(node.role) == "axwebarea"');
    expect(sharedShadow).not.toContain('Lowercase(nodes.back().role) == "axapplication"');
  });

  it('keeps the process ring alive for the life of the process (carry-over from C2)', () => {
    expect(sharedShadow).toMatch(
      /ProcessShadowLog\(\)[\s\S]*?static EffectShadowLog \*const log = new EffectShadowLog\(\);/u,
    );
    // macOS uses it; no static with a destructor is left to be destroyed under a queued block.
    expect(macos).toContain('return sprint_coder::computer_use::ProcessShadowLog();');
    expect(macos).not.toMatch(/static sprint_coder::computer_use::EffectShadowLog ring/u);
  });

  it('is built by the harness on both compilers, and the mac harness lines stay', () => {
    expect(harness).toContain('#include "computer_use_windows_shadow.h"');
    for (const line of [
      'Computer Use native effect shadow: PASS',
      'Computer Use native effect shadow bounds: PASS',
      'Computer Use native effect shadow folding: PASS',
      'Computer Use native Windows shadow core: PASS',
      'Computer Use native shadow read helpers: PASS',
    ])
      expect(harness, line).toContain(line);
    expect(harness).toContain('CheckWindowsShadowCore()');
    expect(harness).toContain('CheckShadowReadHelpers()');
  });

  it('maps the Windows surfaces by name, not by title', () => {
    for (const name of [
      'consolewindowclass',
      'pseudoconsolewindow',
      'cascadia_hosting_window_class',
      'cabinetwclass',
      'consent.exe',
      'credentialuibroker.exe',
      'chrome://downloads',
    ])
      expect(windowsShadow, name).toContain(name);
    // The window title is a label for the core; it never decides a surface here.
    const surface = /SurfaceForWindow\([\s\S]*?\n\}/u.exec(windowsShadow)?.[0] ?? '';
    expect(surface).not.toMatch(/\.name\b|chain\[|title/u);
  });
});

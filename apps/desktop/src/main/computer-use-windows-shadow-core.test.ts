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
  it('is portable: only standard and shadow includes, no platform conditional, no clock, no I/O, no approval vocabulary', () => {
    expect(windowsShadow).toContain('#pragma once');
    expect(windowsShadow).toContain('#include "computer_use_effect_shadow.h"');
    const allowedIncludes = new Set([
      '"computer_use_effect_shadow.h"',
      '"computer_use_effect_classifier.h"',
      '<array>',
      '<cstddef>',
      '<cstdint>',
      '<iterator>',
      '<mutex>',
      '<string>',
      '<string_view>',
      '<type_traits>',
      '<vector>',
    ]);
    for (const header of [sharedShadow, windowsShadow]) {
      for (const match of header.matchAll(/^\s*#\s*include\s+(\S+)/gmu))
        expect(allowedIncludes.has(match[1]!), match[1]).toBe(true);
      expect(header).not.toMatch(/#\s*if(n?def)?\s+.*(_WIN32|__APPLE__|__linux__|_MSC_VER)/u);
      expect(header).not.toMatch(
        /windows\.h|UIAutomation|IUIAutomation|CoCreateInstance|NormalizeString|chrono|<thread>|<random>|fstream|getenv|fopen|clock_gettime|QueryPerformanceCounter/iu,
      );
      expect(header).not.toMatch(/single_use_approval|SingleUseApproval|ticket/iu);
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

  it('defines the read helpers in the shared header, and builds the Windows facts on the shared builder', () => {
    // The macOS reader still has its own copy of Settle / Step (same meaning, different corners: an
    // empty string, malformed UTF-8, a stopped state). Converging them, or tying them with a
    // harness, is S5-b-2's job (see the ADR).
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

  it('keeps a page-written class name out of the subrole, and a display name out of the extension', () => {
    // Chromium publishes the HTML class attribute as ClassName; a subrole may only be a known native
    // class, and never inside a page.
    expect(windowsShadow).toContain('IsKnownNativeClass(');
    expect(windowsShadow).toContain(
      '!in_page && windows_shadow_detail::IsKnownNativeClass(node.class_name)',
    );
    // An extension is known only for the item's real name or path.
    expect(windowsShadow).toContain('item_name_is_real_path');
    expect(windowsShadow).toContain('!(capture.item_name_read && capture.item_name_is_real_path)');
  });

  it('judges a UWP window by the process that owns its CoreWindow, and treats command entries as such', () => {
    for (const name of [
      'applicationframewindow',
      'applicationframehost.exe',
      'core_window_process_read',
      'sechealthui.exe',
      'systemsettings.exe',
      'taskmgr.exe',
      '#32770',
      'address band root',
      'shelldll_defview',
    ])
      expect(windowsShadow, name).toContain(name);
    expect(windowsShadow).toContain('kShadowGapOsPromptSurface');
    expect(windowsShadow).toContain('static_assert((kShadowGapOsPromptSurface');
  });

  it('knows the Windows 11 Explorer (XAML address bar, DUI list) and trusts nothing a page wrote', () => {
    for (const name of [
      'autosuggestbox',
      'duilistview',
      'duiviewwndclassname',
      'uiitemsview',
      'hwndview',
      'chrome_widgetwin_',
      'mozillawindowclass',
      'IsWebWindowClass(',
      'NodeInPage(',
      'core_window_process_path.empty()',
    ])
      expect(windowsShadow, name).toContain(name);
    // A class name on a node inside a page is skipped when a surface is looked up.
    expect(windowsShadow).toMatch(/if \(NodeInPage\(capture, index\)\) continue;/u);
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

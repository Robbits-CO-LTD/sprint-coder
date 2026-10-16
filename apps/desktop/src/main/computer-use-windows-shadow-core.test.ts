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

/** The body of one function, or a failure: an extraction that finds nothing must not pass. */
function bodyOf(text: string, signature: string): string {
  const start = text.indexOf(signature);
  expect(start, signature).toBeGreaterThanOrEqual(0);
  const end = text.indexOf('\n}', start);
  expect(end, signature).toBeGreaterThan(start);
  const body = text.slice(start, end + 2);
  expect(body.length, signature).toBeGreaterThan(signature.length + 20);
  return body;
}

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

  it('does not name the shadow headers in the host directly, and changes no version', () => {
    // S5-b-2a added the reader and the UI Automation source (S5-b-2b wires them); the host reaches the shadow only through that source header.
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
    // harness, was left alone in S5-b-2a on purpose (see the ADR).
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
    const check = bodyOf(sharedShadow, 'ShadowCheckText(std::string_view normalized_utf8,');
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

  it('counts a native Document apart from the stricter-than-v1 findings (S5-c-2 PR-4)', () => {
    // The bit is the next free one after the Windows OS-prompt bit (14) and overlaps no other bit.
    expect(sharedShadow).toContain('constexpr std::uint32_t kShadowGapNativeDocument = 1u << 15;');
    expect(windowsShadow).toContain(
      'constexpr std::uint32_t kShadowGapOsPromptSurface = 1u << 14;',
    );
    const bits = [...(sharedShadow + windowsShadow).matchAll(/kShadowGap\w+ = 1u << (\d+);/gu)].map(
      (match) => Number(match[1]),
    );
    expect(bits).toContain(15);
    expect(new Set(bits).size).toBe(bits.length);
    expect(sharedShadow).toContain('static_assert((kShadowGapNativeDocument');
    // The count excludes the bit; the facts and the verdict are not touched by it.
    const squashed = sharedShadow.replace(/\s+/gu, ' ');
    expect(squashed).toContain('(gaps & kShadowGapNativeDocument) == 0');
    expect(squashed).toContain('bool NativeDocumentGap() const');
    expect(windowsShadow).toContain('kShadowGapNativeDocument');
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

  it('keeps the origin, the read gap and the web window consistent with the surface (BOT #784)', () => {
    // The read gap is added by the wrapper on every route, not at the end of the rules.
    expect(windowsShadow).toContain('SurfaceForWindowOnce(capture)');
    const squashed = windowsShadow.replace(/\s+/gu, ' ');
    expect(squashed).toContain(
      'WindowSurface result = SurfaceForWindowOnce(capture); if (!capture.window_class_read || !capture.process_path_read) result.gaps |= kShadowGapReadFailed;',
    );
    // A known download page agrees on the origin, and a web window builds its origin like a page.
    expect(windowsShadow).toContain('facts.origin = OriginState::kOrdinary;');
    expect(windowsShadow).toContain('result.gaps &= ~kShadowGapOrigin;');
    expect(squashed).toContain(
      'if (target_in_page && capture.target_found) ApplyShadowOrigin(true, capture.document_url_read',
    );
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
    // The rules live in SurfaceForWindowOnce; the wrapper only adds the read gap. Both are looked at,
    // and an extraction that finds nothing fails instead of passing.
    for (const signature of [
      'inline WindowSurface SurfaceForWindowOnce(const ShadowUiaCapture &capture) {',
      'inline WindowSurface SurfaceForWindow(const ShadowUiaCapture &capture) {',
    ]) {
      const surface = bodyOf(windowsShadow, signature);
      expect(surface).not.toMatch(/\.name\b|title|help_text|automation_id|\.value\b/u);
    }
    expect(bodyOf(windowsShadow, 'inline WindowSurface SurfaceForWindowOnce(')).toContain(
      'consolewindowclass',
    );
  });
});

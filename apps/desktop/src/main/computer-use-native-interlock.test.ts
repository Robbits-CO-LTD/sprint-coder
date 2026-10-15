import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source contracts for the portable interlock map (classifier v2, S4-1-0). The table itself is
// exercised by the portable harness (computer_use_protocol_fuzz.cc, MSVC and clang). What is tied
// here: the header is portable, nothing calls it yet (wiring is S4-1a / S4-1b), no version moves,
// and the reason codes are the ADR's.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const read = (name: string): string => readFileSync(join(nativeDirectory, name), 'utf8');
const header = read('computer_use_native_interlock.h');
const harness = read('computer_use_protocol_fuzz.cc');

describe('interlock map (classifier v2, S4-1-0)', () => {
  it('is portable: standard headers and the classifier only, no platform conditional, no approval vocabulary', () => {
    expect(header).toContain('#pragma once');
    const allowed = new Set(['"computer_use_effect_classifier.h"', '<cstdint>', '<string_view>']);
    for (const match of header.matchAll(/^\s*#\s*include\s+(\S+)/gmu))
      expect(allowed.has(match[1]!), match[1]).toBe(true);
    expect(header).not.toMatch(/#\s*if(n?def)?\s+.*(_WIN32|__APPLE__|__linux__|_MSC_VER)/u);
    expect(header).not.toMatch(
      /windows\.h|UIAutomation|CoreFoundation|ApplicationServices|chrono|getenv|fopen|fstream|clock_gettime/iu,
    );
    expect(header).not.toMatch(/single_use_approval|SingleUseApproval|ticket/iu);
  });

  it('is not called by any native source yet, and moves no version', () => {
    const sources = readdirSync(nativeDirectory).filter((name) => /\.(h|cc|mm)$/u.test(name));
    for (const name of sources) {
      if (name === 'computer_use_native_interlock.h' || name === 'computer_use_protocol_fuzz.cc')
        continue;
      expect(read(name), name).not.toContain('computer_use_native_interlock.h');
      expect(read(name), name).not.toContain('MapEffectToInterlock');
    }
    expect(header).not.toMatch(/kNativePreflightClassifierVersion|classifierVersion/u);
    const eligibility = JSON.parse(read('eligibility.json')) as {
      versions: Record<string, number>;
    };
    expect(eligibility.versions).toEqual({
      rulesetVersion: 1,
      classifierVersion: 1,
      lexiconVersion: 1,
    });
  });

  it('uses the ADR reason codes and the receipt results', () => {
    expect(header).toContain('"native_shell_surface_blocked"');
    expect(header).toContain('"native_execution_trigger_blocked"');
    expect(header).toContain('"rejected"');
    expect(header).toContain('"paused"');
  });

  it('refuses only on a positive match: a complete ground, the class own reason, a block', () => {
    const squashed = header.replace(/\s+/gu, ' ');
    expect(squashed).toContain(
      'if (facts.action == ActionKind::kObserve || !FactsAreComplete(facts)) return {};',
    );
    expect(squashed).toContain('if (decision.kind == DecisionKind::kBlocked) {');
    expect(squashed).toContain('if (decision.reason == DecisionReason::kSurface)');
    expect(squashed).toContain(
      'if (decision.reason != DecisionReason::kExecutionTrigger) return {};',
    );
    // An executable name opened inside an application is not a trigger.
    expect(squashed).toContain(
      'if (RefusedByExtension(facts) && !IsListedSurface(facts.surface) && !InstallerControlActivated(facts)) return {};',
    );
    // ...except an installer control, which is a trigger wherever it is, extension or not.
    expect(squashed).toContain(
      'return !ItemInSpan(facts) && IsActivating(facts) && TextIsClassifiable(facts) && ActionableContains(facts, kInstallerTerms);',
    );
    // The approval that is closed refuses; the secure and credential classes are not this map's.
    // A control is told from an item by its role, never by whether a file is attached to it, and
    // only an allow list of passive items, matched whole, is an exception (fail closed).
    expect(squashed).toContain('if (!RefusedByExtension(facts) && ItemInSpan(facts)) {');
    expect(squashed).toContain('if (name == item) return true;');
    expect(header).not.toContain('ControlInSpan');
    // A passive item opened from a file manager or a download list stays an E2 / E3 refusal.
    expect(squashed).toContain(
      'if (IsListedSurface(facts.surface) && effect_detail::MayOpen(facts) && facts.extension_known && !approval_open)',
    );
    // ...and only while the rule set has not trusted the approval for that surface.
    expect(squashed).toContain(
      'facts.surface == SurfaceKind::kDownloadPanel ? ruleset.download_open : ruleset.file_manager_open',
    );
    expect(squashed).toContain(
      'MapEffectToInterlock(facts, ClassifyEffect(facts, ruleset), ruleset)',
    );
    // The walk goes up to the nearest KNOWN container, through allow-listed roles only.
    expect(squashed).toContain('if (RoleIsKnownContainer(node.role)) return index > 0;');
    expect(squashed).toContain('if (!RoleIsPassiveItem(node.role)) return false;');
    expect(squashed).toContain('if (name == container) return true;');
    expect(header).not.toContain('ActionableSpan');
    expect(header).not.toMatch(/name\.find\(item\)/u);
    expect(squashed).toContain(
      'static constexpr std::string_view kItems[] = {"row", "cell", "outlinerow", "listitem", "treeitem", "dataitem", "statictext", "text"};',
    );
    expect(header).not.toContain('target_is_file_item');
    expect(squashed).toContain('if (decision.reason == DecisionReason::kApprovalNotEnabled)');
    expect(header).not.toContain('EffectClass::kSecure:');
    expect(header).not.toContain('EffectClass::kCredential:');
  });

  it('is exercised by the harness, which prints its line', () => {
    expect(harness).toContain('#include "computer_use_native_interlock.h"');
    expect(harness).toContain('CheckNativeInterlockMap()');
    expect(harness).toContain('Computer Use native interlock map: PASS');
  });
});

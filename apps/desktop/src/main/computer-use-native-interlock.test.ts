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
const classifier = read('computer_use_effect_classifier.h');
const harness = read('computer_use_protocol_fuzz.cc');

describe('interlock map (classifier v2, S4-1-0)', () => {
  it('is portable: standard headers and the classifier only, no platform conditional, no approval vocabulary', () => {
    expect(header).toContain('#pragma once');
    const allowed = new Set([
      '"computer_use_effect_classifier.h"',
      '<cstdint>',
      '<optional>',
      '<string_view>',
    ]);
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
      // The portable synchronous evaluation (S4-1b-1) is the one other reader; its own contract is
      // in computer-use-native-interlock-capture.test.ts (the .mm reaches the map only through it).
      if (
        name === 'computer_use_native_interlock.h' ||
        name === 'computer_use_native_interlock_capture.h' ||
        name === 'computer_use_protocol_fuzz.cc'
      )
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
    expect(classifier).toContain('if (name == item) return true;');
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
    // The walk goes up to the nearest KNOWN container, through allow-listed roles only. It lives in
    // the core now (the click rule needs it: MayOpen), and the map refers to it.
    const core = classifier.replace(/\s+/gu, ' ');
    expect(core).toContain('if (RoleIsKnownContainer(node.role)) return index > 0;');
    expect(core).toContain('if (!RoleIsPassiveItem(node.role)) return false;');
    expect(core).toContain('if (name == container) return true;');
    expect(core).toContain('if (name == item) return true;');
    expect(squashed).toContain('using effect_detail::ItemInSpan;');
    expect(header).not.toContain('ActionableSpan');
    expect(header).not.toMatch(/name\.find\(item\)/u);
    expect(classifier).not.toMatch(/name\.find\(item\)/u);
    expect(core).toContain(
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

// S5-c-3 PR-3 (#500, ADR v2 section 3.2.5): the strict map of v2 sessions and the session's basis.
// The rows (basis x reason, Notepad's Document, the CVV field) are in the harness; what is tied here
// is the shape that keeps unknown values on the refusing side and the build flags that make a new
// enumerator a compile error.
describe('strict interlock of v2 sessions (S5-c-3 PR-3)', () => {
  const capture = read('computer_use_native_interlock_capture.h');
  const host = read('computer_use_windows_host.cc');
  const repositoryRoot = join(__dirname, '../../../..');
  const strict = header.slice(header.indexOf('// ---- S5-c-3 PR-3: the strict map'));
  const code = (text: string): string => text.replace(/\/\/.*$/gmu, '');

  it('fixes the v2 basis to the takeover policy at compile time', () => {
    expect(header).toContain(
      'static_assert(IncompletePolicyFor(EligibilityBasis::kV2Denylist) == IncompletePolicy::kTakeover,',
    );
    expect(header).toContain(
      'enum class IncompletePolicy : std::uint8_t { kDeferToV1, kTakeover };',
    );
  });

  it('places every reason and kind in a switch without a default, and refuses after it', () => {
    expect(strict.length).toBeGreaterThan(500);
    expect(code(strict)).not.toMatch(/\bdefault\s*:/u);
    expect(code(capture.slice(capture.indexOf('ApplyIncompletePolicy')))).not.toMatch(
      /\bdefault\s*:/u,
    );
    expect(code(strict)).toContain('switch (decision.reason) {');
    expect(code(strict)).toContain('switch (decision.kind) {');
    expect(code(strict)).toContain('return StrictUnclassified(decision.effect_class);\n}');
  });

  it('treats only a value that is there and true as true', () => {
    for (const text of [header, capture])
      expect(code(text)).not.toMatch(/value_or\s*\(\s*true|!=\s*false|==\s*false\s*\)/u);
    expect(code(strict)).toContain('if (!(text_readable.has_value() && *text_readable))');
    expect(code(strict)).toContain(
      'if (!(facts.target_not_web.has_value() && *facts.target_not_web))',
    );
  });

  it('binds the basis to the Windows session and applies its policy on both interlock calls', () => {
    expect(host).toContain(
      'if (!sprint_coder::computer_use::EligibilityBasisAdmitted(\n          eligibility_basis, sprint_coder::computer_use::kNativeEligibilityIsV2)) {',
    );
    expect(host).toContain('*reason = "eligibility_basis_unsupported";');
    expect(host).toContain('input.eligibility_basis = eligibility_basis;');
    expect(host).toContain('session.eligibility_basis = input.eligibility_basis;');
    expect(host).toContain('expected.eligibility_basis == input.eligibility_basis;');
    expect(host).toContain('expected.eligibility_basis == session.eligibility_basis');
    expect(host).toContain('!WindowsExistingStartRequestMatches(work, measured)');
    expect(host).toContain('!WindowsExistingStartRequestMatches(work, work.before)');
    expect(host).toContain('return sprint_coder::computer_use::ApplyIncompletePolicy(');
    expect(host).toContain(
      'session.eligibility_basis, sprint_coder::computer_use::kNativeEligibilityIsV2)',
    );
  });

  it('makes an unhandled enumerator a build error where the native and the harnesses are built', () => {
    const build = readFileSync(join(repositoryRoot, 'build-computer-use-native.mjs'), 'utf8');
    const gyp = read('binding.gyp');
    const ci = readFileSync(join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
    expect(build).toContain("'/we4062',");
    expect(gyp).toContain('"-Werror=switch"');
    expect(ci.match(/\/W4 \/GS \/sdl \/utf-8 \/we4062 /gu)).toHaveLength(2);
    expect(ci.match(/-fno-omit-frame-pointer[^\n]*-Werror=switch \\/gu)).toHaveLength(2);
  });

  it('is exercised by the harness, which prints its line', () => {
    expect(harness).toContain('if (!CheckStrictInterlock()) return 1;');
    expect(harness).toContain('Computer Use native strict interlock: PASS');
  });
});

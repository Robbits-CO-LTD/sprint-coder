import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source contracts for the artifact read judgement (#785 T15-4p). The table is exercised by the
// portable harness (computer_use_protocol_fuzz.cc, every role against every condition). What is
// tied here: the header is portable, nothing calls it yet (the native read is T15-4m / T15-4w), it
// names no approval or version, and its refusal conditions stay written out.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const read = (name: string): string => readFileSync(join(nativeDirectory, name), 'utf8');
const name = 'computer_use_artifact_read_judgement.h';
const header = read(name);
const harness = read('computer_use_protocol_fuzz.cc');

describe('artifact read judgement (#785 T15-4p)', () => {
  it('is portable: standard headers and the classifier only, no platform code, no approval or version', () => {
    expect(header).toContain('#pragma once');
    const allowed = new Set([
      '"computer_use_effect_classifier.h"',
      '<cstdint>',
      '<string>',
      '<string_view>',
    ]);
    for (const match of header.matchAll(/^\s*#\s*include\s+(\S+)/gmu))
      expect(allowed.has(match[1]!), match[1]).toBe(true);
    expect(header).not.toMatch(/#\s*if(n?def)?\s+.*(_WIN32|__APPLE__|__linux__|_MSC_VER)/u);
    expect(header).not.toMatch(
      /windows\.h|UIAutomation|CoreFoundation|ApplicationServices|chrono|getenv|fopen|fstream|clock_gettime|napi/iu,
    );
    expect(header).not.toMatch(
      /single_use_approval|SingleUseApproval|ticket|approval|classifierVersion|rulesetVersion|lexiconVersion|kNativePreflightClassifierVersion/iu,
    );
  });

  it('is called by the Windows read only (T15-4w; macOS is T15-4m), and moves no version', () => {
    const sources = readdirSync(nativeDirectory).filter((file) => /\.(h|cc|mm)$/u.test(file));
    // The Windows read (portable) is the one caller; the host reaches it through that header.
    expect(read('computer_use_windows_artifact_read.h')).toContain('JudgeArtifactRead(');
    for (const file of sources) {
      if (
        file === name ||
        file === 'computer_use_protocol_fuzz.cc' ||
        file === 'computer_use_windows_artifact_read.h'
      )
        continue;
      expect(read(file), file).not.toContain(name);
      expect(read(file), file).not.toContain('JudgeArtifactRead');
    }
    const eligibility = JSON.parse(read('eligibility.json')) as {
      versions: Record<string, number>;
    };
    expect(eligibility.versions).toEqual({
      rulesetVersion: 1,
      classifierVersion: 1,
      lexiconVersion: 1,
    });
  });

  it('writes out every refusal condition and the per-platform allow list (fail closed)', () => {
    const squashed = header.replace(/\s+/gu, ' ');
    expect(squashed).toContain(
      'if (!facts.metadata_complete || facts.surface == SurfaceKind::kUnknown || !facts.browser_identity_checked) add(Reason::kFactsMissing);',
    );
    expect(squashed).toContain(
      'if (!artifact_read_detail::RoleIsReadable(facts.platform, role)) add(Reason::kRoleNotAllowed);',
    );
    expect(squashed).toContain('if (facts.secure) add(Reason::kSecure);');
    expect(squashed).toContain('if (facts.high_impact) add(Reason::kHighImpact);');
    expect(squashed).toContain(
      'if (facts.surface != SurfaceKind::kOrdinary) add(Reason::kSurfaceNotOrdinary);',
    );
    expect(squashed).toContain(
      'if (facts.origin == OriginState::kSensitive || facts.origin == OriginState::kUnknown) add(Reason::kOriginSensitiveOrUnknown);',
    );
    expect(squashed).toContain(
      'if (facts.origin != OriginState::kNotApplicable || facts.browser_identity_match) add(Reason::kBrowserWindow);',
    );
    expect(squashed).toContain(
      'return name == "statictext" || name == "textfield" || name == "textarea";',
    );
    expect(squashed).toContain(
      'return unstripped == "text" || unstripped == "edit" || unstripped == "document";',
    );
    expect(squashed).toContain('if (platform != ArtifactReadPlatform::kWindows) return false;');
    // The macOS list is closed as well: it ends at the three roles.
    expect(squashed).toContain(
      'return name == "statictext" || name == "textfield" || name == "textarea"; }',
    );
    // The facts default to a refusal: unknown surface, unknown origin, nothing checked.
    expect(squashed).toContain('SurfaceKind surface = SurfaceKind::kUnknown;');
    expect(squashed).toContain('OriginState origin = OriginState::kUnknown;');
    expect(squashed).toContain('bool metadata_complete = false;');
    expect(squashed).toContain('bool browser_identity_checked = false;');
  });

  it('is exercised by the harness, which prints its line', () => {
    expect(harness).toContain(`#include "${name}"`);
    expect(harness).toContain('CheckArtifactReadJudgement()');
    expect(harness).toContain('Computer Use artifact read judgement: PASS');
  });
});

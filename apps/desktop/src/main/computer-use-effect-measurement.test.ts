import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Classifier v2, C4-1: the measurement an approval is judged on, as portable pure functions. The
// behaviour is in the harness; this is the source contract around it: portable, not wired, no
// version raised, and the authority digest not knowing what changes between approval and input.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const read = (name: string): string => readFileSync(join(nativeDirectory, name), 'utf8');
const measurement = read('computer_use_effect_measurement.h');
const sha256 = read('computer_use_sha256.h');
const harness = read('computer_use_protocol_fuzz.cc');

function functionBody(source: string, signature: string): string {
  const from = source.indexOf(signature);
  expect(from, signature).toBeGreaterThanOrEqual(0);
  const to = source.indexOf('\n}\n', from);
  expect(to, signature).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('Computer Use approval measurement (classifier v2, C4-1)', () => {
  it('is portable: standard headers only, nothing that reads the process or a clock', () => {
    for (const source of [measurement, sha256]) {
      const includes = [...source.matchAll(/^#include <([^>]+)>/gmu)].map((entry) => entry[1]);
      for (const include of includes)
        expect(['array', 'cstddef', 'cstdint', 'string', 'string_view']).toContain(include);
      expect(source).not.toMatch(
        /getenv|environ|argv|napi|<chrono>|<random>|<mutex>|#import|CoreGraphics|clock_gettime|CommonCrypto/u,
      );
      expect(source).not.toContain('single_use_approval');
    }
  });

  it('is not wired: no native source includes it, so no production path uses it', () => {
    for (const name of ['computer_use_macos.mm', 'computer_use_windows_host.cc']) {
      const source = read(name);
      expect(source, name).not.toContain('computer_use_effect_measurement.h');
      expect(source, name).not.toContain('computer_use_sha256.h');
    }
    expect(harness).toContain('#include "computer_use_effect_measurement.h"');
    expect(harness).toContain('Computer Use native effect measurement: PASS');
  });

  it('raises no version and attests nothing', () => {
    expect(read('computer_use_preflight_classifier.h')).toContain(
      'kNativePreflightClassifierVersion = 1;',
    );
    const table = JSON.parse(read('eligibility.json')) as { versions: Record<string, number> };
    expect(table.versions).toEqual({ rulesetVersion: 1, classifierVersion: 1, lexiconVersion: 1 });
  });

  it('frames the authority under its domain, and the frame does not know the revisions', () => {
    expect(measurement).toContain('kApprovalAuthorityDomain = "approval-authority-v1"');
    const frame = functionBody(measurement, 'inline std::string ApprovalAuthorityFrame(');
    expect(frame).toContain('AppendLengthPrefixed(&frame, kApprovalAuthorityDomain);');
    // Its inputs are the identity, the facts and the core's decision: no request, session or
    // approval facts, and so no observation revision or ticket generation to include.
    const signature = /ApprovalAuthorityFrame\(([^)]*)\)/u.exec(measurement)![1]!;
    expect(signature).toContain('ApprovalAuthorityIdentity');
    expect(signature).toContain('EffectFacts');
    expect(signature).toContain('EffectDecision');
    expect(signature).not.toMatch(/NativeApprovalFacts|Request|Session/u);
    expect(frame.replaceAll('binding.neighbors_digest', '')).not.toMatch(
      /observation|ticket|revision|action|neighbor/u,
    );
    // The page's origin, and, for a confirmation, the captions and the place, are bound; every node
    // of the chain is length-prefixed field by field.
    for (const needle of [
      'AppendString(&frame, "site", binding.origin);',
      'if (binding.content_bound) {',
      'AppendLengthPrefixed(&frame, node.role);',
      'AppendLengthPrefixed(&frame, node.subrole);',
      'AppendLengthPrefixed(&frame, node.label);',
    ])
      expect(frame, needle).toContain(needle);
    // Absent is told from empty by a marker, and every value is length-prefixed.
    expect(measurement).toContain("output->push_back(field.present ? 'P' : 'A');");
    expect(measurement).toContain("output->push_back(':');");
    // The digest is the SHA-256 of the frame, from the portable implementation.
    expect(functionBody(measurement, 'inline std::string ApprovalAuthorityDigest(')).toContain(
      'Sha256Hex(ApprovalAuthorityFrame(identity, binding, facts, decision))',
    );
  });

  it('offers an intent only for route v2, an enabled approval, native facts and current versions', () => {
    const judge = functionBody(measurement, 'inline IntentVerdict JudgeIntentOffer(');
    for (const needle of [
      'route != ClassifierRoute::kV2',
      'attested_classifier_version != kEffectClassifierVersion',
      'source == HighImpactSource::kMainProjection) return refuse(IntentRefusal::kNotNativeFacts)',
      'source != HighImpactSource::kNativeFacts',
      'RulesetIsTheVersionsOwn(ruleset)',
      'decision.kind != DecisionKind::kApproval',
      'decision.approval_effect == NativeApprovalEffect::kInvalid',
      'kEffectClassifierVersion',
      'kEffectRulesetVersion',
      'kEffectLexiconVersion',
      'RulesetEnables(ruleset, decision.approval_effect)',
    ])
      expect(judge, needle).toContain(needle);
    // The Main projection can only strengthen: nothing grants from it.
    expect(
      functionBody(measurement, 'inline NativeApprovalMeasurement MeasureApproval('),
    ).not.toContain('kMainProjection');
    // The order is the contract: the route, then the attest, then the decision.
    expect(judge.indexOf('ClassifierRoute::kV2')).toBeLessThan(
      judge.indexOf('attested_classifier_version != kEffectClassifierVersion'),
    );
    expect(judge.indexOf('attested_classifier_version != kEffectClassifierVersion')).toBeLessThan(
      judge.indexOf('decision.kind != DecisionKind::kApproval'),
    );
  });

  it('binds the content and the place of a confirmation only, and keeps a v1 route out first', () => {
    const derive = functionBody(measurement, 'DeriveAuthorityBinding(');
    expect(derive).toContain(
      'decision.approval_effect != NativeApprovalEffect::kHighImpactConfirmation) return derived;',
    );
    expect(derive).toContain('NormalizeOrigin(capture.web_area_url)');
    const measure = functionBody(measurement, 'inline NativeApprovalMeasurement MeasureApproval(');
    const order = [
      'input.capture == nullptr',
      'input.route != ClassifierRoute::kV2',
      'BuildShadowFacts(',
      'DecisionKind::kTakeover',
      'AuthorityIdentityIsWhole(input.identity)',
      'JudgeIntentOffer(',
      'DeriveAuthorityBinding(',
      '!derived.complete',
      'measured.eligible = true;',
    ].map((needle) => measure.indexOf(needle));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('treats a page whose origin cannot be told as nobody to approve for', () => {
    // The authority ends at "/", "?", "#" or a backslash; a local file has no host; an empty origin
    // makes the binding incomplete (a takeover) instead of a shared "no origin".
    expect(measurement).toContain('rest.find_first_of("/?#\\\\")');
    expect(measurement).toContain('if (host.empty() || scheme == "file") return std::string();');
    expect(measurement).toContain('if (origin.empty()) derived.complete = false;');
    // A flag added to the rule set must be compared in RulesetIsTheVersionsOwn.
    expect(measurement).toContain('static_assert(sizeof(EffectRuleset) == 4 * sizeof(bool),');
    const own = functionBody(measurement, 'inline bool RulesetIsTheVersionsOwn(');
    for (const flag of [
      'download_open',
      'file_manager_open',
      'high_impact_confirmation',
      'supervised_action',
    ])
      expect(own, flag).toContain(`ruleset.${flag} == canonical.${flag}`);
  });

  it('is recorded in the ADR with the C4-1 contract', () => {
    const adr = readFileSync(
      join(__dirname, '../../../../tasks/designs/adr-computer-use-agent-driven-v2.md'),
      'utf8',
    );
    expect(adr).toContain('C4-1');
    expect(adr).toContain('approval-authority-v1');
  });
});

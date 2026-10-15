import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NATIVE_APPROVAL_CLASSIFIER_VERSION,
  NATIVE_APPROVAL_EFFECTS,
} from './computer-use-native-host';

// Source contracts for classifier v2 C4-2c-1: the split high-impact vocabulary, the approved-effect
// judgement, and the portable parts of an approval offer. The behaviour is in the portable harness
// (computer_use_protocol_fuzz.cc, MSVC and clang), including the golden "with no approved effect the
// result is the v1 one". What is tied here: the headers are portable, the macOS addon reads its
// words from the table, nothing sets an approved effect yet, no addon source spells the approval
// decision word, and the receipt words and bounds are the ones Main parses.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const read = (name: string): string => readFileSync(join(nativeDirectory, name), 'utf8');
const risk = read('computer_use_native_approved_risk.h');
const offer = read('computer_use_native_approval_offer.h');
const decisions = read('computer_use_preflight_classifier.h');
const macos = read('computer_use_macos.mm');
const harness = read('computer_use_protocol_fuzz.cc');
const host = readFileSync(join(__dirname, 'computer-use-native-host.ts'), 'utf8');
const code = (text: string): string =>
  text.replace(/\/\/.*$/gmu, '').replace(/"(?:[^"\\]|\\.)*"/gu, '""');

const includesOf = (text: string): string[] =>
  [...text.matchAll(/^\s*#\s*include\s+(\S+)/gmu)].map((match) => match[1]!);

describe('approved risk and approval offer (classifier v2, C4-2c-1)', () => {
  it('keeps both headers portable: standard headers and the portable cores only', () => {
    expect(new Set(includesOf(risk))).toEqual(
      new Set([
        '"computer_use_native_approval_ticket.h"',
        '"computer_use_preflight_classifier.h"',
        '<array>',
        '<cstddef>',
        '<string_view>',
      ]),
    );
    expect(new Set(includesOf(offer))).toEqual(
      new Set([
        '"computer_use_native_approval_flow.h"',
        '"computer_use_native_approval_ticket.h"',
        '<array>',
        '<cstddef>',
        '<cstdint>',
        '<string>',
        '<string_view>',
        '<utility>',
      ]),
    );
    for (const header of [risk, offer]) {
      expect(header).toContain('#pragma once');
      expect(header).not.toMatch(/#\s*if(n?def)?\s+.*(_WIN32|__APPLE__|__linux__|_MSC_VER)/u);
      expect(header).not.toMatch(
        /windows\.h|UIAutomation|CoreFoundation|ApplicationServices|<chrono>|getenv|fopen|fstream|clock_gettime|napi/iu,
      );
    }
  });

  it('carries the Japanese words of the table in a way no compiler character set can misread (BOM)', () => {
    expect(
      readFileSync(join(nativeDirectory, 'computer_use_native_approved_risk.h')).subarray(0, 3),
    ).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  it('moves no version', () => {
    expect(decisions).toContain('constexpr std::uint32_t kNativePreflightClassifierVersion = 1;');
    const eligibility = JSON.parse(read('eligibility.json')) as {
      versions: Record<string, number>;
    };
    expect(eligibility.versions).toEqual({
      rulesetVersion: 1,
      classifierVersion: 1,
      lexiconVersion: 1,
    });
  });

  it('relaxes only an approved high-impact confirmation, on positive evidence, nothing else', () => {
    const squashed = code(risk).replace(/\s+/gu, ' ');
    expect(squashed).toContain(
      'if (approved_effect == NativeApprovalEffect::kHighImpactConfirmation && bits.high_impact && bits.confirmation && !bits.other) high_impact = false;',
    );
    // The result still goes through the v1 judgement, with the (possibly relaxed) high-impact bit.
    expect(squashed).toContain(
      'return ClassifyNativePreflightFacts({true, bits.classified, bits.secure, high_impact});',
    );
    // The default is no effect.
    expect(squashed).toContain(
      'NativeApprovalEffect approved_effect = NativeApprovalEffect::kInvalid',
    );
    // Secure and unclassified are not mentioned by the relaxation.
    const relax = /if \(approved_effect ==[\s\S]*?high_impact = false;/u.exec(code(risk))![0];
    expect(relax).not.toMatch(/secure|classified/u);
  });

  it('reads the macOS words from the table, and no longer spells the vocabulary itself', () => {
    expect(macos).toContain('#include "computer_use_native_approved_risk.h"');
    const node = /AxRiskClassification ClassifyAccessibilityElementNode\([\s\S]*?\n\}\n/u.exec(
      macos,
    )![0];
    expect(node).toContain('ClassifyHighImpactText(normalized)');
    expect(node).toContain(
      'classification.high_impact = high_impact_bits.confirmation || high_impact_bits.other;',
    );
    for (const word of ['"payment"', '"terminal"', '"決済"', '"pay now"', '"sudo"'])
      expect(code(macos), word).not.toContain(word);
    // The words that stay in the table, split.
    expect(risk).toContain('kConfirmationSubstring');
    expect(risk).toContain('kOtherBounded');
    // The parent chain only strengthens each bit.
    expect(macos).toContain(
      'classification.high_impact_confirmation || current_classification.high_impact_confirmation',
    );
    expect(macos).toContain(
      'classification.high_impact_other || current_classification.high_impact_other',
    );
  });

  it('adds the approved effect to the request and RiskOutcome without changing a caller; nothing sets it', () => {
    // RiskOutcome takes the effect as a defaulted last argument and judges through ClassifyNativeRisk.
    const squashed = macos.replace(/\s+/gu, ' ');
    expect(squashed).toContain(
      'bool RiskOutcome(const AxRiskClassification& risk, NativeDispatchOutcome* outcome, sprint_coder::computer_use::NativeApprovalEffect approved_effect = sprint_coder::computer_use::NativeApprovalEffect::kInvalid) {',
    );
    expect(squashed).toContain(
      'ClassifyNativeRisk( {risk.classified, risk.secure, risk.high_impact, risk.high_impact_confirmation, risk.high_impact_other}, approved_effect);',
    );
    // Every call site passes two arguments (the effect is the default). THIS IS RELAXED IN C4-2c-2,
    // where the approved dispatch is the only caller that passes an effect.
    const calls = [...macos.matchAll(/\bRiskOutcome\(([^;]*?)\)\) /gu)].map((match) => match[1]!);
    expect(calls.length).toBeGreaterThanOrEqual(7);
    for (const args of calls) expect(args.split(',').length, args).toBe(2);
    // The request carries it, defaulted; no code assigns it (the producer is C4-2c-2, after the
    // execution ticket is consumed).
    expect(macos).toMatch(
      /sprint_coder::computer_use::NativeApprovalEffect approved_effect =\s*sprint_coder::computer_use::NativeApprovalEffect::kInvalid;/u,
    );
    expect(code(macos)).not.toMatch(/\.approved_effect\s*=[^=]/u);
    expect(code(macos)).not.toMatch(/->approved_effect\s*=[^=]/u);
  });

  it('writes the approval decision word in one native place only, and offers nothing from the addon yet', () => {
    const sources = readdirSync(nativeDirectory).filter((name) => /\.(h|cc|mm)$/u.test(name));
    for (const name of sources) {
      if (name === 'computer_use_protocol_fuzz.cc') continue;
      // Comments may name it; code may not (the string literal lives in the decision-name function).
      const text = read(name).replace(/\/\/.*$/gmu, '');
      if (name === 'computer_use_preflight_classifier.h')
        expect(text).toContain('return "single_use_approval";');
      else expect(text, name).not.toContain('single_use_approval');
    }
    // The macOS addon does not use the offer header yet (C4-2c-2 wires it).
    expect(macos).not.toContain('computer_use_native_approval_offer.h');
    expect(macos).not.toMatch(/BuildApprovalIntentBinding|NativeApprovalRemainingMs|\.Offer\(/u);
  });

  it('spells the offer receipt the way Main parses it', () => {
    // The effect words are Main's.
    const words = [...offer.matchAll(/return "([a-z_]+)";/gu)].map((match) => match[1]!);
    expect([...words].sort()).toEqual([...NATIVE_APPROVAL_EFFECTS].sort());
    // The classifier version of an offer and the wait bound.
    expect(offer).toContain(
      `kNativeApprovalOfferClassifierVersion = ${NATIVE_APPROVAL_CLASSIFIER_VERSION};`,
    );
    expect(host).toContain('const NATIVE_APPROVAL_WAIT_MAX_MS = 60_000;');
    expect(offer).toContain("kNativeApprovalWaitMaxNs / 1'000'000ULL");
    expect(read('computer_use_native_approval_ticket.h')).toContain(
      "kNativeApprovalWaitMaxNs = 60'000'000'000ULL",
    );
    expect(offer).toContain('kNativePreflightReceiptVersion = 2;');
    // The key sets are Main's, in order of appearance.
    const keysOf = (name: string, text: string): string[] => {
      const body = new RegExp(`${name} = \\[([\\s\\S]*?)\\]`, 'u').exec(text)![1]!;
      return [...body.matchAll(/'([A-Za-z]+)'/gu)].map((match) => match[1]!);
    };
    const nativeKeys = (name: string): string[] => {
      const body = new RegExp(`${name} = \\{([\\s\\S]*?)\\};`, 'u').exec(offer)![1]!;
      return [...body.matchAll(/"([A-Za-z]+)"/gu)].map((match) => match[1]!);
    };
    const v1 = keysOf('NATIVE_PREFLIGHT_KEYS', host);
    expect(nativeKeys('kNativePreflightReceiptKeysV1')).toEqual(v1);
    expect(nativeKeys('kNativePreflightReceiptKeysV2')).toEqual([...v1, 'receiptVersion']);
    expect(nativeKeys('kNativeApprovalOfferReceiptKeys')).toEqual([
      ...v1,
      'receiptVersion',
      'approvalGeneration',
      'remainingMs',
      'effect',
    ]);
  });

  it('is exercised by the harness', () => {
    expect(harness).toContain('#include "computer_use_native_approved_risk.h"');
    expect(harness).toContain('#include "computer_use_native_approval_offer.h"');
    for (const name of [
      'approved-risk-union-is-the-v1-vocabulary',
      'approved-risk-text-equals-frozen-v1',
      'approved-risk-equals-v1-unless-relaxed',
      'approved-risk-only-confirmation-words-alone-relax',
      'offer-binding-fields',
      'offer-flow-consume',
    ])
      expect(harness, name).toContain(`"${name}"`);
    expect(harness).toContain('Computer Use native approved risk: PASS');
    expect(harness).toContain('Computer Use native approval offer: PASS');
  });
});

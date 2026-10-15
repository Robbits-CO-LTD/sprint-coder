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

  it('writes every word of the table as a u8 literal, and the file starts with a BOM like the classifier header', () => {
    expect(
      readFileSync(join(nativeDirectory, 'computer_use_native_approved_risk.h')).subarray(0, 3),
    ).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  it('has no narrow string literal in the word table, and no word outside the u8 arrays', () => {
    const table = /namespace high_impact_terms \{[\s\S]*?\} \/\/ namespace high_impact_terms/u.exec(
      risk,
    )![0];
    const literals = [...table.matchAll(/(u8)?"([^"\n]*)"/gu)];
    expect(literals.length).toBeGreaterThan(60);
    // (the compile-time message of the empty-word check is the one narrow literal)
    for (const literal of literals.filter((entry) => !entry[2]!.includes('empty high-impact word')))
      expect(literal[1], literal[0]).toBe('u8');
    expect(table).not.toMatch(/std::array<std::string_view/u);
    // An empty word would match every text; the header refuses it at compile time.
    expect(risk).toContain('NoEmptyWord(kConfirmationSubstring)');
    expect(literals.some((literal) => literal[2] === '')).toBe(false);
  });

  it('has the same words in the ADR classification table as in the header, group by group', () => {
    const adr = readFileSync(
      join(__dirname, '../../../../tasks/designs/adr-computer-use-agent-driven-v2.md'),
      'utf8',
    );
    const wordsOf = (name: string): string[] => {
      const body = new RegExp(`${name} = \\{([\\s\\S]*?)\\};`, 'u').exec(risk)![1]!;
      return [...body.matchAll(/u8"([^"]*)"/gu)].map((match) => match[1]!);
    };
    const adrWords = (label: string): string[] => {
      const line = adr.split(/\r?\n/u).find((entry) => entry.includes(label));
      expect(line, label).toBeDefined();
      // The words follow the label's colon (the label itself may name a word in backticks).
      const words = line!.slice(line!.indexOf(': ') + 2);
      return [...words.matchAll(/`([^`]+)`/gu)].map((match) => match[1]!);
    };
    const same = (adrSide: string[], headerSide: string[], what: string): void => {
      expect(new Set(adrSide).size, `${what}: duplicate in the ADR`).toBe(adrSide.length);
      expect([...adrSide].sort(), what).toEqual([...headerSide].sort());
    };
    same(
      adrWords('確定・部分一致:'),
      [...wordsOf('kConfirmationSubstring'), ...wordsOf('kConfirmationSubstringJa')],
      'confirmation (substring)',
    );
    same(adrWords('確定・単独の語'), wordsOf('kConfirmationBounded'), 'confirmation (bounded)');
    same(
      adrWords('緩めない・曖昧語'),
      [...wordsOf('kOtherSubstring'), ...wordsOf('kOtherSubstringJa')],
      'ambiguous',
    );
    same(
      adrWords('緩めない・実行面'),
      [...wordsOf('kOtherBounded'), ...wordsOf('kOtherSurfaceJa')],
      'surface',
    );
  });

  it('keeps the ADR bullets of C4-2b and C4-2c-1 on their own lines', () => {
    const adr = readFileSync(
      join(__dirname, '../../../../tasks/designs/adr-computer-use-agent-driven-v2.md'),
      'utf8',
    );
    for (const lead of ['**C4-2b の契約', '**C4-2c-1 の契約', '**高影響語の分類表'])
      expect(adr, lead).toMatch(new RegExp(`(^|\\n) {4}- ${lead.replace(/\*/gu, '\\*')}`, 'u'));
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
    // The two v1 preflight calls pass two arguments (the effect is the default, so they are v1). The
    // dispatch guards pass the request's own effect, which is kInvalid unless a person approved this
    // dispatch; nothing else is ever passed.
    const calls = [...macos.matchAll(/\bRiskOutcome\(([^;]*?)\)\) /gu)].map((match) => match[1]!);
    expect(calls).toHaveLength(7);
    const withEffect = calls.filter((args) => args.split(',').length === 3);
    expect(withEffect).toHaveLength(5);
    for (const args of withEffect)
      expect(args.endsWith('request.approved_effect'), args).toBe(true);
    const preflight = /NativePreflightReceipt PerformNativePreflightV1\([\s\S]*?\n\}\n/u.exec(
      macos,
    )![0];
    expect(preflight.match(/RiskOutcome\(risk, &outcome\)/gu)).toHaveLength(2);
    expect(preflight).not.toContain('approved_effect');
    // The request carries it, defaulted, and exactly one line assigns it: the approved dispatch, right
    // after the execution ticket was consumed against the fresh measurement (never for a preflight).
    expect(macos).toMatch(
      /sprint_coder::computer_use::NativeApprovalEffect approved_effect =\s*sprint_coder::computer_use::NativeApprovalEffect::kInvalid;/u,
    );
    expect(code(macos).match(/\bapproved_effect\s*=[^=]/gu)).toHaveLength(3); // member default, RiskOutcome default, the one assignment
    const assignments = [...macos.matchAll(/\.approved_effect\s*=[^=]/gu)];
    expect(assignments).toHaveLength(1);
    const worker = /void ExecuteNativeApprovedDispatch\([\s\S]*?\n\}\n/u.exec(macos)![0];
    expect(worker).toContain('work->request.approved_effect = measured.effect;');
    expect(worker.indexOf('consumed = true;')).toBeLessThan(
      worker.indexOf('work->request.approved_effect = measured.effect;'),
    );
    expect(worker.indexOf('work->request.approved_effect = measured.effect;')).toBeLessThan(
      worker.indexOf('PerformNativeDispatch(work->request)'),
    );
    // Only after ConsumeApproved succeeded.
    expect(worker.indexOf('ConsumeApproved(')).toBeLessThan(
      worker.indexOf('work->request.approved_effect = measured.effect;'),
    );
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
    // The macOS addon uses the offer header in exactly one function, the preflight's approval offer.
    expect(macos).toContain('#include "computer_use_native_approval_offer.h"');
    const issue = /NativePreflightReceipt IssueApprovalOffer\([\s\S]*?\n\}\n/u.exec(macos)![0];
    expect(issue).toContain('BuildApprovalIntentBinding(measured, context, &intent)');
    expect(issue).toContain('NativeApprovalRemainingMs(');
    expect(issue).toContain('NextNativeApprovalGeneration(session.approval_generation_counter');
    expect(macos.match(/BuildApprovalIntentBinding\(/gu)).toHaveLength(1);
    expect(macos.match(/\.Offer\(/gu)).toHaveLength(1);
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

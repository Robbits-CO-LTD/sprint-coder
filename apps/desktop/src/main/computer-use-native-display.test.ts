import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ComputerUseNativeApprovalOffer } from './computer-use-controller';
import {
  computerUseWindowsApprovalDisplaySchema,
  computerUseNativeExtensionSchema,
} from '@sprint-coder/contracts';
import {
  sanitizeNativeDisplayLabel,
  nativeDisplayWhitespaceRanges,
  nativeDisplayIgnorableRanges,
} from './computer-use-native-display';

describe('Windows native display labels', () => {
  it.each(['\uD800', '\uDFFF', 'a\uD800b', '\uDC00\uD800'])(
    'rejects lone surrogates %j',
    (value) => {
      expect(sanitizeNativeDisplayLabel(value)).toEqual({ kind: 'rejected' });
    },
  );
  it('sanitizes astral ignorables and counts marks after an astral base', () => {
    expect(sanitizeNativeDisplayLabel('a\u{E0041}b\u{1D173}c')).toEqual({
      kind: 'verified',
      label: 'abc',
    });
    expect(sanitizeNativeDisplayLabel('\u{1D15E}' + '\u0301'.repeat(5))).toEqual({
      kind: 'verified',
      label: '\u{1D15E}' + '\u0301'.repeat(4),
    });
    expect(sanitizeNativeDisplayLabel('😀'.repeat(128))).toEqual({
      kind: 'verified',
      label: '😀'.repeat(128),
    });
    expect(sanitizeNativeDisplayLabel('😀'.repeat(129))).toEqual({ kind: 'rejected' });
  });
  it.each(['\t', '\n', '\u0085', '\u2028'])('preserves word separation for %j', (space) => {
    expect(sanitizeNativeDisplayLabel(`one${space}two`)).toEqual({
      kind: 'verified',
      label: 'one two',
    });
  });
  it.each([
    ['sample\u202Etxt.exe', 'sampletxt.exe'],
    ['\u0301a', 'a'],
    ['a \u0301 b', 'a b'],
    ['a' + '\u0301'.repeat(6), 'a' + '\u0301'.repeat(4)],
    ['a\u0301\u0301\u200D\u0301\u0301\u115F\u0301', 'a' + '\u0301'.repeat(4)],
    ['a \u202E b', 'a b'],
  ])('sanitizes %j', (input, label) => {
    expect(sanitizeNativeDisplayLabel(input)).toEqual({ kind: 'verified', label });
  });
  it.each(['', '\u115F\u1160\u3164\uFFA0', '\u0301 \u0301'])(
    'marks empty sanitized labels unverified',
    (input) => {
      expect(sanitizeNativeDisplayLabel(input)).toEqual({ kind: 'unverified' });
    },
  );
  it('checks UTF-8 bytes only after sanitization and never truncates', () => {
    expect(sanitizeNativeDisplayLabel('é'.repeat(256) + '\u202E')).toEqual({
      kind: 'verified',
      label: 'é'.repeat(256),
    });
    expect(sanitizeNativeDisplayLabel('é'.repeat(256) + 'a')).toEqual({ kind: 'rejected' });
  });
  it('pins exactly the native whitespace and ignorable ranges', () => {
    const source = readFileSync(
      new URL('../../computer-use-native/computer_use_effect_classifier.h', import.meta.url),
      'utf8',
    );
    for (const [name, ranges] of [
      ['IsWhitespace', nativeDisplayWhitespaceRanges],
      ['IsDefaultIgnorable', nativeDisplayIgnorableRanges],
    ] as const) {
      const body = source.split(`bool ${name}(char32_t code) {`)[1]!.split('}')[0]!;
      const parsed = [
        ...body.matchAll(
          /code == (0x[0-9A-F]+)|\(code >= (0x[0-9A-F]+) && code <= (0x[0-9A-F]+)\)/gu,
        ),
      ].map((match) => [Number(match[1] ?? match[2]), Number(match[1] ?? match[3])]);
      expect(ranges).toEqual(parsed);
    }
  });
});

describe('Windows display strict effect table', () => {
  it('binds each offer effect to the matching display effect', () => {
    type Offer = Extract<ComputerUseNativeApprovalOffer, { effect: 'download_open' }>;
    expectTypeOf<NonNullable<Offer['display']>['effect']>().toEqualTypeOf<'download_open'>();
    expectTypeOf<
      NonNullable<
        Extract<ComputerUseNativeApprovalOffer, { effect: 'supervised_action' }>['display']
      >['effect']
    >().toEqualTypeOf<'supervised_action'>();
    expectTypeOf<
      NonNullable<
        Extract<ComputerUseNativeApprovalOffer, { effect: 'high_impact_confirmation' }>['display']
      >['effect']
    >().toEqualTypeOf<'high_impact_confirmation'>();
    expectTypeOf<
      NonNullable<
        Extract<ComputerUseNativeApprovalOffer, { effect: 'file_manager_open' }>['display']
      >['effect']
    >().toEqualTypeOf<'file_manager_open'>();
  });
  it('pins schema whitespace and ignorable sets to the native ranges', () => {
    const source = readFileSync(
      new URL('../../../../packages/contracts/src/index.ts', import.meta.url),
      'utf8',
    );
    for (const [name, ranges] of [
      ['nativeDisplayWhitespaceRanges', nativeDisplayWhitespaceRanges],
      ['nativeDisplayIgnorableRanges', nativeDisplayIgnorableRanges],
    ] as const) {
      const body = source.split(name + ':')[1]!.split('];')[0]!;
      const parsed = [...body.matchAll(/\[(0x[0-9a-f]+), (0x[0-9a-f]+)\]/gu)].map((match) => [
        Number(match[1]),
        Number(match[2]),
      ]);
      expect(parsed).toEqual(ranges);
    }
  });
  it('pins extension character classes and length to native normalization and validation', () => {
    const source = readFileSync(
      new URL('../../computer-use-native/computer_use_effect_classifier.h', import.meta.url),
      'utf8',
    );
    const plain = source
      .split('bool IsPlainExtension(std::string_view extension) {')[1]!
      .split('\n}')[0]!;
    const maximum = Number(plain.match(/extension\.size\(\) > (\d+)/u)![1]);
    const ranges = [...plain.matchAll(/character >= '(.)' && character <= '(.)'/gu)].map(
      (match) => [match[1]!.charCodeAt(0), match[2]!.charCodeAt(0)],
    );
    const singles = [...plain.matchAll(/character == '(.)'/gu)].map((match) => match[1]);
    expect(plain).toContain('extension.empty()');
    expect(maximum).toBe(32);
    for (let code = 0; code <= 0x7f; code++) {
      const character = String.fromCharCode(code);
      expect(computerUseNativeExtensionSchema.safeParse(character).success).toBe(
        ranges.some(([first, last]) => code >= first! && code <= last!) ||
          singles.includes(character),
      );
    }
    expect(computerUseNativeExtensionSchema.safeParse('a'.repeat(maximum)).success).toBe(true);
    expect(computerUseNativeExtensionSchema.safeParse('a'.repeat(maximum + 1)).success).toBe(false);
    const normalize = source
      .split('std::string NormalizeExtension(std::string_view extension) {')[1]!
      .split('\n}')[0]!;
    expect(normalize.replace(/\s+/gu, ' ').trim()).toBe(
      "std::string text = NormalizeForMatch(extension); const auto trim = [](char character) { return character == '.' || character == ' ' || character == '\\t'; }; while (!text.empty() && trim(text.front())) text.erase(text.begin()); while (!text.empty() && trim(text.back())) text.pop_back(); return text;",
    );
  });
  it.each([
    'a\u0000b',
    'a\u202Eb',
    'a\u115Fb',
    ' a',
    'a ',
    'a  b',
    'a\tb',
    'a\u00A0b',
    'a\uD800',
    'a\u{E0041}b',
  ])('rejects unsanitized schema labels %j', (targetLabel) => {
    expect(
      computerUseWindowsApprovalDisplaySchema.safeParse({
        effect: 'download_open',
        operation: 'invoke',
        targetLabel,
        extension: 'txt',
        externalApplication: 'may_open',
        unsignedWarning: 'none',
      }).success,
    ).toBe(false);
  });
  it('checks the schema UTF-8 boundary at exactly 512 and 513 bytes', () => {
    const display = {
      effect: 'download_open',
      operation: 'invoke',
      extension: 'txt',
      externalApplication: 'may_open',
      unsignedWarning: 'none',
    };
    expect(
      computerUseWindowsApprovalDisplaySchema.safeParse({
        ...display,
        targetLabel: 'é'.repeat(256),
      }).success,
    ).toBe(true);
    expect(
      computerUseWindowsApprovalDisplaySchema.safeParse({
        ...display,
        targetLabel: 'é'.repeat(256) + 'a',
      }).success,
    ).toBe(false);
  });
  for (const effect of [
    'supervised_action',
    'high_impact_confirmation',
    'download_open',
    'file_manager_open',
  ] as const) {
    const opens = effect === 'download_open' || effect === 'file_manager_open';
    const display = {
      effect,
      operation: 'click',
      targetLabel: 'sample',
      extension: opens ? 'txt' : null,
      externalApplication: opens ? 'may_open' : 'not_applicable',
      unsignedWarning: 'none',
    };
    it(`${effect}: accepts its table and rejects missing/extra/null/mismatched fields`, () => {
      expect(computerUseWindowsApprovalDisplaySchema.safeParse(undefined).success).toBe(false);
      expect(computerUseWindowsApprovalDisplaySchema.safeParse(null).success).toBe(false);
      expect(computerUseWindowsApprovalDisplaySchema.safeParse(display).success).toBe(true);
      for (const key of Object.keys(display)) {
        const missing: Record<string, unknown> = { ...display };
        delete missing[key];
        expect(computerUseWindowsApprovalDisplaySchema.safeParse(missing).success, key).toBe(false);
      }
      for (const key of [
        'effect',
        'operation',
        'externalApplication',
        'unsignedWarning',
        ...(opens ? ['targetLabel', 'extension'] : []),
      ]) {
        expect(
          computerUseWindowsApprovalDisplaySchema.safeParse({ ...display, [key]: null }).success,
          key,
        ).toBe(false);
      }
      for (const patch of [
        { unknown: true },
        { operation: 'observe' },
        { externalApplication: opens ? 'not_applicable' : 'may_open' },
        { unsignedWarning: 'unsigned' },
        { extension: opens ? 'TXT.' : 'txt' },
        { targetLabel: '' },
        { targetLabel: 'é'.repeat(257) },
      ]) {
        expect(
          computerUseWindowsApprovalDisplaySchema.safeParse({ ...display, ...patch }).success,
        ).toBe(false);
      }
      expect(
        computerUseWindowsApprovalDisplaySchema.safeParse({ ...display, targetLabel: null })
          .success,
      ).toBe(!opens);
      const operations =
        effect === 'supervised_action'
          ? [
              'click',
              'double_click',
              'invoke',
              'set_text',
              'type',
              'key',
              'scroll',
              'select',
              'toggle',
              'expand_collapse',
            ]
          : effect === 'high_impact_confirmation'
            ? ['click', 'double_click', 'invoke', 'toggle', 'select', 'key']
            : ['click', 'double_click', 'invoke', 'key'];
      for (const operation of operations)
        expect(
          computerUseWindowsApprovalDisplaySchema.safeParse({
            ...display,
            operation,
            unsignedWarning: 'main_image_only',
          }).success,
        ).toBe(true);
      for (const operation of [
        'set_text',
        'type',
        'scroll',
        'select',
        'toggle',
        'expand_collapse',
      ].filter((value) => !operations.includes(value)))
        expect(
          computerUseWindowsApprovalDisplaySchema.safeParse({ ...display, operation }).success,
        ).toBe(false);
    });
  }
  it.each([
    ['c++', true],
    ['x_t', true],
    ['a'.repeat(32), true],
    ['a'.repeat(33), false],
    ['TXT', false],
    ['txt.', false],
    ['', false],
  ])('validates the already normalized extension %j', (value, accepted) => {
    expect(computerUseNativeExtensionSchema.safeParse(value).success).toBe(accepted);
  });
});

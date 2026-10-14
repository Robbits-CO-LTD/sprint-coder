import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NATIVE_APPROVAL_EFFECTS } from './computer-use-native-host';

const nativeDirectory = join(__dirname, '../../computer-use-native');
const read = (name: string): string => readFileSync(join(nativeDirectory, name), 'utf8');
const header = read('computer_use_effect_classifier.h');
const harness = read('computer_use_protocol_fuzz.cc');

const LEXICON_TABLES = [
  'kSecureTerms',
  'kSecureBoundedTerms',
  'kCredentialTerms',
  'kCredentialPrefixTerms',
  'kSurfaceTerms',
  'kConfirmTerms',
  'kInstallerTerms',
  'kOpenTerms',
] as const;
const EXTENSION_TABLES = ['kExecutableExtensions', 'kInstallerExtensions'] as const;

/** The body of one `inline constexpr std::...string_view name[] = {...};`. */
function body(name: string): string {
  const match = new RegExp(`${name}\\[\\] = \\{([\\s\\S]*?)\\};`, 'u').exec(header);
  expect(match, name).not.toBeNull();
  return match![1]!;
}

function terms(name: string): string[] {
  return [...body(name).matchAll(/"([^"]*)"/gu)].map((entry) => entry[1]!);
}

/** FNV-1a 64-bit with the same separator and version bytes the header uses. */
function digest(parts: string[], versions: number[]): bigint {
  const mask = (1n << 64n) - 1n;
  let hash = 14695981039346656037n;
  const step = (byte: number): void => {
    hash ^= BigInt(byte);
    hash = (hash * 1099511628211n) & mask;
  };
  for (const part of parts) {
    for (const byte of Buffer.from(part, 'utf8')) step(byte);
    step(0xff);
  }
  for (const version of versions)
    for (const shift of [24, 16, 8, 0]) step((version >> shift) & 0xff);
  return hash;
}

describe('Computer Use effect classifier core (classifier v2, C1)', () => {
  it('is portable: standard headers only, nothing that reads the process', () => {
    const includes = [...header.matchAll(/^#include <([^>]+)>/gmu)].map((entry) => entry[1]);
    for (const include of includes)
      expect(['array', 'cstddef', 'cstdint', 'span', 'string', 'string_view', 'vector']).toContain(
        include,
      );
    expect(header).toContain('#include "computer_use_native_approval_ticket.h"');
    expect(header).not.toMatch(/getenv|environ|argv|napi|<chrono>|<random>|#import|CoreGraphics/u);
  });

  it('keeps the candidate versions apart from the attested ones (no version is raised yet)', () => {
    expect(header).toContain('kEffectClassifierVersion = 2');
    expect(header).toContain('kEffectRulesetVersion = 2');
    expect(header).toContain('kEffectLexiconVersion = 2');
    expect(read('computer_use_preflight_classifier.h')).toContain(
      'kNativePreflightClassifierVersion = 1;',
    );
    const table = JSON.parse(read('eligibility.json')) as { versions: Record<string, number> };
    expect(table.versions).toEqual({ rulesetVersion: 1, classifierVersion: 1, lexiconVersion: 1 });
  });

  it('is included by no native source directly (macOS reaches it only through the shadow)', () => {
    for (const name of ['computer_use_macos.mm', 'computer_use_windows_host.cc'])
      expect(read(name), name).not.toContain('computer_use_effect_classifier.h');
    expect(harness).toContain('#include "computer_use_effect_classifier.h"');
  });

  it('never writes the approval decision name in the header or the native sources', () => {
    expect(header).not.toContain('single_use_approval');
    expect(read('computer_use_macos.mm')).not.toContain('single_use_approval');
  });

  it('produces only the four approval effects the ticket slot knows', () => {
    for (const name of [
      'kDownloadOpen',
      'kFileManagerOpen',
      'kHighImpactConfirmation',
      'kSupervisedAction',
    ])
      expect(header).toContain(`NativeApprovalEffect::${name}`);
    expect(NATIVE_APPROVAL_EFFECTS).toHaveLength(4);
  });

  it('pins the digest of its versioned tables in the header, recomputed independently', () => {
    const lexicon = LEXICON_TABLES.flatMap((name) => terms(name));
    const extensions = EXTENSION_TABLES.flatMap((name) => terms(name));
    const expected = digest([...lexicon, '|extensions|', ...extensions, '|versions|'], [2, 2, 2])
      .toString(16)
      .padStart(16, '0');
    // The pin is a static_assert in the header itself, so every translation unit checks it.
    expect(header).toContain(`kEffectTablesDigestPinned = 0x${expected}ULL`);
    expect(header).toContain('static_assert(kEffectTablesDigest == kEffectTablesDigestPinned');
  });

  it('does not depend on the compiler character set: BOM, and u8 literals for every lexicon term', () => {
    for (const name of ['computer_use_effect_classifier.h', 'computer_use_protocol_fuzz.cc'])
      expect(readFileSync(join(nativeDirectory, name)).subarray(0, 3), name).toEqual(
        Buffer.from([0xef, 0xbb, 0xbf]),
      );
    for (const name of LEXICON_TABLES) {
      expect(header).toContain(`std::u8string_view ${name}[] = {`);
      const text = body(name);
      // Every string literal is a u8 literal.
      expect([...text.matchAll(/"/gu)].length, name).toBe([...text.matchAll(/u8"/gu)].length * 2);
    }
    // A harness string that carries CJK text is a u8 literal as well.
    const narrowCjk = [...harness.matchAll(/"(?:[^"\\\n]|\\.)*"/gu)].filter(
      (match) =>
        [...match[0]].some((character) => character.codePointAt(0)! > 0x7f) &&
        !harness.slice(match.index - 2, match.index).includes('u8'),
    );
    expect(narrowCjk.map((match) => match[0])).toEqual([]);
  });

  it('runs the core from main and says so in the log', () => {
    expect(harness).toContain('if (!CheckEffectClassifierCore()) return 1;');
    expect(harness).toContain('Computer Use native effect classifier core: PASS');
  });

  it('is built as UTF-8 by the offline verification script on Windows too', () => {
    const script = readFileSync(
      join(__dirname, '../../../../verify-computer-use-native-offline.mjs'),
      'utf8',
    );
    expect(script).toContain("'/utf-8'");
  });

  it('keeps every term lowercase and the installer extensions inside the executable set', () => {
    for (const name of [...LEXICON_TABLES, ...EXTENSION_TABLES])
      for (const term of terms(name)) {
        expect(term.length, name).toBeGreaterThan(0);
        expect(term, name).toBe(term.toLowerCase());
      }
    const executable = new Set(terms('kExecutableExtensions'));
    for (const extension of terms('kInstallerExtensions'))
      expect(executable.has(extension)).toBe(true);
  });

  it('is compiled as UTF-8 by every Windows harness build (the tables carry CJK terms)', () => {
    for (const workflow of ['ci.yml', 'release-beta.yml']) {
      const text = readFileSync(join(__dirname, '../../../../.github/workflows', workflow), 'utf8');
      expect(text, workflow).toContain('/W4 /GS /sdl /utf-8');
      expect(text, workflow).toContain('/Zi /utf-8 /fsanitize=address');
    }
  });

  it('is recorded in the ADR with the decisions, the split and the six enabling conditions', () => {
    const adr = readFileSync(
      join(__dirname, '../../../../tasks/designs/adr-computer-use-agent-driven-v2.md'),
      'utf8',
    );
    expect(adr).toContain('classifier v2 の実装契約と判断（2026-10-14）');
    for (const marker of [
      '1-A: 分類器 v1 と v2 の共存は、セッションの route で選ぶ',
      '2-A: 最初に有効化する承認は',
      '3-A: Main の投影による highImpact は strengthen にだけ使う',
      '本番で `single_use_approval` を返し始める 6 条件',
      '| C6  |',
      'C2 で実際の facts を測ったあとに調整する事項',
    ])
      expect(adr).toContain(marker);
  });
});

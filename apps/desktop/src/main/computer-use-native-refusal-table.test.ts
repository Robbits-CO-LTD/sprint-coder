import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NATIVE_PREFLIGHT_REFUSALS } from './computer-use-native-host';

// Source contracts for the closed blocked / takeover receipt table (classifier v2, S4-1a). The
// interlock reasons are accepted by the receipt tables on both sides, and nothing returns them yet.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const source = readFileSync(join(nativeDirectory, 'computer_use_macos.mm'), 'utf8');
const interlock = readFileSync(join(nativeDirectory, 'computer_use_native_interlock.h'), 'utf8');

function between(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, start).toBeGreaterThanOrEqual(0);
  expect(to, end).toBeGreaterThan(from);
  return source.slice(from, to);
}

const INTERLOCK_CODES = [
  'native_shell_surface_blocked',
  'native_execution_trigger_blocked',
  'native_approval_not_enabled',
] as const;

describe('closed receipt table (S4-1a)', () => {
  const table = between(
    'constexpr NativePreflightRefusalEntry kNativePreflightRefusalTable[] = {',
    '};',
  );
  const nativePairs = [
    ...table.matchAll(/\{"(blocked|takeover)", "(native_[a-z_]+)", "(rejected|paused)"\}/gu),
  ].map((match) => `${match[1]}|${match[2]}|${match[3]}`);

  it('is the same set of (decision, reason, result) on both sides', () => {
    const mainPairs = NATIVE_PREFLIGHT_REFUSALS.map(
      (entry) => `${entry.decision}|${entry.reasonCode}|${entry.deniedResult}`,
    );
    expect(nativePairs.length).toBe(6);
    expect([...nativePairs].sort()).toEqual([...mainPairs].sort());
  });

  it('gives every reason code exactly one pair, and the interlock codes the pairs the ADR names', () => {
    const codes = nativePairs.map((pair) => pair.split('|')[1]);
    expect(new Set(codes).size).toBe(codes.length);
    expect(nativePairs).toContain('blocked|native_shell_surface_blocked|rejected');
    expect(nativePairs).toContain('takeover|native_execution_trigger_blocked|paused');
    expect(nativePairs).toContain('blocked|native_approval_not_enabled|rejected');
    // The v1 pairs are unchanged.
    expect(nativePairs).toContain('blocked|native_secure_field_blocked|rejected');
    expect(nativePairs).toContain('takeover|native_high_impact_user_takeover|paused');
    expect(nativePairs).toContain('takeover|native_target_unclassified|rejected');
  });

  it('is read by both the receipt maker and the closed-receipt check, with no pair written twice', () => {
    const maker = between(
      'NativePreflightReceipt PreflightReceiptFromOutcome(',
      'bool NativePreflightReceiptIsClosed(',
    );
    const closed = between(
      'bool NativePreflightReceiptIsClosed(',
      'void SealNativePreflightReceipt(',
    );
    expect(maker).toContain('kNativePreflightRefusalTable');
    expect(closed).toContain('kNativePreflightRefusalTable');
    for (const literal of [
      'native_secure_field_blocked',
      'native_high_impact_user_takeover',
      ...INTERLOCK_CODES,
    ])
      for (const body of [maker, closed]) expect(body).not.toContain(literal);
  });

  it('is only a table: no native path returns an interlock reason yet', () => {
    for (const code of INTERLOCK_CODES) {
      const occurrences = source.split(`"${code}"`).length - 1;
      expect(occurrences, code).toBe(1);
    }
    expect(source).not.toContain('computer_use_native_interlock.h');
    expect(source).not.toContain('MapEffectToInterlock');
  });

  it('matches the codes the interlock map produces', () => {
    for (const code of INTERLOCK_CODES) expect(interlock).toContain(`"${code}"`);
  });
});

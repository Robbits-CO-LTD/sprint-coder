import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NATIVE_PREFLIGHT_REFUSALS } from './computer-use-native-host';

// Source contracts for the closed blocked / takeover receipt table (classifier v2, S4-1a). The
// interlock reasons are accepted by the receipt tables on both sides, and nothing returns them yet.
// The table is one portable header that the native, the portable harness and this test all read.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const source = readFileSync(join(nativeDirectory, 'computer_use_macos.mm'), 'utf8');
const interlock = readFileSync(join(nativeDirectory, 'computer_use_native_interlock.h'), 'utf8');
const tableHeader = readFileSync(
  join(nativeDirectory, 'computer_use_native_refusal_table.h'),
  'utf8',
);
const harness = readFileSync(join(nativeDirectory, 'computer_use_protocol_fuzz.cc'), 'utf8');

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
  const start = tableHeader.indexOf('kNativePreflightRefusalTable[] = {');
  const table = tableHeader.slice(start, tableHeader.indexOf('};', start));
  // Every element is counted by its opening brace and quote, and the strict pattern must fit every
  // one of them: an element it does not fit (another result, an upper case letter or a digit in a
  // reason) is not skipped.
  const elementCount = table.split('{"').length - 1;
  const matches = [
    ...table.matchAll(/\{"(blocked|takeover)", "(native_[a-z_]+)", "(rejected|paused)"\}/gu),
  ];
  const nativePairs = matches.map((match) => `${match[1]}|${match[2]}|${match[3]}`);

  it('is the same set of (decision, reason, result) on both sides', () => {
    expect(start).toBeGreaterThanOrEqual(0);
    const mainPairs = NATIVE_PREFLIGHT_REFUSALS.map(
      (entry) => `${entry.decision}|${entry.reasonCode}|${entry.deniedResult}`,
    );
    expect(elementCount).toBe(6);
    expect(matches.length).toBe(elementCount);
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
    // The native reads the portable table and keeps no copy of its own.
    expect(source).toContain('#include "computer_use_native_refusal_table.h"');
    expect(source).not.toContain('NativePreflightRefusalEntry');
    expect(source).not.toContain('kNativePreflightRefusalTable[] =');
  });

  it('is only a table: no native path returns an interlock reason yet', () => {
    for (const code of INTERLOCK_CODES) {
      expect(source, code).not.toContain(`"${code}"`);
      expect(tableHeader.split(`"${code}"`).length - 1, code).toBe(1);
    }
    expect(source).not.toContain('computer_use_native_interlock.h');
    expect(source).not.toContain('MapEffectToInterlock');
  });

  it('matches what the interlock map produces, by looking the pair up in the table', () => {
    for (const code of INTERLOCK_CODES) expect(interlock).toContain(`"${code}"`);
    // The map names the receipt's decision, and its pair is looked up in the table by the harness,
    // never repeated there.
    expect(interlock).toContain('"blocked"');
    expect(interlock).toContain('"takeover"');
    expect(harness).toContain('#include "computer_use_native_refusal_table.h"');
    expect(harness).toContain('NativePreflightRefusalAllowed(');
    expect(harness).toContain('interlock-verdict-is-a-receipt-pair');
  });
});

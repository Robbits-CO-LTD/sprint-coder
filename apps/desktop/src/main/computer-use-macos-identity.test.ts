import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source contracts for the macOS running-process identity check (ADR v2 D12, section 6.2.1, S4
// contract 3). The check itself needs a signed process and the Security framework, so what is tied
// here is its shape: it judges the running process, it is on every path that already re-verifies
// identity (start, resume, observe, dispatch), it only measures, and it stays out of the preflight.
// The decision table is exercised by the portable harness (computer_use_protocol_fuzz.cc); the
// real signature checks are a human acceptance item.

const nativeDirectory = join(__dirname, '../../computer-use-native');
const source = readFileSync(join(nativeDirectory, 'computer_use_macos.mm'), 'utf8');
const header = readFileSync(join(nativeDirectory, 'computer_use_native_identity.h'), 'utf8');
const harness = readFileSync(join(nativeDirectory, 'computer_use_protocol_fuzz.cc'), 'utf8');

function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  expect(start, from).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(to, start + from.length);
  expect(end, to).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe('macOS running-process identity (D12)', () => {
  it('keeps the decision table portable, with no platform header and no approval vocabulary', () => {
    expect(header).toContain('#pragma once');
    expect(header).not.toMatch(
      /#import|#include <(Security|CoreFoundation|libproc)|SecCode|proc_pid/u,
    );
    expect(header).not.toMatch(/single_use_approval|SingleUseApproval/u);
    expect(source).not.toContain('single_use_approval');
    expect(source).toContain('#include "computer_use_native_identity.h"');
    // The harness runs the table on both platforms' compilers.
    expect(harness).toContain('#include "computer_use_native_identity.h"');
    expect(harness).toContain('CheckNativeRunningIdentity()');
  });

  it('judges the running process, not only the file on disk', () => {
    const running = between(
      source,
      'bool ReadRunningImagePath(',
      'bool CurrentApplicationMatchesIdentityNative(',
    );
    // The code object is the running process's own (by pid), checked strictly, with its designated
    // requirement; the image path is read from the process.
    expect(running).toContain('kSecGuestAttributePid');
    expect(running).toContain('SecCodeCopyGuestWithAttributes(');
    expect(running).toContain('kSecCSStrictValidate');
    expect(running).toContain('SecCodeCheckValidity(code, strict, nullptr)');
    expect(running).toContain('SecCodeCopyDesignatedRequirement(');
    expect(running).toContain('SecCodeCheckValidity(code, strict, requirement)');
    expect(running).toContain('proc_pidpath(');
    expect(running).toContain('kSecCodeInfoUnique');
    // The verdict is the portable one, and only an exact match lets input through.
    expect(running).toContain('CheckRunningIdentity(expected, observed)');
    expect(running).toContain('NativeIdentityAllowsInput(');
    // An image bound as unsigned is held to its exact bytes.
    expect(running).toContain('FileDigest(running)');
  });

  it('only measures: no input, no accessibility action, no focus change, no preflight', () => {
    const running = between(
      source,
      'bool ReadRunningImagePath(',
      'bool CurrentApplicationMatchesIdentityNative(',
    );
    for (const forbidden of [
      'CGEvent',
      'AXUIElementPerformAction',
      'AXUIElementSetAttributeValue',
      'input_api_attempts',
      'Perform',
      'activateWithOptions',
      'NativePreflight',
      'ticket',
    ])
      expect(running, forbidden).not.toContain(forbidden);
  });

  it('is on every existing identity re-check, so start, resume, observe and dispatch gain it', () => {
    const matcher = between(
      source,
      'bool CurrentApplicationMatchesIdentityNative(',
      'bool CurrentApplicationMatchesIdentity(napi_env',
    );
    expect(matcher).toContain('facts.identity_digest == expected_identity');
    expect(matcher).toContain('RunningProcessMatchesBoundIdentity(pid, facts)');
    // The call sites are unchanged and still go through that one function.
    const calls = source.match(/CurrentApplicationMatchesIdentityNative\(/gu) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(7);
    const revalidation = between(
      source,
      'NativeTargetValidation RevalidateBoundTarget(',
      'MacDialogSetSnapshot current;',
    );
    expect(revalidation).toContain('CurrentApplicationMatchesIdentityNative(');
    expect(revalidation).toContain('kIdentityChanged');
    // A failed check closes with the existing identity reason, before any input.
    expect(source).toContain('{"native_app_identity_changed", "rejected"}');
  });

  it('caps an application with no signer at supervised without touching the system TextEdit', () => {
    const cap = between(
      source,
      'std::string MaximumModeForIdentityFacts(const IdentityFacts& facts) {',
      'void SetScreenBoundsProperty(',
    );
    expect(cap).toContain('UncappedMaximumModeForIdentityFacts(facts)');
    expect(cap).toContain('IsExactSystemTextEdit(');
    expect(cap).toContain('CapModeForSigningState(facts.signed_target, mode)');
    // The exemption returns before the cap is applied.
    expect(cap.indexOf('return mode;')).toBeLessThan(cap.indexOf('CapModeForSigningState('));
  });

  it('stays out of the preflight wrapper', () => {
    const preflightStart = source.indexOf('PerformNativePreflight(');
    expect(preflightStart).toBeGreaterThan(0);
    const running = between(
      source,
      'bool ReadRunningImagePath(',
      'bool CurrentApplicationMatchesIdentityNative(',
    );
    expect(running.indexOf('PerformNativePreflight')).toBe(-1);
    expect(source.indexOf('bool ReadRunningImagePath(')).toBeLessThan(preflightStart);
  });
});

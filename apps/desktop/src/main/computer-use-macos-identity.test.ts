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
    expect(running).toContain('SecCodeCheckValidity(code, kRunningValidityFlags, nullptr)');
    expect(running).toContain('SecCodeCheckValidity(code, kRunningValidityFlags, requirement)');
    // The requirement is built from the BOUND signer, never copied from the running code itself.
    expect(running).toContain('SecRequirementCreateWithString(');
    expect(running).not.toContain('SecCodeCopyDesignatedRequirement(');
    expect(running).toContain(
      'RequirementTextForBoundSigner(bound.signing_identifier, bound.team_id)',
    );
    expect(running).toContain('anchor apple generic and identifier');
    expect(running).toContain('certificate leaf[subject.OU]');
    // Mac App Store apps (shared Apple leaf certificate, no team in the OU) must still satisfy it.
    expect(running).toContain(
      'certificate leaf[field.1.2.840.113635.100.6.1.9] or certificate leaf[subject.OU]',
    );
    expect(running).toContain('proc_pidpath(');
    // The call that measures the running process is made with the bound signer and the real result
    // is judged by the portable table, with the reason kept for diagnostics.
    expect(running).toContain('MeasureRunningSignature(pid, bound_requirement, &observed)');
    expect(running).toContain('expected.cd_hash = expected_cd_hash;');
    // The bound code directory hash is read for the slice that is running (Rosetta, universal
    // binaries); an architecture that cannot be read refuses instead of comparing another slice.
    expect(running).toContain('PROC_PIDARCHINFO');
    expect(running).toContain('SecStaticCodeCreateWithPathAndAttributes(');
    expect(running).toContain('const void* keys[] = {kSecCodeAttributeArchitecture};');
    expect(running).toContain('ReadRunningArchitecture(pid, &running_architecture)');
    expect(running).toContain('CopyStaticCdHashForArchitecture(bound_path, running_architecture');
    expect(running).toContain('architecture_unavailable');
    expect(running).toContain('SameMacExecutablePath(running, bound.executable_path)');
    expect(running).toContain('NativeIdentityVerdictName(verdict)');
    expect(running).toContain('kSecCodeInfoUnique');
    // The verdict is the portable one, and only an exact match lets input through.
    expect(running).toContain('CheckRunningIdentity(expected, observed)');
    expect(running).toContain('NativeIdentityAllowsInput(');
    // An image bound as unsigned is held to its bytes on disk (and to its code directory if it had one).
    expect(running).toContain('FileDigest(running)');
  });

  it('passes the dynamic check only flags that SecCodeCheckValidity accepts', () => {
    // SecCodeCheckValidity rejects any flag outside this set with errSecCSInvalidFlags on every call,
    // so a signed target would be refused for good. kSecCSCheckAllArchitectures is static-only.
    const allowed = new Set([
      'kSecCSDefaultFlags',
      'kSecCSConsiderExpiration',
      'kSecCSStrictValidate',
      'kSecCSStrictValidateStructure',
      'kSecCSRestrictSidebandData',
      'kSecCSEnforceRevocationChecks',
      'kSecCSAllowNetworkAccess',
      'kSecCSNoNetworkAccess',
    ]);
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '');
    const calls = [...code.matchAll(/SecCodeCheckValidity\(\s*[A-Za-z_]+\s*,\s*([^,]+?)\s*,/gu)];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // Resolve the flag expression of every dynamic call to the flags it is made of.
    const flagsOf = (expression: string): string[] => {
      const names = expression.split('|').map((part) => part.trim());
      return names.flatMap((name) => {
        if (/^kSecCS/u.test(name)) return [name];
        const definition = new RegExp(
          'constexpr SecCSFlags ' + name + '\\s*=\\s*([^;]+);',
          'u',
        ).exec(code);
        expect(definition, name).not.toBeNull();
        return flagsOf(definition![1]!);
      });
    };
    for (const call of calls)
      for (const flag of flagsOf(call[1]!)) expect(allowed.has(flag), flag).toBe(true);
    // The static check keeps its own flags; the dynamic section never names the static-only one.
    const running = between(
      code,
      'bool ReadRunningImagePath(',
      'bool CurrentApplicationMatchesIdentityNative(',
    );
    expect(running).not.toContain('kSecCSCheckAllArchitectures');
    expect(code).toContain('SecStaticCodeCheckValidity(code, validation_flags, nullptr)');
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

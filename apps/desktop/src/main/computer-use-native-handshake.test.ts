import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseNativeHandshake,
  WINDOWS_APPROVAL_WIRE_VERSION,
  windowsApprovalEvidenceMatches,
} from './computer-use-native-handshake';
import { eligibilityDeclaration } from '../../../../build-computer-use-eligibility.mjs';

const handshake = {
  protocolVersion: 1,
  apiVersion: 3,
  platform: 'win32',
  napiVersion: 10,
};

describe('Windows approval wire negotiation', () => {
  it('ruleset4_helper_cannot_open_browser_control', () => {
    const current = {
      eligibility: eligibilityDeclaration('v2-denylist', 'win32'),
      windowsDocumentViewers: { version: 1, digest: 'a'.repeat(16) },
    };
    const old = { ...current, eligibility: { ...current.eligibility, rulesetVersion: 4 } };
    const wire = {
      ...handshake,
      ...current,
      capabilities: { approval: true, approvalWire: WINDOWS_APPROVAL_WIRE_VERSION },
    };
    expect(windowsApprovalEvidenceMatches(current, current, wire)).toBe(true);
    expect(windowsApprovalEvidenceMatches(current, current, { ...wire, ...old })).toBe(false);
    expect(windowsApprovalEvidenceMatches(current, old, wire)).toBe(false);
    expect(windowsApprovalEvidenceMatches(old, current, wire)).toBe(false);
    expect(windowsApprovalEvidenceMatches(old, old, { ...wire, ...old })).toBe(false);
  });
  it('pins the producer and parser to the native receipt wire version', () => {
    const native = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_windows_approval_wire.h'),
      'utf8',
    );
    expect(native).toMatch(
      new RegExp(`kWindowsApprovalReceiptVersion\\s*=\\s*${WINDOWS_APPROVAL_WIRE_VERSION}`),
    );
    const producer = readFileSync(
      join(__dirname, '../../computer-use-native/computer_use_windows_host_preflight.inc'),
      'utf8',
    );
    expect(producer).toContain(
      'std::to_string(sprint_coder::computer_use::kWindowsApprovalReceiptVersion)',
    );
    expect(producer).toContain('approvalWire');
  });

  it('accepts only the explicit current approval wire version', () => {
    expect(() =>
      parseNativeHandshake(
        { ...handshake, capabilities: { approval: true, approvalWire: 3 } },
        'win32',
      ),
    ).not.toThrow();
  });

  it.each([undefined, null, 1, 2, 4, '3', true])('rejects wire version %s', (approvalWire) => {
    expect(() =>
      parseNativeHandshake(
        { ...handshake, capabilities: { approval: true, approvalWire } },
        'win32',
      ),
    ).toThrow('HANDSHAKE_INVALID');
  });

  it.each([false, undefined])('rejects a wire claim without approval: %s', (approval) => {
    expect(() =>
      parseNativeHandshake({ ...handshake, capabilities: { approval, approvalWire: 3 } }, 'win32'),
    ).toThrow('HANDSHAKE_INVALID');
  });
});

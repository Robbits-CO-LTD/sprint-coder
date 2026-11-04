import { describe, expect, it } from 'vitest';
import { computerUseApprovalPathEnabled } from './computer-use-eligibility';
import { windowsApprovalEvidenceMatches } from './computer-use-native-handshake';

const eligibility = {
  mode: 'v2-denylist',
  classifierVersion: 3,
  rulesetVersion: 2,
  lexiconVersion: 3,
  ticketRequired: true,
  interlockEnforced: true,
} as const;
const viewers = { version: 1, digest: 'a'.repeat(16) };
const declaration = { eligibility, windowsDocumentViewers: viewers };
const handshake = {
  protocolVersion: 1,
  apiVersion: 3,
  napiVersion: 10,
  platform: 'win32',
  ...declaration,
  capabilities: { approval: true, approvalWire: 3 },
};

describe('Windows approval evidence', () => {
  it('requires matching pin, manifest and handshake without widening ordinary eligibility', () => {
    expect(windowsApprovalEvidenceMatches(declaration, declaration, handshake)).toBe(true);
    for (const field of ['eligibility', 'windowsDocumentViewers'] as const) {
      for (const side of [0, 1, 2]) {
        const inputs = [declaration, declaration, handshake].map((item, index) =>
          index === side ? { ...item, [field]: undefined } : item,
        );
        expect(windowsApprovalEvidenceMatches(inputs[0], inputs[1], inputs[2])).toBe(false);
      }
    }
    for (const side of [0, 1, 2])
      for (const interlockEnforced of [undefined, false]) {
        const inputs = [declaration, declaration, handshake].map((item, index) =>
          index === side ? { ...item, eligibility: { ...eligibility, interlockEnforced } } : item,
        );
        expect(windowsApprovalEvidenceMatches(inputs[0], inputs[1], inputs[2])).toBe(false);
      }
    for (const changed of [
      { version: 2, digest: viewers.digest },
      { version: 1, digest: 'b'.repeat(16) },
    ]) {
      for (const side of [0, 1, 2]) {
        const inputs = [declaration, declaration, handshake].map((item, index) =>
          index === side ? { ...item, windowsDocumentViewers: changed } : item,
        );
        expect(windowsApprovalEvidenceMatches(inputs[0], inputs[1], inputs[2])).toBe(false);
      }
    }
    for (const capabilities of [
      undefined,
      {},
      { approval: false },
      { approval: true },
      { approval: true, approvalWire: 2 },
    ])
      expect(
        windowsApprovalEvidenceMatches(declaration, declaration, { ...handshake, capabilities }),
      ).toBe(false);
    for (const field of ['classifierVersion', 'rulesetVersion', 'lexiconVersion'] as const)
      expect(
        windowsApprovalEvidenceMatches(declaration, declaration, {
          ...handshake,
          eligibility: { ...eligibility, [field]: 99 },
        }),
      ).toBe(false);
    expect(
      windowsApprovalEvidenceMatches(declaration, declaration, {
        ...handshake,
        eligibility: { ...eligibility, ticketRequired: false },
      }),
    ).toBe(false);
  });
  it('opens Windows only with internal evidence and preserves darwin and route predicates', () => {
    const input = {
      platform: 'win32',
      methodsExported: true,
      attestedClassifierVersion: 3,
      effectiveMode: 'v2-denylist',
      route: 'v2',
      windowsApprovalReady: true,
    } as const;
    expect(computerUseApprovalPathEnabled(input)).toBe(true);
    expect(computerUseApprovalPathEnabled({ ...input, windowsApprovalReady: false })).toBe(false);
    for (const route of ['v1', 'unbound'] as const)
      expect(computerUseApprovalPathEnabled({ ...input, route })).toBe(false);
    expect(computerUseApprovalPathEnabled({ ...input, effectiveMode: 'v1-allowlist' })).toBe(false);
    expect(
      computerUseApprovalPathEnabled({ ...input, platform: 'darwin', windowsApprovalReady: false }),
    ).toBe(true);
  });
});

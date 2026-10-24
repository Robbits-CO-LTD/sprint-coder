import { describe, expect, it } from 'vitest';
import {
  computerWindowsAppIdentitySchema,
  computerWindowsNativeTargetListSchema,
  computerWindowsTargetFactsSchema,
  type ComputerWindowsTargetFacts,
} from './index';

function facts(overrides: Partial<ComputerWindowsTargetFacts> = {}): ComputerWindowsTargetFacts {
  return {
    platform: 'win32',
    imageRoot: null,
    imageRelativePath: null,
    imageLeaf: null,
    imageVolume: null,
    runningImageMatches: null,
    signature: null,
    signerOrganization: null,
    signerMicrosoftRoot: null,
    signerIsSelf: null,
    acceptanceFixture: null,
    peSubsystem: null,
    originalFilename: null,
    requiresAdministrator: null,
    tokenElevated: null,
    tokenOtherUser: null,
    tokenOtherSession: null,
    tokenProtected: null,
    tokenUiAccess: null,
    tokenIntegrityAboveSelf: null,
    tokenAppContainer: null,
    packaged: null,
    packageFamily: null,
    packageSignatureKind: null,
    packageDevelopmentMode: null,
    ownDescendant: null,
    descendantShell: null,
    descendantPseudoConsole: null,
    windowClass: null,
    ...overrides,
  };
}

function identity() {
  return {
    platform: 'win32',
    identityDigest: 'a'.repeat(64),
    executablePath: 'C:\\Users\\fixture\\Programs\\fixture.exe',
    executableDigest: 'b'.repeat(64),
    signerDigest: null,
    packageFamilyName: null,
    appUserModelId: null,
    displayName: 'Fixture',
    policyLanguage: 'unknown',
    maximumMode: 'observe_only',
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'upper',
    windowId: '123',
    pid: 123,
    appIdentityDigest: 'a'.repeat(64),
    windowIdentityDigest: 'c'.repeat(64),
    executableDigest: 'b'.repeat(64),
    title: 'Fixture window',
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    screenBounds: { x: -1920, y: 0, width: 1920, height: 1080 },
    boundsUnit: 'physical_px',
    maximumMode: 'observe_only',
    identity: identity(),
    facts: facts(),
    ...overrides,
  };
}

function envelope(targets: unknown[] = [row()]) {
  return { generation: 1, rulesetVersion: 2, truncated: false, targets };
}

describe('private native Windows target list', () => {
  it('preserves explicit unknown facts without defaults or a classification claim', () => {
    expect(computerWindowsTargetFactsSchema.parse(facts())).toEqual(facts());
    expect(computerWindowsNativeTargetListSchema.parse(envelope())).toEqual(envelope());
    for (const key of Object.keys(facts())) {
      const incomplete: Record<string, unknown> = { ...facts() };
      delete incomplete[key];
      expect(computerWindowsTargetFactsSchema.safeParse(incomplete).success, key).toBe(false);
    }
  });

  it.each([
    { extra: true },
    { platform: 'darwin' },
    { tokenElevated: 'false' },
    { tokenElevated: 0 },
    { imageVolume: 'unknown' },
    { signature: 'trusted' },
    { peSubsystem: 'GUI' },
    { packageSignatureKind: 'signed' },
  ])('rejects unknown keys, values, and coercions: %j', (override) => {
    expect(computerWindowsTargetFactsSchema.safeParse({ ...facts(), ...override }).success).toBe(
      false,
    );
  });

  it('bounds measured strings by UTF-8 bytes', () => {
    for (const value of ['a'.repeat(1024), 'あ'.repeat(341) + 'a'])
      expect(computerWindowsTargetFactsSchema.safeParse(facts({ imageLeaf: value })).success).toBe(
        true,
      );
    for (const value of ['a'.repeat(1025), 'あ'.repeat(342)])
      expect(computerWindowsTargetFactsSchema.safeParse(facts({ imageLeaf: value })).success).toBe(
        false,
      );
  });

  it('accepts only the kind for refused rows', () => {
    for (const kind of ['denied', 'unresolvable']) {
      expect(computerWindowsNativeTargetListSchema.parse(envelope([{ kind }])).targets).toEqual([
        { kind },
      ]);
      for (const extra of [
        { pid: 123 },
        { title: 'label' },
        { facts: facts() },
        { identity: identity() },
      ])
        expect(
          computerWindowsNativeTargetListSchema.safeParse(envelope([{ kind, ...extra }])).success,
        ).toBe(false);
    }
  });

  it.each([
    { kind: 'eligible' },
    { maximumMode: 'full_access_app' },
    { appIdentityDigest: 'd'.repeat(64) },
    { executableDigest: 'd'.repeat(64) },
    { identity: { ...identity(), maximumMode: 'full_access_app' } },
    { identity: { ...identity(), maximumMode: undefined } },
    { facts: undefined },
    { boundsUnit: 'css_px' },
    { windowId: '0' },
    { windowId: '18446744073709551616' },
    { windowId: 'not-a-number' },
    { pid: 0 },
    { pid: 0x100000000 },
  ])('rejects malformed target bindings: %j', (override) => {
    expect(computerWindowsNativeTargetListSchema.safeParse(envelope([row(override)])).success).toBe(
      false,
    );
  });

  it('accepts complete package identity only on the private v2 shape', () => {
    const packaged = {
      ...identity(),
      executablePath: 'C:\\Program Files\\WindowsApps\\Fixture_1.0_x64\\fixture.exe',
      packageFamilyName: 'Fixture_0123456789abc',
      packagePublisherId: '0123456789abc',
      packageRelativePath: 'fixture.exe',
    };
    expect(
      computerWindowsNativeTargetListSchema.safeParse(envelope([row({ identity: packaged })]))
        .success,
    ).toBe(true);
    expect(computerWindowsAppIdentitySchema.safeParse(packaged).success).toBe(false);
    for (const override of [
      { packageFamilyName: null },
      { packagePublisherId: undefined },
      { packageRelativePath: undefined },
      { packagePublisherId: 'aaaaaaaaaaaaa' },
      { packageRelativePath: 'another.exe' },
      { packageRelativePath: 'FIXTURE.EXE' },
      { signerDigest: 'd'.repeat(64) },
    ])
      expect(
        computerWindowsNativeTargetListSchema.safeParse(
          envelope([row({ identity: { ...packaged, ...override } })]),
        ).success,
      ).toBe(false);
  });

  it('enforces safe generations, the row limit, and the metadata byte limit', () => {
    const small = Array.from({ length: 64 }, () => ({ kind: 'denied' }));
    expect(computerWindowsNativeTargetListSchema.safeParse(envelope(small)).success).toBe(true);
    expect(
      computerWindowsNativeTargetListSchema.safeParse(envelope([...small, { kind: 'denied' }]))
        .success,
    ).toBe(false);
    for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(
        computerWindowsNativeTargetListSchema.safeParse({ ...envelope(), generation }).success,
      ).toBe(false);
    const large = Array.from({ length: 64 }, () =>
      row({ facts: facts({ imageLeaf: 'a'.repeat(1024) }) }),
    );
    expect(computerWindowsNativeTargetListSchema.safeParse(envelope(large)).success).toBe(false);
    expect(
      computerWindowsNativeTargetListSchema.safeParse({ ...envelope(), unknownField: true })
        .success,
    ).toBe(false);
  });
});

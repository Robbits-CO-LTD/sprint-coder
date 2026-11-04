import { describe, expect, it } from 'vitest';
import { computerUseEligibilitySchema, computerUseNativeManifestSchema } from './index';

describe('Computer Use interlock eligibility wire', () => {
  const legacy = {
    mode: 'v1-allowlist',
    rulesetVersion: 1,
    classifierVersion: 1,
    lexiconVersion: 1,
    ticketRequired: true,
  };

  it('preserves legacy declarations without adding a default claim', () => {
    expect(computerUseEligibilitySchema.parse(legacy)).toEqual(legacy);
  });

  it('preserves boolean claims and rejects malformed claims', () => {
    for (const interlockEnforced of [true, false]) {
      const declaration = { ...legacy, interlockEnforced };
      expect(computerUseEligibilitySchema.parse(declaration)).toEqual(declaration);
    }
    for (const interlockEnforced of [null, 0, 1, 'true', {}, []])
      expect(computerUseEligibilitySchema.safeParse({ ...legacy, interlockEnforced }).success).toBe(
        false,
      );
  });
});

describe('Windows V2 manifest safety declaration', () => {
  const manifest = {
    version: 1,
    sourceCommit: 'a'.repeat(40),
    platform: 'win32',
    architecture: 'x64',
    protocolVersion: 1,
    apiVersion: 3,
    nativeVersion: 'computer-use-native-gate0-1',
    moduleDigest: 'b'.repeat(64),
    binaryDigest: 'b'.repeat(64),
    signerDigest: 'c'.repeat(64),
    capabilities: ['observe', 'capture', 'accessibility', 'input'],
  };
  const eligibility = {
    mode: 'v2-denylist',
    rulesetVersion: 3,
    classifierVersion: 2,
    lexiconVersion: 3,
    ticketRequired: true,
    interlockEnforced: true,
  };
  it('accepts Windows V2 only with tickets and the interlock', () => {
    expect(computerUseNativeManifestSchema.safeParse({ ...manifest, eligibility }).success).toBe(
      true,
    );
    for (const key of ['ticketRequired', 'interlockEnforced']) {
      for (const value of [undefined, false]) {
        expect(
          computerUseNativeManifestSchema.safeParse({
            ...manifest,
            eligibility: { ...eligibility, [key]: value },
          }).success,
        ).toBe(false);
      }
    }
  });
  it('preserves legacy, Windows V1 and macOS declarations', () => {
    expect(computerUseNativeManifestSchema.safeParse(manifest).success).toBe(true);
    expect(
      computerUseNativeManifestSchema.safeParse({
        ...manifest,
        eligibility: { ...eligibility, mode: 'v1-allowlist', interlockEnforced: false },
      }).success,
    ).toBe(true);
    expect(
      computerUseNativeManifestSchema.safeParse({
        ...manifest,
        platform: 'darwin',
        eligibility: { ...eligibility, interlockEnforced: false },
      }).success,
    ).toBe(true);
  });
});

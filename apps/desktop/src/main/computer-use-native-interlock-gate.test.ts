import { describe, expect, it, vi } from 'vitest';
import type * as Contracts from '@sprint-coder/contracts';
import type { ComputerUseEligibility, ComputerUseNativeManifest } from '@sprint-coder/contracts';

// The contracts still refuse a Windows v2 manifest until V2 is enabled. Only that one rule is
// lifted here, so the gate's own interlock check can be reached; every other field is still parsed.
vi.mock('@sprint-coder/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof Contracts>();
  const strict = actual.computerUseNativeManifestSchema;
  return {
    ...actual,
    computerUseNativeManifestSchema: Object.assign(Object.create(strict) as typeof strict, {
      parse: (value: Record<string, unknown>) => {
        const { eligibility, ...rest } = value;
        return {
          ...strict.parse(rest),
          ...(eligibility === undefined
            ? {}
            : { eligibility: actual.computerUseEligibilitySchema.parse(eligibility) }),
        };
      },
    }),
  };
});

const { evaluateComputerUseNativeGate } = await import('./computer-use-native');
const { computerUseNativeCompiledPin } = await import('./computer-use-native-provenance');

const commit = 'a'.repeat(40);
const V1: ComputerUseEligibility = {
  mode: 'v1-allowlist',
  rulesetVersion: 1,
  classifierVersion: 1,
  lexiconVersion: 1,
  ticketRequired: true,
};
const V2: ComputerUseEligibility = { ...V1, mode: 'v2-denylist', interlockEnforced: true };

function windowsGate(input: {
  main: ComputerUseEligibility | undefined;
  manifest: ComputerUseEligibility | undefined;
  attested: ComputerUseEligibility | undefined;
}) {
  const manifest = {
    version: 1,
    sourceCommit: commit,
    platform: 'win32',
    architecture: 'x64',
    protocolVersion: 1,
    apiVersion: 3,
    nativeVersion: 'computer-use-native-gate0-1',
    moduleDigest: 'b'.repeat(64),
    binaryDigest: 'b'.repeat(64),
    signerDigest: 'c'.repeat(64),
    capabilities: ['observe', 'capture', 'accessibility', 'input'],
    ...(input.manifest === undefined ? {} : { eligibility: input.manifest }),
  } as ComputerUseNativeManifest;
  // The pin binds the real manifest digest; only its compiled eligibility is the test's variable.
  const { eligibility: _ignored, ...bound } = computerUseNativeCompiledPin(manifest);
  void _ignored;
  return evaluateComputerUseNativeGate({
    featureFlag: true,
    packaged: true,
    platform: 'win32',
    manifest,
    probe: {
      protocolVersion: 1,
      apiVersion: 3,
      available: true,
      backend: 'fixture',
      sourceCommit: commit,
    },
    artifactDigest: manifest.binaryDigest,
    compiledPin: input.main === undefined ? bound : { ...bound, eligibility: input.main },
    ...(input.attested === undefined ? {} : { eligibilityAttestation: input.attested }),
  });
}

describe('Main native gate: Windows v2 interlock attestation (ADR G)', () => {
  it('opens a Windows v2 artifact only when all three declare the interlock', () => {
    expect(windowsGate({ main: V2, manifest: V2, attested: V2 })).toMatchObject({
      available: true,
    });
    const refused = { available: false, reason: 'ELIGIBILITY_INTERLOCK_UNATTESTED' };
    for (const interlockEnforced of [undefined, false]) {
      const wrong = { ...V2, interlockEnforced };
      expect(windowsGate({ main: wrong, manifest: V2, attested: V2 })).toMatchObject(refused);
      expect(windowsGate({ main: V2, manifest: wrong, attested: V2 })).toMatchObject(refused);
      expect(windowsGate({ main: V2, manifest: V2, attested: wrong })).toMatchObject(refused);
    }
  });

  it('does not ask a Windows v1 or legacy artifact for the interlock', () => {
    expect(windowsGate({ main: V1, manifest: V1, attested: V1 })).toMatchObject({
      available: true,
    });
    expect(
      windowsGate({ main: undefined, manifest: undefined, attested: undefined }),
    ).toMatchObject({ available: true });
  });
});

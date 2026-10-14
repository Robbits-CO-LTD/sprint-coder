import { describe, expect, it } from 'vitest';
import {
  computerUseEligibilitySchema,
  computerUseNativeManifestSchema,
  type ComputerUseEligibility,
} from '@sprint-coder/contracts';
import { parseNativeHandshake } from './computer-use-native-handshake';
import { evaluateComputerUseNativeGate } from './computer-use-native';
import {
  computerUseNativeCompiledPin,
  computerUseNativeManifestDigest,
  parseComputerUseNativeCompiledPin,
} from './computer-use-native-provenance';
import {
  COMPUTER_USE_FORCE_V1_ALLOWLIST_ENV,
  checkComputerUseEligibility,
  effectiveComputerUseEligibilityMode,
} from './computer-use-eligibility';

const sha = (character: string): string => character.repeat(64);
const commit = 'a'.repeat(40);

const V1: ComputerUseEligibility = {
  mode: 'v1-allowlist',
  rulesetVersion: 1,
  classifierVersion: 1,
  lexiconVersion: 1,
  ticketRequired: true,
};
const V2: ComputerUseEligibility = { ...V1, mode: 'v2-denylist' };

function manifest(eligibility?: ComputerUseEligibility, platform: 'darwin' | 'win32' = 'darwin') {
  return {
    version: 1,
    sourceCommit: commit,
    platform,
    architecture: platform === 'darwin' ? 'arm64' : 'x64',
    protocolVersion: 1,
    apiVersion: 2,
    nativeVersion: 'computer-use-native-gate0-1',
    moduleDigest: sha('b'),
    binaryDigest: sha('b'),
    signerDigest: sha('c'),
    capabilities: ['observe', 'capture', 'accessibility', 'input'],
    ...(eligibility === undefined ? {} : { eligibility }),
  } as const;
}

function gate(input: {
  main: ComputerUseEligibility | null | undefined;
  manifest?: ComputerUseEligibility | undefined;
  attested?: ComputerUseEligibility | undefined;
}) {
  const parsed = computerUseNativeManifestSchema.parse(manifest(input.manifest));
  // The pin binds the real manifest digest; only its compiled eligibility is the test's variable.
  const { eligibility: _ignored, ...bound } = computerUseNativeCompiledPin(parsed);
  void _ignored;
  const pin =
    input.main === null || input.main === undefined ? bound : { ...bound, eligibility: input.main };
  return evaluateComputerUseNativeGate({
    featureFlag: true,
    packaged: true,
    platform: 'darwin',
    manifest: parsed,
    probe: { protocolVersion: 1, apiVersion: 2, available: true, backend: 'fixture' },
    artifactDigest: parsed.moduleDigest,
    // `undefined` means a Main built before D7 (no compiled pin at all).
    ...(input.main === undefined ? {} : { compiledPin: pin }),
    ...(input.attested === undefined ? {} : { eligibilityAttestation: input.attested }),
  });
}

describe('Computer Use eligibility contract (D7-1)', () => {
  describe('manifest, handshake and compiled pin', () => {
    it('accepts an absent eligibility and a strict one, and refuses anything else', () => {
      expect(computerUseNativeManifestSchema.safeParse(manifest()).success).toBe(true);
      expect(computerUseNativeManifestSchema.safeParse(manifest(V1)).success).toBe(true);
      expect(computerUseNativeManifestSchema.safeParse(manifest(V2)).success).toBe(true);
      for (const bad of [
        { ...V1, mode: 'v3' },
        { ...V1, rulesetVersion: 0 },
        { ...V1, classifierVersion: 1.5 },
        { ...V1, lexiconVersion: '1' },
        { ...V1, ticketRequired: 'yes' },
        { ...V1, extra: true },
        { mode: 'v1-allowlist' },
      ])
        expect(computerUseEligibilitySchema.safeParse(bad).success).toBe(false);
      expect(
        computerUseNativeManifestSchema.safeParse({ ...manifest(V1), eligibility: { ...V1, x: 1 } })
          .success,
      ).toBe(false);
    });

    it('refuses a Windows manifest that claims v2 until S5', () => {
      expect(computerUseNativeManifestSchema.safeParse(manifest(V1, 'win32')).success).toBe(true);
      expect(computerUseNativeManifestSchema.safeParse(manifest(V2, 'win32')).success).toBe(false);
    });

    it('keeps the manifest digest of a manifest without eligibility byte-for-byte', () => {
      const legacy = computerUseNativeManifestSchema.parse(manifest());
      expect(computerUseNativeManifestDigest(legacy)).toBe(
        'ebcd1430f7443ae7ba47f2e88d939d91726b49a7deca5cca01e60e7531f75197',
      );
      const withEligibility = computerUseNativeManifestSchema.parse(manifest(V1));
      expect(computerUseNativeManifestDigest(withEligibility)).not.toBe(
        computerUseNativeManifestDigest(legacy),
      );
      expect(
        computerUseNativeManifestDigest(computerUseNativeManifestSchema.parse(manifest(V2))),
      ).not.toBe(computerUseNativeManifestDigest(withEligibility));
    });

    it('carries eligibility into the compiled pin and parses a pin without it as legacy', () => {
      const pin = computerUseNativeCompiledPin(computerUseNativeManifestSchema.parse(manifest(V2)));
      expect(pin.eligibility).toEqual(V2);
      expect(parseComputerUseNativeCompiledPin(JSON.parse(JSON.stringify(pin)))).toEqual(pin);
      const legacy = computerUseNativeCompiledPin(
        computerUseNativeManifestSchema.parse(manifest()),
      );
      expect(legacy.eligibility).toBeUndefined();
      expect(parseComputerUseNativeCompiledPin(JSON.parse(JSON.stringify(legacy)))).toEqual(legacy);
      expect(() =>
        parseComputerUseNativeCompiledPin({
          ...JSON.parse(JSON.stringify(pin)),
          eligibility: { ...V2, mode: 'x' },
        }),
      ).toThrow();
    });

    it('accepts one optional strict eligibility claim in the handshake on both platforms', () => {
      const mac = { protocolVersion: 1, apiVersion: 2, platform: 'darwin', napiVersion: 10 };
      expect(parseNativeHandshake(mac, 'darwin')).toBeNull();
      expect(parseNativeHandshake({ ...mac, eligibility: V1 }, 'darwin')).toEqual(V1);
      const win = {
        protocolVersion: 1,
        apiVersion: 2,
        platform: 'win32',
        napiVersion: 10,
        sourceCommit: commit,
        backend: 'windows-uia-graphics-capture-sendinput',
        architecture: 'x64',
        available: true,
        reason: 'READY',
        capabilities: { observe: true, control: true },
      };
      expect(parseNativeHandshake(win, 'win32')).toBeNull();
      expect(parseNativeHandshake({ ...win, eligibility: V1 }, 'win32')).toEqual(V1);
      for (const bad of [
        { ...V1, mode: 'v3' },
        { ...V1, extra: 1 },
        { mode: 'v1-allowlist' },
        null,
        'v1-allowlist',
        [],
      ])
        expect(() => parseNativeHandshake({ ...mac, eligibility: bad }, 'darwin')).toThrow(
          'HANDSHAKE_INVALID',
        );
      // The old unreviewed claims stay refused.
      for (const claim of ['buildMode', 'ruleset', 'classifier', 'lexicon'])
        expect(() => parseNativeHandshake({ ...mac, [claim]: 'v2-denylist' }, 'darwin')).toThrow(
          'HANDSHAKE_INVALID',
        );
    });
  });

  describe('three-way check (Main compiled constant, manifest, handshake attestation)', () => {
    it('opens a v1 Main for a legacy artifact with nothing declared (V1 does not regress)', () => {
      expect(gate({ main: undefined })).toMatchObject({ available: true });
      expect(gate({ main: null })).toMatchObject({ available: true });
      // A pin built before D7 carries no eligibility.
      expect(gate({ main: null, attested: undefined })).toMatchObject({ available: true });
    });

    it('opens a v1 Main for a v1 artifact that declares itself, and for one that declares nothing', () => {
      expect(gate({ main: V1, manifest: V1, attested: V1 })).toMatchObject({ available: true });
      expect(gate({ main: V1, manifest: V1 })).toMatchObject({ available: true });
      expect(gate({ main: V1, attested: V1 })).toMatchObject({ available: true });
      expect(gate({ main: V1 })).toMatchObject({ available: true });
    });

    it('closes a v1 Main for any v2 or differing declaration', () => {
      for (const declared of [
        V2,
        { ...V1, rulesetVersion: 2 },
        { ...V1, classifierVersion: 2 },
        { ...V1, lexiconVersion: 2 },
        { ...V1, ticketRequired: false },
      ]) {
        expect(gate({ main: V1, manifest: declared, attested: V1 })).toMatchObject({
          available: false,
          reason: 'ELIGIBILITY_MISMATCH',
        });
        expect(gate({ main: V1, manifest: V1, attested: declared })).toMatchObject({
          available: false,
          reason: 'ELIGIBILITY_MISMATCH',
        });
      }
      // A Main with no compiled pin is a legacy v1 Main: a v2 declaration still closes it.
      expect(gate({ main: undefined, manifest: V2 })).toMatchObject({
        available: false,
        reason: 'ELIGIBILITY_MISMATCH',
      });
      expect(gate({ main: undefined, attested: V2 })).toMatchObject({
        available: false,
        reason: 'ELIGIBILITY_MISMATCH',
      });
    });

    it('opens a v2 Main only when manifest and attestation both match it exactly', () => {
      expect(gate({ main: V2, manifest: V2, attested: V2 })).toMatchObject({ available: true });
    });

    it('closes a v2 Main for a missing, v1 or differing manifest or attestation', () => {
      const wrong = [
        undefined,
        V1,
        { ...V2, rulesetVersion: 2 },
        { ...V2, classifierVersion: 2 },
        { ...V2, lexiconVersion: 2 },
      ];
      for (const declared of wrong) {
        const mismatch = { available: false, reason: 'ELIGIBILITY_MISMATCH' };
        expect(gate({ main: V2, manifest: declared, attested: V2 })).toMatchObject(mismatch);
        expect(gate({ main: V2, manifest: V2, attested: declared })).toMatchObject(mismatch);
      }
    });

    it('closes a v2 Main when the build does not attest a required ticket', () => {
      const noTicket = { ...V2, ticketRequired: false };
      expect(gate({ main: noTicket, manifest: noTicket, attested: noTicket })).toMatchObject({
        available: false,
        reason: 'ELIGIBILITY_TICKET_UNATTESTED',
      });
      // Differing ticket claims are a mismatch before they are a missing ticket.
      expect(gate({ main: V2, manifest: V2, attested: noTicket })).toMatchObject({
        available: false,
        reason: 'ELIGIBILITY_MISMATCH',
      });
    });

    it('reports the mismatch after the artifact is verified and before the probe reason', () => {
      const parsed = computerUseNativeManifestSchema.parse(manifest(V2));
      const base = {
        featureFlag: true,
        packaged: true,
        platform: 'darwin',
        manifest: parsed,
        probe: {
          protocolVersion: 1,
          apiVersion: 2,
          available: false,
          backend: 'fixture',
          reason: 'ACCESSIBILITY_PERMISSION_REQUIRED',
        },
        artifactDigest: parsed.moduleDigest,
        eligibilityAttestation: V1,
      };
      // An unverified artifact keeps reporting the digest problem first.
      expect(evaluateComputerUseNativeGate({ ...base, artifactDigest: sha('e') })).toMatchObject({
        reason: 'ARTIFACT_DIGEST_MISMATCH',
      });
      // A verified one reports the eligibility problem before the native's own refusal.
      expect(evaluateComputerUseNativeGate(base)).toMatchObject({
        available: false,
        reason: 'ELIGIBILITY_MISMATCH',
      });
    });

    it('is a pure function over the three declarations', () => {
      expect(
        checkComputerUseEligibility({ compiled: null, manifest: undefined, attested: undefined }),
      ).toBe('ok');
      expect(checkComputerUseEligibility({ compiled: V2, manifest: V2, attested: V2 })).toBe('ok');
      expect(checkComputerUseEligibility({ compiled: V2, manifest: V1, attested: V2 })).toBe(
        'mismatch',
      );
    });
  });

  describe('effective mode', () => {
    const table: Array<
      [ComputerUseEligibility['mode'] | null, boolean, string | undefined, string]
    > = [
      ['v2-denylist', true, undefined, 'v2-denylist'],
      ['v2-denylist', false, undefined, 'v1-allowlist'],
      ['v2-denylist', true, '1', 'v1-allowlist'],
      ['v2-denylist', true, '0', 'v2-denylist'],
      ['v2-denylist', true, '', 'v2-denylist'],
      ['v1-allowlist', true, undefined, 'v1-allowlist'],
      ['v1-allowlist', true, '1', 'v1-allowlist'],
      ['v1-allowlist', false, undefined, 'v1-allowlist'],
      [null, true, undefined, 'v1-allowlist'],
      [null, true, '1', 'v1-allowlist'],
    ];
    it.each(table)(
      'compiled %s, V2 flag %s, force %s gives %s',
      (compiled, flag, force, expected) => {
        expect(
          effectiveComputerUseEligibilityMode({
            compiled,
            agentDrivenV2: flag,
            environment:
              force === undefined ? {} : { [COMPUTER_USE_FORCE_V1_ALLOWLIST_ENV]: force },
          }),
        ).toBe(expected);
      },
    );

    it('never lets an environment variable raise a v1 build', () => {
      for (const value of ['2', 'v2', 'v2-denylist', 'true', '1']) {
        expect(
          effectiveComputerUseEligibilityMode({
            compiled: 'v1-allowlist',
            agentDrivenV2: true,
            environment: {
              [COMPUTER_USE_FORCE_V1_ALLOWLIST_ENV]: value,
              SPRINT_CODER_COMPUTER_USE_ELIGIBILITY: 'v2-denylist',
              SPRINT_CODER_COMPUTER_USE_AGENT_DRIVEN_V2: '1',
            },
          }),
        ).toBe('v1-allowlist');
      }
    });
  });
});

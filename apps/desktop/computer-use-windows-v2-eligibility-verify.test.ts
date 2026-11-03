import { describe, expect, it } from 'vitest';
import { windowsV2EligibilityProblems } from './scripts/verify-windows-v2-eligibility.mjs';

const eligibility = {
  mode: 'v2-denylist',
  rulesetVersion: 4,
  classifierVersion: 2,
  lexiconVersion: 3,
  ticketRequired: true,
  interlockEnforced: true,
} as const;
const evidence = () => ({
  expected: eligibility,
  compiled: { eligibility },
  manifest: { eligibility },
  handshake: {
    protocolVersion: 1,
    apiVersion: 3,
    napiVersion: 10,
    platform: 'win32',
    eligibility,
  },
});

describe('Windows full V2 build eligibility verification preparation', () => {
  it('windows_v2_artifact_three_way_attestation', () => {
    expect(windowsV2EligibilityProblems(evidence())).toEqual([]);
  });

  for (const source of ['compiled', 'manifest', 'handshake'] as const) {
    it.each([
      ['mode', 'v1-allowlist'],
      ['rulesetVersion', 3],
      ['classifierVersion', 1],
      ['lexiconVersion', 2],
      ['ticketRequired', false],
      ['interlockEnforced', false],
      ['interlockEnforced', undefined],
      ['interlockEnforced', null],
    ])(`${source} mismatch closes verification: %s=%s`, (key, value) => {
      const input = evidence();
      expect(
        windowsV2EligibilityProblems({
          ...input,
          [source]: { ...input[source], eligibility: { ...eligibility, [key]: value } },
        }),
      ).not.toEqual([]);
    });

    it.each([undefined, null, {}, []])(`${source} missing: %s`, (value) => {
      expect(windowsV2EligibilityProblems({ ...evidence(), [source]: value })).not.toEqual([]);
    });
  }

  it('rejects unanimous stale evidence against the independently requested versions', () => {
    const input = evidence();
    const stale = { ...eligibility, rulesetVersion: 3 };
    expect(
      windowsV2EligibilityProblems({
        ...input,
        compiled: { eligibility: stale },
        manifest: { eligibility: stale },
        handshake: { ...input.handshake, eligibility: stale },
      }),
    ).not.toEqual([]);
  });

  it.each([
    { mode: 'v1-allowlist' },
    { ticketRequired: false },
    { interlockEnforced: false },
    { classifierVersion: 1 },
    { rulesetVersion: 0 },
  ])('rejects an unsafe expected declaration: %s', (override) => {
    expect(
      windowsV2EligibilityProblems({
        ...evidence(),
        expected: { ...eligibility, ...override },
      }),
    ).not.toEqual([]);
  });

  it.each([{ platform: 'darwin' }, { apiVersion: 2 }, { napiVersion: 9 }])(
    'rejects an incompatible real handshake envelope: %s',
    (override) => {
      const input = evidence();
      expect(
        windowsV2EligibilityProblems({
          ...input,
          handshake: { ...input.handshake, ...override },
        }),
      ).not.toEqual([]);
    },
  );
});

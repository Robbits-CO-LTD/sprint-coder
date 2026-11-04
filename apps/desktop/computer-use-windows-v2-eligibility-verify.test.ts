import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  windowsV2ArtifactProblems,
  windowsV2EligibilityProblems,
} from './scripts/verify-windows-v2-eligibility';

// CI opt-in after digest/provenance verification:
// COMPUTER_USE_WINDOWS_V2_ARTIFACTS=<JSON file> vitest run computer-use-windows-v2-eligibility-verify.test.ts
// JSON: { expectedPath, mainBundlePath, manifestPath, handshakePath }, absolute paths. expectedPath
// is the independently requested declaration; handshakePath is the actual helper reply envelope.
// No full V2 build is enabled here. A supplied but incomplete request must fail, never skip.
const artifactsPath = process.env['COMPUTER_USE_WINDOWS_V2_ARTIFACTS'];
if (artifactsPath !== undefined) {
  it('verifies explicitly requested Windows V2 build artifacts', () => {
    const request: unknown = JSON.parse(readFileSync(artifactsPath, 'utf8'));
    if (typeof request !== 'object' || request === null)
      throw new Error('Invalid artifact request');
    const path = (key: string) => {
      const value: unknown = Reflect.get(request, key);
      if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing ${key}`);
      return value;
    };
    expect(
      windowsV2ArtifactProblems({
        expected: JSON.parse(readFileSync(path('expectedPath'), 'utf8')) as unknown,
        mainBundlePath: path('mainBundlePath'),
        manifestPath: path('manifestPath'),
        handshakePath: path('handshakePath'),
      }),
    ).toEqual([]);
  });
}

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

function artifactProblems(
  overrides: {
    compiled?: object;
    manifest?: object;
    handshake?: object;
    bundle?: string;
    afterPin?: string;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'sc-v2-artifact-'));
  const input = evidence();
  const pin = {
    version: 1,
    sourceCommit: 'a'.repeat(40),
    platform: 'win32',
    architecture: 'x64',
    artifactDigest: 'b'.repeat(64),
    manifestDigest: 'c'.repeat(64),
    ...input.compiled,
    ...overrides.compiled,
  };
  const mainBundlePath = join(root, 'main.js');
  const manifestPath = join(root, 'manifest.json');
  const handshakePath = join(root, 'handshake.json');
  try {
    writeFileSync(
      mainBundlePath,
      overrides.bundle ??
        `var define_pin_default = ${JSON.stringify(pin)};
${overrides.afterPin ?? ''}
function resolveComputerUseNativeCompiledPin(options) {
  if (options.compiledPin) return parseComputerUseNativeCompiledPin(options.compiledPin);
  return { required: true, value: parseComputerUseNativeCompiledPin(define_pin_default) };
}`,
    );
    writeFileSync(manifestPath, JSON.stringify(overrides.manifest ?? input.manifest));
    writeFileSync(handshakePath, JSON.stringify(overrides.handshake ?? input.handshake));
    return windowsV2ArtifactProblems({
      expected: eligibility,
      mainBundlePath,
      manifestPath,
      handshakePath,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('Windows V2 artifact files', () => {
  it('windows_v2_artifact_three_way_attestation', () => {
    expect(artifactProblems()).toEqual([]);
  });
  it.each([
    'define_pin_default.eligibility.interlockEnforced = false;',
    'define_pin_default = { ...define_pin_default };',
    'const alias = define_pin_default; alias.eligibility.ticketRequired = false;',
    'Object.assign(define_pin_default, {});',
  ])('refuses a Main pin define that is written after its declaration: %s', (afterPin) => {
    expect(() => artifactProblems({ afterPin })).toThrow(
      /pin is missing, ambiguous or unsupported/u,
    );
  });
  it('rejects_actual_main_pin_mismatch', () => {
    expect(
      artifactProblems({ compiled: { eligibility: { ...eligibility, rulesetVersion: 3 } } }),
    ).toContain('compiled eligibility.rulesetVersion differs');
  });
  it('rejects unanimous stale evidence against the independently requested versions', () => {
    const stale = { eligibility: { ...eligibility, rulesetVersion: 3 } };
    expect(
      artifactProblems({
        compiled: stale,
        manifest: stale,
        handshake: { ...evidence().handshake, ...stale },
      }),
    ).toEqual([
      'compiled eligibility.rulesetVersion differs',
      'manifest eligibility.rulesetVersion differs',
      'handshake eligibility.rulesetVersion differs',
    ]);
  });
  for (const source of ['compiled', 'manifest', 'handshake'] as const) {
    it(`rejects missing interlock in artifact ${source}`, () => {
      const missing = { ...eligibility, interlockEnforced: undefined };
      expect(
        artifactProblems({ [source]: { ...evidence()[source], eligibility: missing } }),
      ).not.toEqual([]);
    });
  }
  it.each([
    '',
    'throw new Error("must never execute bundle");',
    'const decoy = { eligibility: {} };',
  ])('rejects an absent actual Main pin: %s', (bundle) => {
    expect(() => artifactProblems({ bundle })).toThrow();
  });
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

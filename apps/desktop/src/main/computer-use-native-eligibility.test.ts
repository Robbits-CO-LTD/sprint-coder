import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computerUseEligibilityModeSchema,
  computerUseEligibilitySchema,
  type ComputerUseEligibility,
} from '@sprint-coder/contracts';
import { assertWindowsComputerUseHelperHandshake } from './computer-use-native-windows';
import {
  eligibilityBuildHeader,
  eligibilityDeclaration,
  parseEligibilityMode,
} from '../../../../build-computer-use-eligibility.mjs';

const nativeDirectory = join(__dirname, '../../computer-use-native');
const read = (name: string): string => readFileSync(join(nativeDirectory, name), 'utf8');
const section = (source: string, from: string, to: string): string => {
  const start = source.indexOf(from);
  expect(start, from).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(to, start + from.length);
  expect(end, to).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe('Computer Use native eligibility attestation (D7-2)', () => {
  const table = JSON.parse(read('eligibility.json')) as {
    versions: { rulesetVersion: number; classifierVersion: number; lexiconVersion: number };
    ticketRequired: { darwin: boolean; win32: boolean };
  };
  const header = read('computer_use_native_eligibility.h');

  it('keeps eligibility.json, the portable header and the contracts in step', () => {
    for (const platform of ['darwin', 'win32'] as const)
      for (const mode of ['v1-allowlist', 'v2-denylist'] as const)
        expect(
          computerUseEligibilitySchema.safeParse(eligibilityDeclaration(mode, platform)).success,
        ).toBe(true);
    // The header's fallbacks (a build with no generated header) are the same v1 numbers.
    const fallback = (name: string): number => {
      const match = new RegExp(`#\\s*define SPRINT_CODER_ELIGIBILITY_${name} (\\d+)`, 'u').exec(
        header,
      );
      expect(match, name).not.toBeNull();
      return Number(match![1]);
    };
    expect(fallback('RULESET_VERSION')).toBe(table.versions.rulesetVersion);
    expect(fallback('CLASSIFIER_VERSION')).toBe(table.versions.classifierVersion);
    expect(fallback('LEXICON_VERSION')).toBe(table.versions.lexiconVersion);
    expect(fallback('V2')).toBe(0);
    expect(fallback('TICKET_REQUIRED')).toBe(0);
    // The native mode names are the contract's, in order.
    const modes = computerUseEligibilityModeSchema.options;
    expect(header).toContain(`"${modes[0]}"`);
    expect(header).toContain(`"${modes[1]}"`);
    // mac and Windows attest no ticket until N2b-4 PR 5 / S5 turn it on.
    expect(table.ticketRequired).toEqual({ darwin: false, win32: false });
  });

  it('reads nothing from the environment or the command line', () => {
    expect(header).not.toMatch(/getenv|environ|argv|NSProcessInfo|GetEnvironmentVariable/u);
    expect(header).toContain('constexpr');
  });

  it('returns the macOS handshake eligibility from the portable constants only', () => {
    const source = read('computer_use_macos.mm');
    expect(source).toContain('#include "computer_use_native_eligibility.h"');
    const handshake = section(source, 'napi_value Handshake(', 'struct NativeObservationRequest {');
    expect(handshake).toContain('"eligibility"');
    for (const name of [
      'kNativeEligibilityModeName',
      'kNativeEligibilityRulesetVersion',
      'kNativeEligibilityClassifierVersion',
      'kNativeEligibilityLexiconVersion',
      'kNativeEligibilityTicketRequired',
    ])
      expect(handshake).toContain(name);
    const attested = section(handshake, 'napi_value eligibility;', '"eligibility", eligibility');
    expect(attested).not.toMatch(/getenv|NSProcessInfo|processInfo|argv|ReadNamed/u);
    // The four original keys stay, in front of the new one.
    for (const key of ['"protocolVersion"', '"apiVersion"', '"platform"', '"napiVersion"'])
      expect(handshake.indexOf(key)).toBeGreaterThan(0);
    expect(handshake.indexOf('"napiVersion"')).toBeLessThan(handshake.indexOf('"eligibility"'));
  });

  it('builds with a generated header that is found without any build flag', () => {
    const gyp = read('binding.gyp');
    expect(gyp).toContain('"generated"');
    expect(header).toContain('__has_include("computer_use_build_eligibility.h")');
    const ignore = readFileSync(join(__dirname, '../../../../.gitignore'), 'utf8');
    expect(ignore).toContain('apps/desktop/computer-use-native/generated/');
  });

  it('returns the Windows helper eligibility from the portable constants only', () => {
    const source = read('computer_use_windows_host.cc');
    expect(source).toContain('#include "computer_use_native_eligibility.h"');
    const probe = section(source, 'std::string ProbeJson(', 'std::string ErrorPayload(');
    expect(probe).toContain('\\"eligibility\\":{');
    for (const name of [
      'kNativeEligibilityModeName',
      'kNativeEligibilityRulesetVersion',
      'kNativeEligibilityClassifierVersion',
      'kNativeEligibilityLexiconVersion',
      'kNativeEligibilityTicketRequired',
    ])
      expect(probe).toContain(name);
    expect(probe).not.toMatch(/getenv|GetEnvironmentVariable|argv/u);
  });

  describe('the Windows helper handshake over the pipe is checked against the manifest', () => {
    const sourceCommit = 'a'.repeat(40);
    const trust = (eligibility?: ComputerUseEligibility) =>
      ({
        binaryDigest: 'b'.repeat(64),
        signerDigest: 'c'.repeat(64),
        sourceCommit,
        ...(eligibility === undefined ? {} : { eligibility }),
      }) as const;
    const handshake = (eligibility?: ComputerUseEligibility) => ({
      protocolVersion: 1,
      apiVersion: 2,
      platform: 'win32',
      napiVersion: 10,
      sourceCommit,
      ...(eligibility === undefined ? {} : { eligibility }),
    });
    const v1 = eligibilityDeclaration('v1-allowlist', 'win32') as ComputerUseEligibility;

    it('accepts agreement, including both sides saying nothing', () => {
      expect(() => assertWindowsComputerUseHelperHandshake(handshake(v1), trust(v1))).not.toThrow();
      expect(() => assertWindowsComputerUseHelperHandshake(handshake(), trust())).not.toThrow();
    });

    it('refuses a declaration on one side only, or any difference', () => {
      for (const [attested, declared] of [
        [undefined, v1],
        [v1, undefined],
        [{ ...v1, rulesetVersion: 2 }, v1],
        [{ ...v1, classifierVersion: 2 }, v1],
        [{ ...v1, lexiconVersion: 2 }, v1],
        [{ ...v1, ticketRequired: true }, v1],
        [{ ...v1, mode: 'v2-denylist' }, v1],
      ] as Array<[ComputerUseEligibility | undefined, ComputerUseEligibility | undefined]>)
        expect(() =>
          assertWindowsComputerUseHelperHandshake(handshake(attested), trust(declared)),
        ).toThrow(/eligibility/iu);
    });
  });

  it('has a harness guard macro that the generated header actually defines', () => {
    const harness = read('computer_use_protocol_fuzz.cc');
    expect(harness).toContain('SPRINT_CODER_ELIGIBILITY_FROM_BUILD');
    expect(eligibilityBuildHeader(eligibilityDeclaration('v1-allowlist', 'darwin'))).toContain(
      '#define SPRINT_CODER_ELIGIBILITY_FROM_BUILD 1',
    );
  });

  it('parses the build argument the way the build script does', () => {
    expect(parseEligibilityMode(['--eligibility=v2'], 'darwin')).toBe('v2-denylist');
  });
});

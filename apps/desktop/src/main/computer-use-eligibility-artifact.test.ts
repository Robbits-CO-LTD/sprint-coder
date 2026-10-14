import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ComputerUseEligibility } from '@sprint-coder/contracts';
import { eligibilityDeclaration } from '../../../../build-computer-use-eligibility.mjs';
import { checkComputerUseEligibility } from './computer-use-eligibility';

// D7-3: Main's three-way check against what a build declares and attests. The synthetic cases run
// everywhere; the report case runs in CI right after a real build, with the manifest and the
// handshake that verify-computer-use-eligibility.mjs read from the built artifact.

type Mode = 'v1-allowlist' | 'v2-denylist';
const declaration = (mode: Mode, platform: 'darwin' | 'win32') =>
  eligibilityDeclaration(mode, platform) as ComputerUseEligibility;

/** What Main says about a native built as `built`, for a Main compiled as `main`. */
function verdict(main: ComputerUseEligibility | null, built: ComputerUseEligibility) {
  return checkComputerUseEligibility({ compiled: main, manifest: built, attested: built });
}

describe('Computer Use eligibility: Main against a built native (D7-3)', () => {
  it('opens for a matching mode on macOS and closes for every mixed pair', () => {
    const v1 = declaration('v1-allowlist', 'darwin');
    const v2 = declaration('v2-denylist', 'darwin');
    expect(verdict(v1, v1)).toBe('ok');
    expect(verdict(v2, v2)).toBe('ok');
    // Main v1 x native v2 and Main v2 x native v1 never open.
    expect(verdict(v1, v2)).toBe('mismatch');
    expect(verdict(v2, v1)).toBe('mismatch');
  });

  it('opens a v1 Main for a v1 Windows helper, and a v2 Main never opens for it', () => {
    const v1 = declaration('v1-allowlist', 'win32');
    expect(verdict(v1, v1)).toBe('ok');
    // The Windows helper claims no ticket and builds only v1, so a v2 Main cannot agree with it.
    const v2Main = { ...declaration('v2-denylist', 'darwin'), ticketRequired: false };
    expect(verdict(v2Main, v1)).toBe('mismatch');
    expect(verdict(declaration('v2-denylist', 'darwin'), v1)).toBe('mismatch');
  });

  it('closes when the manifest and the handshake disagree about the build', () => {
    const v1 = declaration('v1-allowlist', 'darwin');
    const v2 = declaration('v2-denylist', 'darwin');
    expect(checkComputerUseEligibility({ compiled: v1, manifest: v1, attested: v2 })).toBe(
      'mismatch',
    );
    expect(checkComputerUseEligibility({ compiled: v2, manifest: v2, attested: v1 })).toBe(
      'mismatch',
    );
  });

  const reportPath = process.env['COMPUTER_USE_ELIGIBILITY_REPORT'];
  it.skipIf(reportPath === undefined)(
    'agrees with the artifact that was just built (manifest and handshake from the build)',
    () => {
      const report = JSON.parse(readFileSync(reportPath!, 'utf8')) as {
        platform: 'darwin' | 'win32';
        expectedMode: 'v1' | 'v2';
        manifest: ComputerUseEligibility;
        attested: ComputerUseEligibility;
      };
      const built = report.attested;
      expect(built).toEqual(report.manifest);
      const mainV1 = declaration('v1-allowlist', report.platform);
      const mainV2 = declaration('v2-denylist', report.platform);
      if (report.expectedMode === 'v1') {
        expect(verdict(mainV1, built)).toBe('ok');
        expect(verdict(mainV2, built)).toBe('mismatch');
      } else {
        expect(verdict(mainV2, built)).toBe('ok');
        expect(verdict(mainV1, built)).toBe('mismatch');
      }
      // A Main with no pin (a legacy v1) accepts only the v1 build.
      expect(verdict(null, built)).toBe(report.expectedMode === 'v1' ? 'ok' : 'mismatch');
    },
  );
});

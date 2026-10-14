import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eligibilityDeclaration } from '../../build-computer-use-eligibility.mjs';
import { eligibilityProblems, main } from '../../verify-computer-use-eligibility.mjs';

const mode = { v1: 'v1-allowlist', v2: 'v2-denylist' };
const declare = (expected, platform) => eligibilityDeclaration(mode[expected], platform);

describe('Computer Use built-artifact eligibility verification (D7-3)', () => {
  const cases = [
    ['darwin', 'v1'],
    ['darwin', 'v2'],
    ['win32', 'v1'],
  ];

  it.each(cases)(
    'accepts a %s %s artifact whose manifest and handshake agree',
    (platform, expected) => {
      const declaration = declare(expected, platform);
      expect(
        eligibilityProblems({
          platform,
          expectedMode: expected,
          manifest: declaration,
          attested: { ...declaration },
        }),
      ).toEqual([]);
    },
  );

  it('wants the macOS native to claim a ticket in both modes and the Windows helper to claim none', () => {
    expect(declare('v1', 'darwin').ticketRequired).toBe(true);
    expect(declare('v2', 'darwin').ticketRequired).toBe(true);
    expect(declare('v1', 'win32').ticketRequired).toBe(false);
  });

  it.each(cases)(
    'rejects every field of a %s %s artifact that differs between manifest and handshake',
    (platform, expected) => {
      const declaration = declare(expected, platform);
      const changes = {
        mode: declaration.mode === mode.v1 ? mode.v2 : mode.v1,
        rulesetVersion: declaration.rulesetVersion + 1,
        classifierVersion: declaration.classifierVersion + 1,
        lexiconVersion: declaration.lexiconVersion + 1,
        ticketRequired: !declaration.ticketRequired,
      };
      for (const [key, value] of Object.entries(changes)) {
        // The handshake is the one that lies.
        expect(
          eligibilityProblems({
            platform,
            expectedMode: expected,
            manifest: declaration,
            attested: { ...declaration, [key]: value },
          }).length,
          `attested ${key}`,
        ).toBeGreaterThan(0);
        // The manifest is the one that lies.
        expect(
          eligibilityProblems({
            platform,
            expectedMode: expected,
            manifest: { ...declaration, [key]: value },
            attested: declaration,
          }).length,
          `manifest ${key}`,
        ).toBeGreaterThan(0);
      }
    },
  );

  it('rejects an artifact built in the other mode even when manifest and handshake agree', () => {
    const v2 = declare('v2', 'darwin');
    expect(
      eligibilityProblems({
        platform: 'darwin',
        expectedMode: 'v1',
        manifest: v2,
        attested: v2,
      }).join('\n'),
    ).toMatch(/mode/u);
    const v1 = declare('v1', 'darwin');
    expect(
      eligibilityProblems({ platform: 'darwin', expectedMode: 'v2', manifest: v1, attested: v1 })
        .length,
    ).toBeGreaterThan(0);
  });

  it('rejects a missing, null, malformed or over-keyed declaration on either side', () => {
    const declaration = declare('v1', 'darwin');
    for (const bad of [
      undefined,
      null,
      'v1',
      [],
      {},
      { ...declaration, extra: true },
      { mode: declaration.mode },
    ]) {
      expect(
        eligibilityProblems({
          platform: 'darwin',
          expectedMode: 'v1',
          manifest: declaration,
          attested: bad,
        }).length,
        JSON.stringify(bad),
      ).toBeGreaterThan(0);
      expect(
        eligibilityProblems({
          platform: 'darwin',
          expectedMode: 'v1',
          manifest: bad,
          attested: declaration,
        }).length,
        JSON.stringify(bad),
      ).toBeGreaterThan(0);
    }
    // A string for a boolean or a number is a different value, not a loose match.
    expect(
      eligibilityProblems({
        platform: 'darwin',
        expectedMode: 'v1',
        manifest: declaration,
        attested: { ...declaration, ticketRequired: 'true', rulesetVersion: '1' },
      }).length,
    ).toBeGreaterThan(0);
  });

  it('refuses a Windows deny-list request outright', () => {
    const v1 = declare('v1', 'win32');
    expect(
      eligibilityProblems({
        platform: 'win32',
        expectedMode: 'v2',
        manifest: v1,
        attested: v1,
      }).join('\n'),
    ).toMatch(/not valid for win32/u);
  });

  describe('command line', () => {
    const directories = [];
    afterEach(() => {
      vi.restoreAllMocks();
      for (const directory of directories.splice(0))
        rmSync(directory, { recursive: true, force: true });
    });
    const quiet = () => {
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
    };
    const emptyDirectory = () => {
      const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-eligibility-'));
      directories.push(directory);
      return directory;
    };

    it('skips where there is no built artifact, and fails there only when one is required', () => {
      quiet();
      const directory = emptyDirectory();
      expect(main(['--expect=v1', `--dir=${directory}`], 'darwin')).toBe(0);
      expect(main(['--expect=v1', `--dir=${directory}`, '--require'], 'darwin')).toBe(1);
      expect(main(['--expect=v1', '--require'], 'linux')).toBe(0);
    });

    it('requires the mode it is to verify', () => {
      quiet();
      expect(main([], 'darwin')).toBe(2);
      expect(main(['--expect=v3'], 'darwin')).toBe(2);
    });

    it('fails on a manifest whose artifact cannot be the one it describes', () => {
      quiet();
      const directory = emptyDirectory();
      const declaration = declare('v1', 'darwin');
      writeFileSync(
        join(directory, 'computer-use-native.manifest.json'),
        JSON.stringify({
          platform: 'darwin',
          moduleDigest: 'a'.repeat(64),
          binaryDigest: 'a'.repeat(64),
          eligibility: declaration,
        }),
      );
      // No .node at all.
      expect(main(['--expect=v1', `--dir=${directory}`], 'darwin')).toBe(1);
      // A .node whose bytes do not match the manifest digest.
      writeFileSync(join(directory, 'sprint_coder_computer_use_native.node'), 'not a real addon');
      expect(main(['--expect=v1', `--dir=${directory}`], 'darwin')).toBe(1);
      // A manifest for another platform.
      writeFileSync(
        join(directory, 'computer-use-native.manifest.json'),
        JSON.stringify({ platform: 'win32', eligibility: declaration }),
      );
      expect(main(['--expect=v1', `--dir=${directory}`], 'darwin')).toBe(1);
    });
  });
});

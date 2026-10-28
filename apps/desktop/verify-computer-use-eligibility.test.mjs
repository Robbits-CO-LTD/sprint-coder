import { createHash } from 'node:crypto';
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

  it('wants both natives to claim a ticket', () => {
    expect(declare('v1', 'darwin').ticketRequired).toBe(true);
    expect(declare('v2', 'darwin').ticketRequired).toBe(true);
    expect(declare('v1', 'win32').ticketRequired).toBe(true);
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
    // A string for a boolean or a number is a different value, not a loose match. Each field is
    // its own case: a loosened comparison on one type must not be hidden by the other.
    for (const [key, value] of [
      ['rulesetVersion', '1'],
      ['classifierVersion', '1'],
      ['lexiconVersion', '1'],
      ['ticketRequired', 'true'],
      ['ticketRequired', 1],
    ])
      expect(
        eligibilityProblems({
          platform: 'darwin',
          expectedMode: 'v1',
          manifest: declaration,
          attested: { ...declaration, [key]: value },
        }).join(', '),
        key + ' as ' + JSON.stringify(value),
      ).toContain('attested eligibility.' + key + ' is');
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
    let errors = [];
    afterEach(() => {
      vi.restoreAllMocks();
      for (const directory of directories.splice(0))
        rmSync(directory, { recursive: true, force: true });
    });
    const quiet = () => {
      errors = [];
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      vi.spyOn(console, 'error').mockImplementation((message) => {
        errors.push(String(message));
      });
    };
    const emptyDirectory = () => {
      const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-eligibility-'));
      directories.push(directory);
      return directory;
    };
    const nodeFile = 'sprint_coder_computer_use_native.node';
    const sha = (text) => createHash('sha256').update(text).digest('hex');
    const writeManifest = (directory, overrides = {}) =>
      writeFileSync(
        join(directory, 'computer-use-native.manifest.json'),
        JSON.stringify({
          platform: 'darwin',
          protocolVersion: 1,
          apiVersion: 3,
          moduleDigest: sha('placeholder addon'),
          binaryDigest: sha('placeholder addon'),
          eligibility: declare('v1', 'darwin'),
          ...overrides,
        }),
      );
    const run = (directory, extra = [], platform = 'darwin') =>
      main(['--expect=v1', `--dir=${directory}`, ...extra], platform);

    it('skips where there is no built artifact, and fails there only when one is required', () => {
      quiet();
      const directory = emptyDirectory();
      expect(run(directory)).toBe(0);
      expect(errors).toEqual([]);
      expect(run(directory, ['--require'])).toBe(1);
      expect(errors.join('\n')).toContain('no built manifest');
    });

    it('does not let --require pass over a platform outside the contract', () => {
      quiet();
      expect(main(['--expect=v1'], 'linux')).toBe(0);
      expect(main(['--expect=v1', '--require'], 'linux')).toBe(1);
      expect(errors.join('\n')).toContain('outside the Computer Use contract');
    });

    it('requires the mode it is to verify', () => {
      quiet();
      expect(main([], 'darwin')).toBe(2);
      expect(main(['--expect=v3'], 'darwin')).toBe(2);
    });

    // Each guard is reached alone: the failing message names the guard that fired, and every case
    // up to it is otherwise valid, so removing one guard turns exactly one case green or changes
    // its message.
    it('refuses a manifest written for another platform', () => {
      quiet();
      const directory = emptyDirectory();
      writeFileSync(join(directory, nodeFile), 'placeholder addon');
      writeManifest(directory, { platform: 'win32' });
      expect(run(directory)).toBe(1);
      expect(errors.join('\n')).toContain('platform differs');
    });

    it('refuses a manifest whose artifact was not built', () => {
      quiet();
      const directory = emptyDirectory();
      writeManifest(directory);
      expect(run(directory)).toBe(1);
      expect(errors.join('\n')).toContain('built artifact is missing');
    });

    it('refuses an artifact whose bytes are not the ones the manifest names', () => {
      quiet();
      const directory = emptyDirectory();
      writeFileSync(join(directory, nodeFile), 'a different addon');
      writeManifest(directory);
      expect(run(directory)).toBe(1);
      expect(errors.join('\n')).toContain('digest does not match');
    });

    it('gets past every guard before it for an artifact that matches, then fails to load it', () => {
      quiet();
      const directory = emptyDirectory();
      writeFileSync(join(directory, nodeFile), 'placeholder addon');
      writeManifest(directory);
      expect(run(directory)).toBe(1);
      const text = errors.join('\n');
      expect(text).toContain('FAIL');
      for (const guard of [
        'platform differs',
        'built artifact is missing',
        'digest does not match',
      ])
        expect(text).not.toContain(guard);
    });

    it('asks the native for the protocol the manifest names, and refuses a manifest without one', () => {
      quiet();
      const directory = emptyDirectory();
      writeFileSync(join(directory, nodeFile), 'placeholder addon');
      for (const bad of [
        { protocolVersion: '1' },
        { apiVersion: undefined },
        { apiVersion: 2.5 },
      ]) {
        writeManifest(directory, bad);
        errors = [];
        expect(run(directory), JSON.stringify(bad)).toBe(1);
        expect(errors.join('\n')).toContain('protocolVersion or apiVersion is not an integer');
      }
    });
  });
});

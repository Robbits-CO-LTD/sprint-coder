import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  eligibilityBuildHeader,
  eligibilityDeclaration,
  parseEligibilityMode,
} from '../../build-computer-use-eligibility.mjs';

const desktopDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(desktopDirectory, '..', '..');

describe('Computer Use native --eligibility argument', () => {
  it('defaults to the v1 allow-list and accepts exactly v1 and v2', () => {
    expect(parseEligibilityMode([], 'darwin')).toBe('v1-allowlist');
    expect(parseEligibilityMode(['--target=darwin'], 'darwin')).toBe('v1-allowlist');
    expect(parseEligibilityMode(['--eligibility=v1'], 'darwin')).toBe('v1-allowlist');
    expect(parseEligibilityMode(['--eligibility=v2'], 'darwin')).toBe('v2-denylist');
    expect(parseEligibilityMode(['--eligibility=v1'], 'win32')).toBe('v1-allowlist');
  });

  it.each([
    ['--eligibility='],
    ['--eligibility'],
    ['--eligibility=v3'],
    ['--eligibility=V2'],
    ['--eligibility=v2-denylist'],
    ['--eligibility=v1-allowlist'],
    ['--eligibility= v2'],
    ['--eligibility=v1', '--eligibility=v2'],
    ['--eligibility=v2', '--eligibility=v2'],
  ])('refuses %j', (...argv) => {
    expect(() => parseEligibilityMode(argv, 'darwin')).toThrow(/eligibility/iu);
  });

  it('accepts an explicitly requested Windows deny-list build', () => {
    expect(parseEligibilityMode(['--eligibility=v2'], 'win32')).toBe('v2-denylist');
  });

  it('never reads the environment', () => {
    const before = process.env['SPRINT_CODER_COMPUTER_USE_ELIGIBILITY'];
    process.env['SPRINT_CODER_COMPUTER_USE_ELIGIBILITY'] = 'v2-denylist';
    try {
      expect(parseEligibilityMode([], 'darwin')).toBe('v1-allowlist');
    } finally {
      if (before === undefined) delete process.env['SPRINT_CODER_COMPUTER_USE_ELIGIBILITY'];
      else process.env['SPRINT_CODER_COMPUTER_USE_ELIGIBILITY'] = before;
    }
  });
});

describe('Computer Use native eligibility declaration', () => {
  it('preserves_existing_declarations_by_platform_and_mode', () => {
    for (const platform of ['darwin', 'win32']) {
      for (const mode of ['v1-allowlist', 'v2-denylist']) {
        expect(eligibilityDeclaration(mode, platform)).toEqual({
          mode,
          rulesetVersion: platform === 'win32' && mode === 'v2-denylist' ? 5 : 1,
          classifierVersion: platform === 'win32' && mode === 'v2-denylist' ? 4 : 1,
          lexiconVersion: platform === 'win32' && mode === 'v2-denylist' ? 3 : 1,
          ticketRequired: true,
          interlockEnforced: platform === 'win32' && mode === 'v2-denylist',
        });
      }
    }
  });

  it('rejects_unknown_platform_or_mode', () => {
    for (const platform of ['linux', '', 'toString', '__proto__'])
      expect(() => eligibilityDeclaration('v1-allowlist', platform)).toThrow();
    // Linux keeps parsing to the v1 default: the native build skips it after this call.
    expect(parseEligibilityMode([], 'linux')).toBe('v1-allowlist');
    for (const mode of ['v3', '', 'toString', '__proto__']) {
      expect(() => eligibilityDeclaration(mode, 'darwin')).toThrow();
      expect(() => parseEligibilityMode([`--eligibility=${mode}`], 'darwin')).toThrow();
    }
  });

  it('selects each platform and mode cell and preserves legacy values without defaults', async () => {
    const versions = (value) => ({
      rulesetVersion: value,
      classifierVersion: value + 1,
      lexiconVersion: value + 2,
    });
    for (const source of [
      {
        darwin: { v1: versions(4), v2: versions(7) },
        win32: { v1: versions(10), v2: versions(13) },
      },
      versions(16),
    ]) {
      vi.resetModules();
      vi.doMock('node:fs', () => ({
        readFileSync: () =>
          JSON.stringify({
            versions: source,
            ticketRequired: { darwin: true, win32: true },
          }),
      }));
      try {
        const helper = await import('../../build-computer-use-eligibility.mjs');
        for (const platform of ['darwin', 'win32']) {
          for (const [key, mode] of [
            ['v1', 'v1-allowlist'],
            ['v2', 'v2-denylist'],
          ]) {
            expect(helper.eligibilityDeclaration(mode, platform)).toEqual({
              mode,
              ...(source[platform]?.[key] ?? source),
              ticketRequired: true,
              interlockEnforced: platform === 'win32' && mode === 'v2-denylist',
            });
          }
        }
      } finally {
        vi.doUnmock('node:fs');
        vi.resetModules();
      }
    }
  });

  it('comes from the single eligibility.json; both natives claim a ticket', () => {
    const table = JSON.parse(
      readFileSync(resolve(desktopDirectory, 'computer-use-native', 'eligibility.json'), 'utf8'),
    );
    for (const platform of ['darwin', 'win32']) {
      const v1 = eligibilityDeclaration('v1-allowlist', platform);
      expect(v1).toEqual({
        mode: 'v1-allowlist',
        rulesetVersion: table.versions[platform].v1.rulesetVersion,
        classifierVersion: table.versions[platform].v1.classifierVersion,
        lexiconVersion: table.versions[platform].v1.lexiconVersion,
        ticketRequired: table.ticketRequired[platform],
        interlockEnforced: false,
      });
      // Each native refuses every input without a ticket (macOS: N2b-4 PR 5, Windows: S5-a).
      expect(v1.ticketRequired).toBe(true);
    }
    expect(eligibilityDeclaration('v2-denylist', 'darwin')).toEqual({
      ...eligibilityDeclaration('v1-allowlist', 'darwin'),
      mode: 'v2-denylist',
    });
  });

  it('refuses a mode or platform it does not know', () => {
    expect(() => eligibilityDeclaration('v3', 'darwin')).toThrow();
    expect(() => eligibilityDeclaration('v1-allowlist', 'linux')).toThrow();
  });

  it('writes a header that carries exactly the declaration', () => {
    const header = eligibilityBuildHeader(eligibilityDeclaration('v2-denylist', 'darwin'));
    expect(header).toContain('#pragma once');
    expect(header).toContain('#define SPRINT_CODER_ELIGIBILITY_INTERLOCK_ENFORCED 0');
    expect(eligibilityBuildHeader(eligibilityDeclaration('v2-denylist', 'win32'))).toContain(
      '#define SPRINT_CODER_ELIGIBILITY_INTERLOCK_ENFORCED 1',
    );
    const windowsV2 = eligibilityBuildHeader(eligibilityDeclaration('v2-denylist', 'win32'));
    for (const definition of [
      'FROM_BUILD 1',
      'V2 1',
      'RULESET_VERSION 5',
      'CLASSIFIER_VERSION 4',
      'LEXICON_VERSION 3',
      'TICKET_REQUIRED 1',
    ])
      expect(windowsV2).toContain(`#define SPRINT_CODER_ELIGIBILITY_${definition}`);
    // The harness conditions its default-value checks on this macro.
    expect(header).toContain('#define SPRINT_CODER_ELIGIBILITY_FROM_BUILD 1');
    expect(header).toContain('#define SPRINT_CODER_ELIGIBILITY_V2 1');
    expect(header).toContain('#define SPRINT_CODER_ELIGIBILITY_RULESET_VERSION 1');
    expect(header).toContain('#define SPRINT_CODER_ELIGIBILITY_CLASSIFIER_VERSION 1');
    expect(header).toContain('#define SPRINT_CODER_ELIGIBILITY_LEXICON_VERSION 1');
    expect(header).toContain('#define SPRINT_CODER_ELIGIBILITY_TICKET_REQUIRED 1');
    expect(eligibilityBuildHeader(eligibilityDeclaration('v1-allowlist', 'win32'))).toContain(
      '#define SPRINT_CODER_ELIGIBILITY_V2 0',
    );
    expect(eligibilityBuildHeader(eligibilityDeclaration('v1-allowlist', 'win32'))).toContain(
      '#define SPRINT_CODER_ELIGIBILITY_TICKET_REQUIRED 1',
    );
  });

  it('is wired into the build script for both platforms and the manifest', () => {
    const script = readFileSync(
      resolve(repositoryDirectory, 'build-computer-use-native.mjs'),
      'utf8',
    );
    expect(script).toContain("from './build-computer-use-eligibility.mjs'");
    expect(script).toContain('parseEligibilityMode(process.argv, target)');
    expect(script).toContain('eligibility: declaration');
    expect(script).not.toMatch(/process\.env\[?\.?['"]?SPRINT_CODER_COMPUTER_USE_ELIGIBILITY/u);
  });
});

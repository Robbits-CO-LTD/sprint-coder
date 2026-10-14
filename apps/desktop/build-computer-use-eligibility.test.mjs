import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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

  it('refuses a Windows deny-list build until S5', () => {
    expect(() => parseEligibilityMode(['--eligibility=v2'], 'win32')).toThrow(/S5/u);
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
  it('comes from the single eligibility.json; only the macOS native claims a ticket', () => {
    const table = JSON.parse(
      readFileSync(resolve(desktopDirectory, 'computer-use-native', 'eligibility.json'), 'utf8'),
    );
    for (const platform of ['darwin', 'win32']) {
      const v1 = eligibilityDeclaration('v1-allowlist', platform);
      expect(v1).toEqual({
        mode: 'v1-allowlist',
        rulesetVersion: table.versions.rulesetVersion,
        classifierVersion: table.versions.classifierVersion,
        lexiconVersion: table.versions.lexiconVersion,
        ticketRequired: table.ticketRequired[platform],
      });
      // The macOS native refuses every input without a ticket (N2b-4 PR 5); the Windows helper
      // claims none until S5.
      expect(v1.ticketRequired).toBe(platform === 'darwin');
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
      '#define SPRINT_CODER_ELIGIBILITY_TICKET_REQUIRED 0',
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

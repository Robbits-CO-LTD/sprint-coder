import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  initializeUserConfig,
  readGlobalSprintCoderInstructions,
  userConfigHome,
} from './user-config';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sprint-coder-user-config-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

it('keeps isolated profiles away from the normal user configuration', () => {
  vi.stubEnv('SPRINT_CODER_SKILL_HOME', '');
  vi.stubEnv('SPRINT_CODER_USER_DATA_DIR', home);
  expect(userConfigHome()).toBe(home);
  const skillHome = join(home, 'test-user');
  vi.stubEnv('SPRINT_CODER_SKILL_HOME', skillHome);
  expect(userConfigHome()).toBe(skillHome);
});

it('creates both editable defaults and preserves edits on later launches', () => {
  initializeUserConfig(home);
  const directory = join(home, '.sprint-coder');
  const settings = join(directory, 'settings.json');
  expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({
    permissions: { allow: [], deny: [] },
  });
  expect(readGlobalSprintCoderInstructions(home)).toBeNull();
  writeFileSync(settings, '{"permissions":{"deny":["Bash"]}}');
  writeFileSync(join(directory, 'SprintCoder.md'), '日本語で回答してください。');
  initializeUserConfig(home);
  expect(readGlobalSprintCoderInstructions(home)).toBe('日本語で回答してください。');
  expect(JSON.parse(readFileSync(settings, 'utf8')).permissions.deny).toEqual(['Bash']);
});

it('omits oversized or multiply-linked instructions', () => {
  mkdirSync(join(home, '.sprint-coder'));
  const instructions = join(home, '.sprint-coder', 'SprintCoder.md');
  writeFileSync(instructions, 'x'.repeat(65_537));
  expect(readGlobalSprintCoderInstructions(home)).toBeNull();
  writeFileSync(instructions, 'private text');
  linkSync(instructions, join(home, 'other.md'));
  expect(readGlobalSprintCoderInstructions(home)).toBeNull();
});

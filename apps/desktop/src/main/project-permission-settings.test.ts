import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadProjectPermissionSettings,
  matchProjectPermissionRules,
  projectRuleAllowsReadTree,
  type ProjectPermissionTarget,
} from './project-permission-settings';

let root: string;
const config = () => join(root, '.sprint-coder');
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sprint-permissions-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(settings: { allow?: string[]; deny?: string[] }, local = false) {
  mkdirSync(config(), { recursive: true });
  writeFileSync(
    join(config(), local ? 'settings.local.json' : 'settings.json'),
    JSON.stringify({ permissions: settings }),
  );
}

const decide = (target: ProjectPermissionTarget) =>
  matchProjectPermissionRules(loadProjectPermissionSettings(root), target);

describe('project permission files', () => {
  it('uses no rules when absent and merges both files with deny first', () => {
    expect(loadProjectPermissionSettings(root)).toMatchObject({ valid: true, deny: [], allow: [] });
    write({ allow: ['Read(./src/**)', 'Bash(git status)'], deny: ['Edit(README.md)'] });
    const shared = loadProjectPermissionSettings(root).digest;
    write({ allow: ['Edit(README.md)'], deny: ['Read(src/**/secrets.*)'] }, true);
    expect(loadProjectPermissionSettings(root).digest).not.toBe(shared);
    for (const name of ['src/secrets.txt', 'src/deep/.other/secrets.log']) {
      expect(decide({ tool: 'Read', relativePath: name })).toBe('deny');
    }
    expect(decide({ tool: 'Read', relativePath: 'src/lib.ts' })).toBe('allow');
    expect(decide({ tool: 'Read', relativePath: 'src2/lib.ts' })).toBeNull();
    expect(decide({ tool: 'Edit', relativePath: 'README.md' })).toBe('deny');
  });

  it('checks the resolved executable and each literal argument individually', () => {
    write({
      allow: ['Bash(git status)', 'Bash(git log:*)', 'Bash(git show "two words")'],
      deny: ['Bash(git log --private *)'],
    });
    const command = {
      tool: 'Bash' as const,
      executable: join(root, process.platform === 'win32' ? 'git.exe' : 'git'),
      trustedExecutableName: 'git',
    };
    expect(decide({ ...command, argv: ['status'] })).toBe('allow');
    expect(decide({ ...command, argv: ['status', '--ignored'] })).toBeNull();
    expect(decide({ ...command, argv: ['status && other-command'] })).toBeNull();
    expect(decide({ ...command, argv: ['show', 'two words'] })).toBe('allow');
    expect(decide({ ...command, argv: ['show', 'two', 'words'] })).toBeNull();
    expect(decide({ ...command, argv: ['log', '--oneline'] })).toBe('allow');
    expect(decide({ ...command, trustedExecutableName: undefined, argv: ['status'] })).toBeNull();
    expect(
      decide({ ...command, trustedExecutableName: undefined, argv: ['log', '--private'] }),
    ).toBe('deny');
    expect(
      decide({ ...command, executable: join(root, 'git-2.0'), argv: ['log', '--private'] }),
    ).toBe('deny');
  });

  it('requires entire subtree coverage for a recursive read', () => {
    write({ allow: ['Read(src)', 'Read(src/*/package.json)', 'Read(lib/**)'] });
    const settings = loadProjectPermissionSettings(root);
    expect(projectRuleAllowsReadTree(settings, 'src')).toBe(false);
    expect(projectRuleAllowsReadTree(settings, '.')).toBe(false);
    expect(projectRuleAllowsReadTree(settings, 'lib')).toBe(true);
    expect(projectRuleAllowsReadTree(settings, 'lib/deeper')).toBe(true);
  });

  it('blocks edits to the two rule files and their directory even without any rule', () => {
    for (const relativePath of [
      '.sprint-coder',
      '.sprint-coder/settings.json',
      '.sprint-coder/settings.local.json',
    ]) {
      expect(decide({ tool: 'Edit', relativePath })).toBe('deny');
    }
    expect(decide({ tool: 'Edit', relativePath: '.sprint-coder/notes.md' })).toBeNull();
  });

  it.each([
    '{',
    '{"permission":{"deny":["Read"]}}',
    '{"permissions":{"deni":["Read"]}}',
    '{"permissions":{"deny":10}}',
    '{"permissions":{"deny":["Read(../.env)"]}}',
    '{"permissions":{"deny":["Bash(git status && git diff)"]}}',
    '{"permissions":{"deny":["Typo(src)"]}}',
    '{"permissions":{"allow":["Read(a\u202eb)"]}}',
    'A'.repeat(65537),
  ])('fails closed on malformed or oversized local settings %#', (contents) => {
    write({ allow: ['Read'] });
    writeFileSync(join(config(), 'settings.local.json'), contents);
    expect(loadProjectPermissionSettings(root).valid).toBe(false);
    expect(decide({ tool: 'Read', relativePath: 'file.txt' })).toBe('deny');
  });

  it('rejects a linked parent, even when the target contains no settings', () => {
    const other = join(root, 'other');
    mkdirSync(other);
    symlinkSync(other, config(), process.platform === 'win32' ? 'junction' : 'dir');
    expect(loadProjectPermissionSettings(root).valid).toBe(false);
  });

  it('never silently skips a deny on case-insensitive volumes', () => {
    write({ deny: ['Read(Private/**)'] });
    renameSync(config(), join(root, '.SPRINT-CODER'));
    if (existsSync(config())) {
      expect(decide({ tool: 'Read', relativePath: 'Private/file.txt' })).toBe('deny');
    }
  });

  it('rejects a hardlinked settings file', () => {
    write({ allow: ['Edit'] });
    linkSync(join(config(), 'settings.json'), join(root, 'alias.json'));
    expect(loadProjectPermissionSettings(root).valid).toBe(false);
  });
});

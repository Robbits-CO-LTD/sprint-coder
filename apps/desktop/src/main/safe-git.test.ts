import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { safeGitEnvironment, safeGitExecFileSync, safeGitInvocationArgs } from './safe-git';

const cleanup: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('safe Git boundary', () => {
  it('forces non-executing config and command-specific options', () => {
    const diff = safeGitInvocationArgs(
      '/workspace',
      ['diff', '--binary'],
      ['Filter.evil.Clean', 'filter.evil.process'].join('\n'),
    );
    expect(diff).toEqual(
      expect.arrayContaining([
        '--no-pager',
        'core.hooksPath=',
        'core.fsmonitor=false',
        'core.attributesFile=',
        'submodule.recurse=false',
        'filter.evil.clean=',
        'filter.evil.process=',
        'filter.evil.required=false',
        '--no-ext-diff',
        '--no-textconv',
      ]),
    );
    expect(safeGitInvocationArgs('/workspace', ['hash-object', '--', 'file'], '')).toContain(
      '--no-filters',
    );
    expect(
      safeGitInvocationArgs('/workspace', ['-c', 'user.name=Worker', 'commit', '-m', 'change'], ''),
    ).toEqual(expect.arrayContaining(['commit', '--no-verify', '--no-gpg-sign']));
    expect(() => safeGitInvocationArgs('/workspace', ['status'], 'include.path')).toThrow(
      'config includes are not allowed',
    );
    expect(() => safeGitInvocationArgs('/workspace', ['status'], 'merge.evil.driver')).toThrow(
      'merge drivers are not allowed',
    );
    expect(() => safeGitInvocationArgs('/workspace', ['fetch'], '')).toThrow(
      'Git command is not allowed',
    );
    expect(safeGitEnvironment({ PATH: '/bin', HOME: '/home/test' }, 'linux')).toMatchObject({
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ATTR_NOSYSTEM: '1',
    });
    expect(
      safeGitEnvironment({ Path: 'C:\\Git', SYSTEMROOT: 'C:\\Windows' }, 'win32'),
    ).toMatchObject({
      GIT_CONFIG_GLOBAL: 'NUL',
      GIT_CONFIG_SYSTEM: 'NUL',
      SYSTEMROOT: 'C:\\Windows',
    });
  });

  it('does not execute repository fsmonitor, filter, external diff, or textconv commands', () => {
    const root = mkdtempSync(join(tmpdir(), 'sprint-coder-safe-git-'));
    cleanup.push(root);
    const repo = join(root, 'repo');
    const markers = {
      fsmonitor: join(root, 'fsmonitor.marker'),
      filter: join(root, 'filter.marker'),
      worktreeFilter: join(root, 'worktree-filter.marker'),
      externalDiff: join(root, 'external-diff.marker'),
      textconv: join(root, 'textconv.marker'),
      pager: join(root, 'pager.marker'),
      hook: join(root, 'hook.marker'),
    };
    expect(spawnSync('git', ['init', '-q', repo]).status).toBe(0);
    rawGit(repo, ['config', 'user.name', 'Test']);
    rawGit(repo, ['config', 'user.email', 'test@example.invalid']);
    writeFileSync(
      join(repo, '.gitattributes'),
      'tracked.txt filter=evil diff=evil\nworktree.txt filter=worktreeonly\n',
    );
    writeFileSync(join(repo, 'tracked.txt'), 'initial\n');
    writeFileSync(join(repo, 'worktree.txt'), 'initial\n');
    rawGit(repo, ['add', '.']);
    rawGit(repo, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-q',
      '-m',
      'fixture',
    ]);
    for (const [key, marker] of Object.entries(markers)) {
      const script = join(root, `${key}.cjs`);
      writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`);
      const command = `node ${JSON.stringify(script)}`;
      if (key === 'fsmonitor') rawGit(repo, ['config', 'core.fsmonitor', command]);
      else if (key === 'filter') rawGit(repo, ['config', 'filter.evil.clean', command]);
      else if (key === 'worktreeFilter') {
        rawGit(repo, ['config', 'extensions.worktreeConfig', 'true']);
        rawGit(repo, ['config', '--worktree', 'filter.worktreeonly.clean', command]);
      } else if (key === 'externalDiff') rawGit(repo, ['config', 'diff.external', command]);
      else if (key === 'textconv') rawGit(repo, ['config', 'diff.evil.textconv', command]);
      else if (key === 'pager') {
        rawGit(repo, ['config', 'core.pager', command]);
        rawGit(repo, ['config', 'pager.status', 'true']);
      }
    }
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\nnode ${JSON.stringify(join(root, 'hook.cjs'))}\n`);
    chmodSync(hook, 0o755);
    writeFileSync(join(repo, 'tracked.txt'), 'changed\n');
    writeFileSync(join(repo, 'worktree.txt'), 'changed\n');

    expect(safeGitExecFileSync(repo, ['status', '--porcelain'], limits()).trim()).toBe(
      ['M tracked.txt', ' M worktree.txt'].join('\n'),
    );
    expect(safeGitExecFileSync(repo, ['diff', '--binary'], limits())).toContain('+changed');
    expect(safeGitExecFileSync(repo, ['hash-object', '--', 'tracked.txt'], limits())).toMatch(
      /^[0-9a-f]{40,64}\n$/u,
    );
    safeGitExecFileSync(repo, ['add', 'tracked.txt'], limits());
    safeGitExecFileSync(repo, ['commit', '-m', 'safe update'], limits());
    for (const marker of Object.values(markers)) expect(existsSync(marker)).toBe(false);
  });
});

function rawGit(cwd: string, args: string[]): void {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
}

function limits(): { timeout: number; maxBuffer: number } {
  return { timeout: 5_000, maxBuffer: 1024 * 1024 };
}

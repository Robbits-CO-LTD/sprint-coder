import { execFile, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  safeGitEnvironment,
  safeGitExec,
  safeGitExecFile,
  safeGitExecFileSync,
  safeGitInvocationArgs,
  safeGitSpawnSync,
  type SafeGitExec,
} from './safe-git';

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];
const modes = ['async', 'sync', 'spawn'] as const;
type Mode = (typeof modes)[number];
const configError = 'Unable to read Git line-ending configuration';

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.each(modes)('safe Git autocrlf (%s)', (mode) => {
  it.runIf(process.platform === 'win32')(
    'finds host configuration through USERPROFILE without HOME',
    async () => {
      const { repo, env, home } = fixture();
      const { HOME: _home, ...withoutHome } = env;
      const source = { ...withoutHome, USERPROFILE: home };
      // Flip both ways so the system's policy alone cannot make this fallback test pass.
      writeFileSync(join(home, '.gitconfig'), '[core]\n autocrlf = false\n');
      expect(await run(mode, repo, ['diff', '--', 'tracked.txt'], source)).toContain('+first\r');
      writeFileSync(join(home, '.gitconfig'), '[core]\n autocrlf = true\n');
      expect(await run(mode, repo, ['diff', '--', 'tracked.txt'], source)).toBe('');
    },
  );

  it('matches a clean host CRLF checkout and respects a repository override', async () => {
    const { repo, env } = fixture();
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('first\r\nsecond\r\n');
    expect(rawGit(repo, ['status', '--porcelain'], env)).toBe('');
    const control = spawnSync('git', safeGitInvocationArgs(repo, ['status', '--porcelain'], ''), {
      env: safeGitEnvironment(env),
      encoding: 'utf8',
    });
    expect(control.status).toBe(0);
    expect(control.stdout).toContain('tracked.txt');
    expect(await run(mode, repo, ['status', '--porcelain'], env)).toBe('');

    rawGit(repo, ['config', 'core.autocrlf', 'false'], env);
    // A false policy makes the CR bytes meaningful, even if Git's stat cache masks status.
    expect(await run(mode, repo, ['diff', '--', 'tracked.txt'], env)).toContain('+first\r');
    rawGit(repo, ['config', 'extensions.worktreeConfig', 'true'], env);
    rawGit(repo, ['config', '--worktree', 'core.autocrlf', 'true'], env);
    expect(await run(mode, repo, ['diff', '--', 'tracked.txt'], env)).toBe('');
  });

  it('reads XDG configuration and Git boolean/input spellings without following included values', async () => {
    const { repo, env, home } = fixture();
    writeFileSync(join(home, '.gitconfig'), '');
    const xdg = join(home, 'xdg');
    mkdirSync(join(xdg, 'git'), { recursive: true });
    const source = { ...env, XDG_CONFIG_HOME: xdg };
    for (const value of ['true', 'YES', 'INPUT', 'Input']) {
      writeFileSync(join(xdg, 'git', 'config'), `[core]\n autocrlf = ${value}\n`);
      expect(await run(mode, repo, ['diff', '--', 'tracked.txt'], source)).toBe('');
    }
    const included = join(home, 'included');
    writeFileSync(included, '[core]\n autocrlf = false\n');
    rawGit(repo, ['config', '--file', join(xdg, 'git', 'config'), 'include.path', included], env);
    expect(await run(mode, repo, ['diff', '--', 'tracked.txt'], source)).toBe('');
  });

  it.each(['unknown', '" input "', 'malformed'])(
    'stops before staging on %s host configuration without exposing its contents',
    async (invalid) => {
      const { repo, env, home } = fixture();
      writeFileSync(join(repo, 'tracked.txt'), 'changed\r\n');
      writeFileSync(
        join(home, '.gitconfig'),
        invalid === 'malformed' ? '[private-invalid-config' : `[core]\n autocrlf = ${invalid}\n`,
      );
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        if (mode === 'spawn') expect(await run(mode, repo, ['add', 'tracked.txt'], env)).toBeNull();
        else
          await expect(run(mode, repo, ['add', 'tracked.txt'], env)).rejects.toThrow(configError);
        expect(stderr).not.toHaveBeenCalled();
      } finally {
        stderr.mockRestore();
      }
      expect(rawGit(repo, ['diff', '--cached', '--name-only'], safeGitEnvironment(env))).toBe('');
    },
  );

  it('never executes host fsmonitor, filters, hooks, pager, or diff helpers', async () => {
    const { repo, env, home } = fixture();
    const marker = join(home, 'executed');
    const script = join(home, 'helper.cjs');
    writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`);
    const command = `node ${JSON.stringify(script)}`;
    for (const key of [
      'core.fsmonitor',
      'filter.host.clean',
      'filter.host.smudge',
      'filter.host.process',
      'pager.config',
      'diff.external',
      'diff.host.textconv',
    ])
      rawGit(repo, ['config', '--file', join(home, '.gitconfig'), key, command], env);
    const hooks = join(home, 'hooks');
    mkdirSync(hooks);
    writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\n${command}\n`, { mode: 0o755 });
    rawGit(repo, ['config', '--file', join(home, '.gitconfig'), 'core.hooksPath', hooks], env);
    writeFileSync(join(repo, '.gitattributes'), 'tracked.txt filter=host diff=host\n');
    writeFileSync(join(repo, 'tracked.txt'), 'changed\r\n');
    expect(await run(mode, repo, ['status', '--porcelain'], env)).toContain('tracked.txt');
    expect(await run(mode, repo, ['diff'], env)).toContain('+changed');
    await run(mode, repo, ['add', '.'], env);
    await run(
      mode,
      repo,
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'safe'],
      env,
    );
    expect(existsSync(marker)).toBe(false);
  });
});

describe('autocrlf probe contract', () => {
  it('copies only configuration locations into the bounded probe and isolates the actual command', async () => {
    const source = {
      PATH: '/bin',
      HOME: '/home/test',
      USERPROFILE: 'C:\\Users\\Test',
      HOMEDRIVE: 'C:',
      HOMEPATH: '\\Users\\Test',
      XDG_CONFIG_HOME: '/xdg',
      GIT_CONFIG_GLOBAL: '/injected',
      GIT_CONFIG_SYSTEM: '/injected',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.autocrlf',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_PARAMETERS: 'injected',
      GIT_DIR: '/injected',
      GIT_WORK_TREE: '/injected',
    };
    const exec = vi
      .fn<SafeGitExec>()
      .mockResolvedValueOnce({ stdout: 'filter.local.clean', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'INPUT\0', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });
    await safeGitExec(exec, '/repo', ['status', '--porcelain'], {
      env: source,
      timeout: 123,
      maxBuffer: 32_768,
    });
    expect(exec).toHaveBeenCalledTimes(3);
    const probe = exec.mock.calls[1]!;
    expect(probe[1]).toEqual(
      expect.arrayContaining(['--no-includes', '--null', '--default=false']),
    );
    expect(probe[2]).toEqual({
      env: expect.objectContaining({
        HOME: source.HOME,
        USERPROFILE: source.USERPROFILE,
        HOMEDRIVE: source.HOMEDRIVE,
        HOMEPATH: source.HOMEPATH,
        XDG_CONFIG_HOME: source.XDG_CONFIG_HOME,
      }),
      timeout: 123,
      maxBuffer: 1_024,
    });
    for (const key of Object.keys(source).filter((key) => key.startsWith('GIT_')))
      expect(probe[2].env[key]).toBeUndefined();
    const command = exec.mock.calls[2]!;
    expect(command[1]).toEqual(
      expect.arrayContaining([
        'core.autocrlf=input',
        'filter.local.clean=',
        'core.fsmonitor=false',
      ]),
    );
    expect(command[2]).toEqual({
      env: safeGitEnvironment(source),
      timeout: 123,
      maxBuffer: 32_768,
    });
    expect(probe[2]).not.toHaveProperty('input');
  });

  it.each(['', 'true', 'true\n', 'true\0\n', 'true\0false\0', ' input\0', 'private-value\0'])(
    'refuses malformed probe output %j before the actual command',
    async (stdout) => {
      const exec = vi
        .fn<SafeGitExec>()
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockResolvedValueOnce({ stdout, stderr: 'private diagnostic' });
      await expect(safeGitExec(exec, '/repo', ['status'], { timeout: 1_000 })).rejects.toThrow(
        configError,
      );
      expect(exec).toHaveBeenCalledTimes(2);
    },
  );

  it.each([1, 128, 'ENOENT', 'ETIMEDOUT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'])(
    'stops on probe failure %s without returning private diagnostics',
    async (code) => {
      const exec = vi
        .fn<SafeGitExec>()
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        .mockRejectedValueOnce(Object.assign(new Error('private diagnostic'), { code }));
      await expect(safeGitExec(exec, '/repo', ['status'], { timeout: 1_000 })).rejects.toEqual(
        new Error(configError),
      );
      expect(exec).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['include.path', 'merge.evil.driver'])(
    'validates repository %s before consulting host configuration',
    async (stdout) => {
      const exec = vi.fn<SafeGitExec>().mockResolvedValue({ stdout, stderr: '' });
      await expect(safeGitExec(exec, '/repo', ['status'], { timeout: 1_000 })).rejects.toThrow(
        'not allowed',
      );
      expect(exec).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves the async file wrapper null-on-error contract', async () => {
    const { repo, env, home } = fixture();
    writeFileSync(join(home, '.gitconfig'), '[core]\n autocrlf = invalid\n');
    expect(await safeGitExecFile(repo, ['add', '.'], { env, timeout: 5_000 })).toBeNull();
  });
});

async function run(mode: Mode, repo: string, args: string[], env: NodeJS.ProcessEnv) {
  const options = { env, timeout: 5_000 };
  if (mode === 'sync') return safeGitExecFileSync(repo, args, options);
  if (mode === 'spawn') {
    const result = safeGitSpawnSync(repo, args, options);
    if (result === null) return null;
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  }
  return (
    await safeGitExec(
      async (file, command, invocationOptions) =>
        execFileAsync(file, [...command], invocationOptions),
      repo,
      args,
      options,
    )
  ).stdout;
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'sprint-coder-git-eol-'));
  cleanup.push(home);
  writeFileSync(join(home, '.gitconfig'), '[core]\n autocrlf = true\n');
  const env = {
    ...safeGitEnvironment(),
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'xdg'),
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
  };
  const source = join(home, 'source');
  rawGit(home, ['init', '-q', source], env);
  writeFileSync(join(source, 'tracked.txt'), 'first\nsecond\n');
  rawGit(source, ['-c', 'core.autocrlf=false', 'add', '.'], env);
  rawGit(
    source,
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'],
    env,
  );
  const repo = join(home, 'repo');
  rawGit(home, ['clone', '-q', source, repo], env);
  utimesSync(join(repo, 'tracked.txt'), new Date(0), new Date(0));
  return { home, repo, env };
}

function rawGit(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

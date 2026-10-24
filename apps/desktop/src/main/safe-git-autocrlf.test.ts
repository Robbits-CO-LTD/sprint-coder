import { execFile, spawnSync } from 'node:child_process';
import type * as NodeFs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerWorktreeManager } from './worker-worktree';
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
const configFault = vi.hoisted(() => ({
  failCleanup: false,
  failWrite: false,
  failedCleanupPath: '',
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (configFault.failCleanup && String(args[0]).includes('sprint-coder-git-config-')) {
        configFault.failCleanup = false;
        configFault.failedCleanupPath = String(args[0]);
        throw Object.assign(new Error('injected cleanup lock'), { code: 'EBUSY' });
      }
      return actual.rmSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (configFault.failWrite && String(args[0]).includes('sprint-coder-git-config-')) {
        configFault.failWrite = false;
        throw Object.assign(new Error('injected setup write failure'), { code: 'EACCES' });
      }
      return actual.writeFileSync(...args);
    },
  };
});

afterEach(async () => {
  configFault.failCleanup = false;
  configFault.failWrite = false;
  configFault.failedCleanupPath = '';
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  const { rm } = await import('node:fs/promises');
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.each(modes)('safe Git autocrlf (%s)', (mode) => {
  it.runIf(process.platform === 'win32')(
    'finds host configuration through USERPROFILE without HOME',
    async () => {
      const { repo, env, home } = fixture();
      const { HOME: _home, ...withoutHome } = env;
      // Windows spawn restores omitted home-pair keys; empty values preserve this fallback case.
      const source = { ...withoutHome, USERPROFILE: home, HOMEDRIVE: '', HOMEPATH: '' };
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

  it.each(['local', 'host'] as const)(
    'preserves a submodule CRLF policy from its %s config when its parent uses false',
    async (policy) => {
      const { repo, env, home } = fixture();
      const parent = join(home, 'parent');
      rawGit(home, ['init', '-q', parent], env);
      rawGit(parent, ['config', 'core.autocrlf', 'false'], env);
      rawGit(
        parent,
        ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', repo, 'sub'],
        env,
      );
      const child = join(parent, 'sub');
      if (policy === 'local') {
        rawGit(child, ['config', 'core.autocrlf', 'true'], env);
        writeFileSync(join(home, '.gitconfig'), '[core]\n autocrlf = false\n');
      }
      rawGit(parent, ['add', '.'], env);
      rawGit(
        parent,
        [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.invalid',
          'commit',
          '-qm',
          'submodule',
        ],
        env,
      );
      const tracked = join(child, 'tracked.txt');
      expect(readFileSync(tracked, 'utf8')).toBe('first\r\nsecond\r\n');
      utimesSync(tracked, new Date(0), new Date(0));
      expect(rawGit(parent, ['status', '--porcelain', '--ignore-submodules=none'], env)).toBe('');
      expect(
        await run(mode, parent, ['status', '--porcelain', '--ignore-submodules=none'], env),
      ).toBe('');

      writeFileSync(tracked, 'changed\r\n');
      expect(
        await run(mode, parent, ['status', '--porcelain', '--ignore-submodules=none'], env),
      ).toContain('sub');
    },
  );

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

  it.each([false, true])(
    'removes its owned temporary config after command failure=%s',
    async (fail) => {
      const { repo, env, home } = fixture();
      const originalGlobal = readFileSync(join(home, '.gitconfig'), 'utf8');
      const temporary = join(home, 'temporary');
      mkdirSync(temporary);
      for (const key of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(key, temporary);
      expect(tmpdir()).toBe(temporary);
      const result = run(
        mode,
        repo,
        fail ? ['rev-parse', '--verify', 'refs/heads/missing'] : ['status', '--porcelain'],
        env,
      );
      if (fail) await expect(result).rejects.toThrow();
      else await expect(result).resolves.toBe('');
      expect(readdirSync(temporary)).toEqual([]);
      expect(readFileSync(join(home, '.gitconfig'), 'utf8')).toBe(originalGlobal);
    },
  );

  it('preserves a successful real commit when temporary config cleanup is busy', async () => {
    const { repo, env, home } = fixture();
    const temporary = join(home, 'temporary');
    mkdirSync(temporary);
    for (const key of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(key, temporary);
    const before = rawGit(repo, ['rev-parse', 'HEAD'], env);
    configFault.failCleanup = true;
    const result = await run(
      mode,
      repo,
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--allow-empty',
        '-qm',
        'cleanup-result',
      ],
      env,
    ).then(
      (stdout) => ({ succeeded: true, stdout }),
      (error: unknown) => ({ succeeded: false, error }),
    );
    expect(rawGit(repo, ['rev-parse', 'HEAD'], env)).not.toBe(before);
    expect(rawGit(repo, ['log', '-1', '--format=%s'], env).trim()).toBe('cleanup-result');
    expect(configFault.failedCleanupPath).not.toBe('');
    expect(readFileSync(join(configFault.failedCleanupPath, 'config'), 'utf8')).toBe(
      '[core]\n autocrlf = true\n',
    );
    // The fixture owns the deliberately retained enum-only directory and removes it in afterEach.
    expect(result).toMatchObject({ succeeded: true });
  });

  it.each(['missing-temp', 'write-file'] as const)(
    'reports temporary config setup %s failure before staging',
    async (failure) => {
      const { repo, env, home } = fixture();
      const temporary = join(home, 'temporary');
      if (failure === 'write-file') mkdirSync(temporary);
      for (const key of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(key, temporary);
      writeFileSync(join(repo, 'tracked.txt'), 'unstaged change\r\n');
      expect(rawGit(repo, ['rev-parse', 'HEAD'], env).trim()).toMatch(/^[0-9a-f]{40,64}$/u);
      configFault.failWrite = failure === 'write-file';
      if (mode === 'spawn')
        await expect(run(mode, repo, ['add', 'tracked.txt'], env)).resolves.toBeNull();
      else
        await expect(run(mode, repo, ['add', 'tracked.txt'], env)).rejects.toEqual(
          new Error(configError),
        );
      expect(rawGit(repo, ['diff', '--cached', '--name-only'], env)).toBe('');
      if (failure === 'write-file') expect(readdirSync(temporary)).toEqual([]);
      else expect(existsSync(temporary)).toBe(false);
    },
  );
});

describe('autocrlf probe contract', () => {
  it('does not misclassify a missing temporary directory as Git being unavailable', async () => {
    const { repo, home } = fixture();
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', join(home, 'xdg'));
    for (const key of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(key, join(home, 'missing'));
    const calls: string[][] = [];
    const manager = new WorkerWorktreeManager({
      worktreesRoot: join(home, 'worktrees'),
      execFileImpl: async (file, args, options) => {
        calls.push([...args]);
        return execFileAsync(file, [...args], options);
      },
    });
    await expect(manager.requireCleanBase(repo)).rejects.toMatchObject({
      code: 'create_failed',
      message: configError,
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((args) => args.includes('config'))).toBe(true);
  });

  it.each([
    ['command\0false\0', 'false'],
    ['system\0true\0command\0false\0', 'true'],
    ['local\0true\0worktree\0input\0command\0false\0', 'false'],
  ])('uses only the host fallback from %j', async (stdout, expected) => {
    const exec = vi
      .fn<SafeGitExec>()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout, stderr: '' })
      .mockImplementationOnce(async (_file, _args, options) => {
        expect(readFileSync(options.env['GIT_CONFIG_GLOBAL']!, 'utf8')).toBe(
          `[core]\n autocrlf = ${expected}\n`,
        );
        return { stdout: '', stderr: '' };
      });
    await safeGitExec(exec, '/repo', ['status'], { timeout: 1_000 });
    expect(exec).toHaveBeenCalledTimes(3);
  });

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
      .mockResolvedValueOnce({
        stdout:
          'system\0true\0global\0false\0global\0INPUT\0local\0false\0worktree\0false\0command\0false\0',
        stderr: '',
      })
      .mockImplementationOnce(async (_file, _args, options) => {
        const config = options.env['GIT_CONFIG_GLOBAL']!;
        expect(readFileSync(config, 'utf8')).toBe('[core]\n autocrlf = input\n');
        if (process.platform !== 'win32') {
          expect(statSync(config).mode & 0o777).toBe(0o600);
          expect(statSync(dirname(config)).mode & 0o777).toBe(0o700);
        }
        return { stdout: '', stderr: '' };
      });
    await safeGitExec(exec, '/repo', ['status', '--porcelain'], {
      env: source,
      timeout: 123,
      maxBuffer: 32_768,
    });
    expect(exec).toHaveBeenCalledTimes(3);
    const probe = exec.mock.calls[1]!;
    expect(probe[1]).toEqual(
      expect.arrayContaining([
        '--no-includes',
        '--null',
        '--show-scope',
        '--get-all',
        'core.autocrlf=false',
      ]),
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
      expect.arrayContaining(['filter.local.clean=', 'core.fsmonitor=false']),
    );
    expect(command[1].some((argument) => argument.startsWith('core.autocrlf='))).toBe(false);
    const configPath = command[2].env['GIT_CONFIG_GLOBAL']!;
    expect(command[2]).toEqual({
      env: { ...safeGitEnvironment(source), GIT_CONFIG_GLOBAL: configPath },
      timeout: 123,
      maxBuffer: 32_768,
    });
    expect(configPath).not.toBe('/dev/null');
    expect(existsSync(dirname(configPath))).toBe(false);
    expect(probe[2]).not.toHaveProperty('input');
  });

  it.each([
    '',
    'true',
    'global\0true',
    'global\0true\0',
    'global\0true\0command\0false\0\n',
    'global\0 input\0command\0false\0',
    'global\0private-value\0command\0false\0',
    'unknown\0true\0command\0false\0',
  ])('refuses malformed probe output %j before the actual command', async (stdout) => {
    const exec = vi
      .fn<SafeGitExec>()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout, stderr: 'private diagnostic' });
    await expect(safeGitExec(exec, '/repo', ['status'], { timeout: 1_000 })).rejects.toThrow(
      configError,
    );
    expect(exec).toHaveBeenCalledTimes(2);
  });

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

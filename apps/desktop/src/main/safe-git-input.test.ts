import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  safeGitExec,
  safeGitExecFile,
  safeGitExecFileSync,
  safeGitSpawnSync,
  gitExecFile,
  safeGitEnvironment,
  type SafeGitExec,
} from './safe-git';

let root: string;
let repo: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sc-safe-git-input-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'xdg'));
  writeFileSync(join(root, '.gitconfig'), '[core]\n autocrlf = false\n');
  repo = join(root, 'repo');
  expect(spawnSync('git', ['init', '-q', repo]).status).toBe(0);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('safe Git bounded stdin', () => {
  it('keeps the default output buffer bound in the shared Worker process adapter', async () => {
    const result = await gitExecFile(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(1_048_577))"],
      { env: safeGitEnvironment(), timeout: 5_000 },
    ).then(
      (value) => ({ succeeded: true, bytes: Buffer.byteLength(value.stdout) }),
      (error: NodeJS.ErrnoException) => ({ succeeded: false, code: error.code }),
    );
    expect(result).toEqual({ succeeded: false, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
  });
  it.each(['async', 'sync', 'spawn'] as const)(
    'sends the exact UTF-8 bytes through %s',
    async (mode) => {
      const input = 'synthetic 日本語\r\nsecond\0record\n';
      const expected = createHash('sha1')
        .update(`blob ${Buffer.byteLength(input)}\0`)
        .update(input)
        .digest('hex');
      const options = { input, timeout: 1_500 };
      const command = ['hash-object', '--stdin'];
      const stdout =
        mode === 'async'
          ? await safeGitExecFile(repo, command, options)
          : mode === 'sync'
            ? safeGitExecFileSync(repo, command, options)
            : safeGitSpawnSync(repo, command, options)?.stdout;
      expect(stdout).toBe(`${expected}\n`);
    },
  );

  it('passes stdin only to the actual command, never either configuration probe', async () => {
    const exec = vi
      .fn<SafeGitExec>()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'command\0false\0', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'result', stderr: '' });
    await safeGitExec(exec, repo, ['merge-tree', '--write-tree', '--stdin'], {
      input: 'synthetic\n',
      timeout: 1000,
      maxBuffer: 4096,
    });
    expect(exec).toHaveBeenCalledTimes(3);
    expect(exec.mock.calls[0]![2]).not.toHaveProperty('input');
    expect(exec.mock.calls[1]![2]).not.toHaveProperty('input');
    expect(exec.mock.calls[2]![2]).toMatchObject({ input: 'synthetic\n', maxBuffer: 4096 });
  });

  it('rejects an input above the byte limit before starting Git', async () => {
    const exec = vi.fn<SafeGitExec>();
    await expect(
      safeGitExec(exec, repo, ['hash-object', '--stdin'], {
        input: '字'.repeat(350_000),
        timeout: 1000,
      }),
    ).rejects.toThrow('Git input exceeds');
    expect(exec).not.toHaveBeenCalled();
  });

  it.each(['success', 'EPIPE', 'timeout'] as const)(
    'owns child completion and config lifetime on %s',
    async (outcome) => {
      const evidence = join(root, 'child.json');
      let config = '';
      const script = `const fs = require('node:fs'); fs.writeFileSync(process.argv[1], JSON.stringify({pid:process.pid,configExists:fs.existsSync(process.env.GIT_CONFIG_GLOBAL)})); ${outcome === 'EPIPE' ? 'fs.closeSync(0);' : 'process.stdin.resume();'} ${outcome === 'success' ? "process.stdin.on('end', () => setTimeout(() => console.log(fs.existsSync(process.env.GIT_CONFIG_GLOBAL)), 20));" : 'setTimeout(() => {}, 10000);'}`;
      const exec: SafeGitExec = (file, args, options) => {
        if (args.includes('hash-object')) {
          config = options.env['GIT_CONFIG_GLOBAL']!;
          return gitExecFile(process.execPath, ['-e', script, evidence], options);
        }
        return gitExecFile(file, args, options);
      };
      const pending = safeGitExec(exec, repo, ['hash-object', '--stdin'], {
        input: 'x'.repeat(1_048_576),
        timeout: 1000,
      });
      if (outcome === 'success') await expect(pending).resolves.toMatchObject({ stdout: 'true\n' });
      else await expect(pending).rejects.toBeInstanceOf(Error);
      const child = JSON.parse(readFileSync(evidence, 'utf8')) as {
        pid: number;
        configExists: boolean;
      };
      expect(child.configExists).toBe(true);
      expect(() => process.kill(child.pid, 0)).toThrow();
      expect(existsSync(config)).toBe(false);
    },
  );
});

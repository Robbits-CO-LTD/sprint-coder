import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  WorkerWorktreeManager,
  WorktreeError,
  checkWorktreePathLengths,
  shortWorktreeDirectoryName,
} from './worker-worktree';

const UUID = '14838862-f09e-4174-84e4-68cbb3cac903-1';

describe('worker worktree path (issue #855)', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  });
  async function root(): Promise<string> {
    const r = await mkdtemp(join(tmpdir(), 'sc-wt-path-'));
    roots.push(r);
    return r;
  }

  it('builds a short deterministic directory name instead of the full id', async () => {
    const worktreesRoot = await root();
    const manager = new WorkerWorktreeManager({ worktreesRoot });
    const path = manager.worktreePathFor(UUID);
    expect(basename(path)).toBe(shortWorktreeDirectoryName(UUID));
    expect(basename(path)).toMatch(/^w-[0-9a-f]{10}$/);
    expect(manager.worktreePathFor(UUID)).toBe(path);
    expect(manager.worktreePathFor(`${UUID}x`)).not.toBe(path);
  });

  it('keeps using an already-created legacy worktree-<id> directory', async () => {
    const worktreesRoot = await root();
    const legacy = join(worktreesRoot, `worktree-${UUID}`);
    await mkdir(legacy, { recursive: true });
    const manager = new WorkerWorktreeManager({ worktreesRoot });
    expect(manager.worktreePathFor(UUID)).toBe(legacy);
    expect(manager.ownsWorktreePath(UUID, legacy)).toBe(true);
  });

  it('owns both the short and legacy path even before either exists', async () => {
    const worktreesRoot = await root();
    const manager = new WorkerWorktreeManager({ worktreesRoot });
    expect(
      manager.ownsWorktreePath(UUID, join(worktreesRoot, shortWorktreeDirectoryName(UUID))),
    ).toBe(true);
    expect(manager.ownsWorktreePath(UUID, join(worktreesRoot, `worktree-${UUID}`))).toBe(true);
    expect(manager.ownsWorktreePath(UUID, join(worktreesRoot, 'worktree-other'))).toBe(false);
  });

  it('reports over-long paths in Japanese and accepts normal ones', () => {
    const long = 'C:' + '/a'.repeat(125);
    expect(
      checkWorktreePathLengths({ platform: 'win32', worktreePath: long, gitAdminPath: 'C:/r' }),
    ).toMatch(/長すぎる/);
    expect(
      checkWorktreePathLengths({
        platform: 'win32',
        worktreePath:
          'C:/Users/dev/AppData/Roaming/Sprint Coder/team-worker-worktrees/w-0123456789',
        gitAdminPath: 'C:/repo/.git/worktrees/w-0123456789',
      }),
    ).toBeNull();
    expect(
      checkWorktreePathLengths({
        platform: 'darwin',
        worktreePath: 'a'.repeat(300),
        gitAdminPath: 'b',
      }),
    ).toBeNull();
  });

  it('fails before running git when the worktree path is too long', async () => {
    const worktreesRoot = join(await root(), 'd'.repeat(300));
    let called = false;
    const manager = new WorkerWorktreeManager({
      worktreesRoot,
      platform: 'win32',
      execFileImpl: async () => {
        called = true;
        return { stdout: '', stderr: '' };
      },
    });
    const error = await manager.create({ agentId: 'a1', repoPath: tmpdir() }).catch((e) => e);
    expect(error).toBeInstanceOf(WorktreeError);
    expect(error.code).toBe('create_failed');
    expect(error.message).toMatch(/長すぎる/);
    expect(called).toBe(false);
  });

  it('reports an over-long new path from ensureCreated (via create), before running git', async () => {
    const worktreesRoot = join(await root(), 'e'.repeat(300));
    let called = false;
    const manager = new WorkerWorktreeManager({
      worktreesRoot,
      platform: 'win32',
      execFileImpl: async () => {
        called = true;
        return { stdout: '', stderr: '' };
      },
    });
    const error = await manager
      .ensureCreated({ agentId: 'a3', repoPath: tmpdir() })
      .catch((e) => e);
    expect(error).toBeInstanceOf(WorktreeError);
    expect(error.message).toMatch(/長すぎる/);
    expect(called).toBe(false);
  });

  it("turns Git's own too-long error into the clear message (no ENAMETOOLONG on Windows)", async () => {
    const worktreesRoot = join(await root(), 'g');
    const manager = new WorkerWorktreeManager({
      worktreesRoot,
      platform: 'win32',
      execFileImpl: async (_file: string, args: readonly string[]) => {
        if (args.includes('add'))
          throw Object.assign(new Error("fatal: '$GIT_DIR' too big"), {
            code: 128,
            stderr: "fatal: '$GIT_DIR' too big",
          });
        return { stdout: args.includes('--git-common-dir') ? '.git' : '', stderr: '' };
      },
    });
    const error = await manager.create({ agentId: 'a4', repoPath: tmpdir() }).catch((e) => e);
    expect(error).toBeInstanceOf(WorktreeError);
    expect(error.message).toMatch(/長すぎる/);
  });

  it('runs every Git call with LC_ALL=C, so the stderr matched above is always English', async () => {
    const worktreesRoot = join(await root(), 'c');
    const envs: (NodeJS.ProcessEnv | undefined)[] = [];
    const manager = new WorkerWorktreeManager({
      worktreesRoot,
      execFileImpl: async (
        _file: string,
        args: readonly string[],
        options?: { env?: NodeJS.ProcessEnv },
      ) => {
        envs.push(options?.env);
        return {
          stdout: args.includes('rev-parse')
            ? `${'c'.repeat(40)}
`
            : '',
          stderr: '',
        };
      },
    });
    await manager.create({ agentId: 'a5', repoPath: tmpdir() }).catch(() => undefined);
    expect(envs.length).toBeGreaterThan(0);
    for (const env of envs) expect(env?.['LC_ALL']).toBe('C');
  });

  it("keeps Git's original error as the cause of the converted too-long error", async () => {
    const worktreesRoot = join(await root(), 'h');
    const original = Object.assign(new Error("fatal: '$GIT_DIR' too big"), {
      code: 128,
      stderr: "fatal: '$GIT_DIR' too big",
    });
    const manager = new WorkerWorktreeManager({
      worktreesRoot,
      platform: 'win32',
      execFileImpl: async (_file: string, args: readonly string[]) => {
        if (args.includes('add')) throw original;
        return { stdout: args.includes('--git-common-dir') ? '.git' : '', stderr: '' };
      },
    });
    const error = await manager.create({ agentId: 'a6', repoPath: tmpdir() }).catch((e) => e);
    expect(error.message).toMatch(/長すぎる/);
    expect(error.cause).toBeInstanceOf(WorktreeError);
  });

  it('does not call an unrelated worktree add failure too long', async () => {
    const worktreesRoot = join(await root(), 'u');
    const manager = new WorkerWorktreeManager({
      worktreesRoot,
      platform: 'win32',
      execFileImpl: async (_file: string, args: readonly string[]) => {
        if (args.includes('add'))
          throw Object.assign(new Error('fatal: invalid reference: HEAD'), {
            code: 128,
            stderr: 'fatal: invalid reference: HEAD',
          });
        return { stdout: args.includes('--git-common-dir') ? '.git' : '', stderr: '' };
      },
    });
    const error = await manager.create({ agentId: 'a7', repoPath: tmpdir() }).catch((e) => e);
    expect(error).toBeInstanceOf(WorktreeError);
    expect(error.message).not.toMatch(/長すぎる/);
  });

  it("checks Git's administration path under the common Git directory of a linked worktree", async () => {
    const worktreesRoot = join(await root(), 'w');
    const deepCommon = 'C:/' + 'x/'.repeat(120) + '.git';
    const calls: string[][] = [];
    const manager = new WorkerWorktreeManager({
      worktreesRoot,
      platform: 'win32',
      execFileImpl: async (_file: string, args: readonly string[]) => {
        calls.push([...args]);
        return { stdout: args.includes('--git-common-dir') ? deepCommon : '', stderr: '' };
      },
    });
    const error = await manager.create({ agentId: 'a2', repoPath: tmpdir() }).catch((e) => e);
    expect(error).toBeInstanceOf(WorktreeError);
    expect(error.message).toMatch(/長すぎる/);
    expect(calls.some((args) => args.includes('--git-common-dir'))).toBe(true);
    expect(calls.some((args) => args.includes('add'))).toBe(false);
  });

  it('still resumes an existing legacy worktree whose path exceeds the new-creation limit', async () => {
    const worktreesRoot = join(await root(), 'l'.repeat(230));
    const legacy = join(worktreesRoot, `worktree-${UUID}`);
    await mkdir(legacy, { recursive: true });
    const head = 'a'.repeat(40);
    const manager = new WorkerWorktreeManager({
      worktreesRoot,
      platform: 'win32',
      execFileImpl: async (_file: string, args: readonly string[]) => ({
        stdout: args.includes('rev-parse') ? `${head}\n` : '',
        stderr: '',
      }),
    });
    await expect(manager.ensureCreated({ agentId: UUID, repoPath: tmpdir() })).resolves.toEqual({
      path: legacy,
      baseHead: head,
    });
  });

  it('recreates a recorded legacy path longer than the new-creation limit without the length check', async () => {
    const worktreesRoot = join(await root(), 'k'.repeat(170));
    const legacy = join(worktreesRoot, `worktree-${UUID}`);
    const calls: string[][] = [];
    const manager = new WorkerWorktreeManager({
      worktreesRoot,
      platform: 'win32',
      execFileImpl: async (_file: string, args: readonly string[]) => {
        calls.push([...args]);
        return {
          stdout: args.includes('rev-parse')
            ? `${'b'.repeat(40)}
`
            : '',
          stderr: '',
        };
      },
    });
    expect(legacy.length).toBeGreaterThan(200);
    const created = await manager.ensureCreated({
      agentId: UUID,
      repoPath: tmpdir(),
      recordedPath: legacy,
    });
    expect(created.path).toBe(legacy);
    expect(calls.some((args) => args.includes('add'))).toBe(true);
  });

  describe.skipIf(!gitAvailable())('legacy registration whose directory is gone', () => {
    async function setup(rootName = 'wts'): Promise<{
      repoPath: string;
      legacy: string;
      manager: WorkerWorktreeManager;
    }> {
      const base = await root();
      const repoPath = join(base, 'repo');
      const worktreesRoot = join(base, rootName);
      await mkdir(repoPath);
      await mkdir(worktreesRoot);
      const git = (cwd: string, ...args: string[]): string =>
        execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', ...args], {
          cwd,
          encoding: 'utf8',
        });
      git(repoPath, 'init', '-q');
      await writeFile(join(repoPath, 'a.txt'), 'a\n');
      git(repoPath, 'add', '.');
      git(repoPath, 'commit', '-q', '-m', 'init');
      const legacy = join(worktreesRoot, `worktree-${UUID}`);
      git(repoPath, 'worktree', 'add', '--detach', legacy, 'HEAD');
      await rm(legacy, { recursive: true, force: true });
      expect(git(repoPath, 'worktree', 'list', '--porcelain')).toContain('worktree-');
      return { repoPath, legacy, manager: new WorkerWorktreeManager({ worktreesRoot }) };
    }
    const listed = (repoPath: string): string =>
      execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath, encoding: 'utf8' });

    it('cleanup unregisters the legacy record', async () => {
      const { repoPath, manager } = await setup();
      await manager.cleanup({ agentId: UUID, repoPath });
      expect(listed(repoPath)).not.toContain('worktree-');
    });

    it('cleanupUnchanged unregisters the legacy record', async () => {
      const { repoPath, manager } = await setup();
      const baseHead = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoPath,
        encoding: 'utf8',
      }).trim();
      await manager.cleanupUnchanged({ agentId: UUID, repoPath, baseHead });
      expect(listed(repoPath)).not.toContain('worktree-');
    });

    it('recreates a preparing record at its recorded legacy path, not at the new short path', async () => {
      const { repoPath, legacy, manager } = await setup();
      // The legacy registration is gone too: only the persisted record still names the legacy path.
      execFileSync('git', ['worktree', 'prune'], { cwd: repoPath });
      const created = await manager.ensureCreated({
        agentId: UUID,
        repoPath,
        recordedPath: legacy,
      });
      expect(created.path).toBe(legacy);
      expect(listed(repoPath)).toContain(`worktree-${UUID}`);
    });

    it('drops the stale legacy record before creating at the short path, so cleanup removes the new one', async () => {
      const { repoPath, manager } = await setup();
      const created = await manager.ensureCreated({ agentId: UUID, repoPath });
      expect(basename(created.path)).toBe(shortWorktreeDirectoryName(UUID));
      expect(listed(repoPath)).not.toContain('worktree-');
      await manager.cleanup({ agentId: UUID, repoPath });
      expect(listed(repoPath)).not.toContain(shortWorktreeDirectoryName(UUID));
    });

    it('fails (and keeps the record) when the stale legacy record is locked', async () => {
      const { repoPath, legacy, manager } = await setup();
      execFileSync('git', ['worktree', 'lock', legacy], { cwd: repoPath });
      const error = await manager.ensureCreated({ agentId: UUID, repoPath }).catch((e) => e);
      expect(error).toBeInstanceOf(WorktreeError);
      expect(error.code).toBe('create_failed');
      expect(listed(repoPath)).toContain(`worktree-${UUID}`);
      expect(listed(repoPath)).not.toContain(shortWorktreeDirectoryName(UUID));
    });

    it('discard unregisters the legacy record using the recorded path', async () => {
      const { repoPath, legacy, manager } = await setup();
      await manager.discard({ agentId: UUID, repoPath, path: legacy });
      expect(listed(repoPath)).not.toContain('worktree-');
    });

    it('finds the legacy record when the worktree root path contains spaces', async () => {
      const { repoPath, manager } = await setup('wt root with spaces');
      await manager.cleanup({ agentId: UUID, repoPath });
      expect(listed(repoPath)).not.toContain('worktree-');
    });

    it('keeps the record (fails) when the registration list cannot be read', async () => {
      const { repoPath, legacy } = await setup();
      const manager = new WorkerWorktreeManager({
        worktreesRoot: dirname(legacy),
        execFileImpl: async (_file: string, args: readonly string[]) => {
          if (args.includes('list')) throw Object.assign(new Error('git list failed'), { code: 1 });
          return { stdout: '', stderr: '' };
        },
      });
      await expect(manager.cleanup({ agentId: UUID, repoPath })).rejects.toBeInstanceOf(Error);
      expect(listed(repoPath)).toContain('worktree-');
    });
  });
});

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

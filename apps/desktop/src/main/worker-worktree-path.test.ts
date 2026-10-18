import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
      checkWorktreePathLengths({ platform: 'win32', worktreePath: long, gitAdminPath: 'C:\r' }),
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
});

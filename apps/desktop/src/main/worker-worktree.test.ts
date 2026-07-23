import { afterEach, describe, expect, it } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { WorkerWorktreeManager } from './worker-worktree';

const execFileAsync = promisify(execFile);
const gitAvailable = isGitAvailable();

describe.skipIf(!gitAvailable)('WorkerWorktreeManager', () => {
  const cleanupRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it('creates a worktree detached at the base ref and records the real HEAD', async () => {
    const { repoPath, head, manager } = await fixture();

    const result = await manager.create({ agentId: 'agent-1', repoPath });

    expect(result.baseHead).toBe(head);
    expect((await stat(result.path)).isDirectory()).toBe(true);
  });

  it('rejects a second create for the same agentId', async () => {
    const { repoPath, manager } = await fixture();
    await manager.create({ agentId: 'agent-2', repoPath });

    await expect(manager.create({ agentId: 'agent-2', repoPath })).rejects.toMatchObject({
      code: 'create_failed',
    });
  });

  it('rejects an agentId that does not match the allowed character set', async () => {
    const { repoPath, manager } = await fixture();

    await expect(manager.create({ agentId: '../evil', repoPath })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('removes a clean worktree on cleanup', async () => {
    const { repoPath, manager } = await fixture();
    const { path: worktreePath } = await manager.create({ agentId: 'agent-3', repoPath });

    const result = await manager.cleanup({ agentId: 'agent-3', repoPath });

    expect(result).toEqual({ outcome: 'removed' });
    await expect(stat(worktreePath)).rejects.toThrow();
  });

  it('quarantines a dirty worktree instead of deleting it', async () => {
    const { repoPath, manager } = await fixture();
    const { path: worktreePath } = await manager.create({ agentId: 'agent-4', repoPath });
    await writeFile(join(worktreePath, 'scratch.txt'), 'work in progress\n');

    const result = await manager.cleanup({ agentId: 'agent-4', repoPath });

    expect(result).toEqual({ outcome: 'quarantined' });
    expect((await stat(worktreePath)).isDirectory()).toBe(true);
  });

  it('treats cleanup of an already-gone worktree as removed', async () => {
    const { repoPath, manager } = await fixture();

    const result = await manager.cleanup({ agentId: 'agent-5', repoPath });

    expect(result).toEqual({ outcome: 'removed' });
  });

  async function fixture(): Promise<{
    repoPath: string;
    head: string;
    worktreesRoot: string;
    manager: WorkerWorktreeManager;
  }> {
    const { repoPath, head } = await makeRepo();
    const worktreesRoot = await mkdtemp(join(tmpdir(), 'sprint-coder-worktree-root-'));
    cleanupRoots.push(repoPath, worktreesRoot);
    return { repoPath, head, worktreesRoot, manager: new WorkerWorktreeManager({ worktreesRoot }) };
  }
});

async function makeRepo(): Promise<{ repoPath: string; head: string }> {
  const repoPath = await mkdtemp(join(tmpdir(), 'sprint-coder-worktree-repo-'));
  await git(['init', '-q', repoPath]);
  await writeFile(join(repoPath, 'README.md'), 'hello\n');
  await git([
    '-C',
    repoPath,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'add',
    'README.md',
  ]);
  await git([
    '-C',
    repoPath,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-q',
    '-m',
    'init',
  ]);
  const head = (await git(['-C', repoPath, 'rev-parse', 'HEAD'])).trim();
  return { repoPath, head };
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args);
  return stdout;
}

function isGitAvailable(): boolean {
  try {
    const result = spawnSync('git', ['--version']);
    return result.error === undefined && result.status === 0;
  } catch {
    return false;
  }
}

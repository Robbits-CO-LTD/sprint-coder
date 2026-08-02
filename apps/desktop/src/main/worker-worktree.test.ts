import { afterEach, describe, expect, it } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
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

  it('groups multiple roots from the same clean repository', async () => {
    const { repoPath, head, manager } = await fixture();
    const secondary = join(repoPath, 'packages', 'secondary');
    await mkdir(secondary, { recursive: true });

    await expect(manager.requireCleanRepositorySet([repoPath, secondary])).resolves.toEqual([
      {
        repoPath: await realpath(repoPath),
        head,
        rootPaths: [await realpath(repoPath), await realpath(secondary)],
      },
    ]);
  });

  it('rejects dirty, non-Git, and in-progress repositories', async () => {
    const dirty = await fixture();
    await writeFile(join(dirty.repoPath, 'dirty.txt'), 'dirty\n');
    await expect(dirty.manager.requireCleanRepositorySet([dirty.repoPath])).rejects.toMatchObject({
      code: 'base_changed',
    });

    const nonGit = await mkdtemp(join(tmpdir(), 'sprint-coder-non-git-'));
    cleanupRoots.push(nonGit);
    await expect(dirty.manager.requireCleanRepositorySet([nonGit])).rejects.toMatchObject({
      code: 'create_failed',
    });

    const progressing = await fixture();
    const gitDirectory = (await git(['-C', progressing.repoPath, 'rev-parse', '--git-dir'])).trim();
    await writeFile(join(progressing.repoPath, gitDirectory, 'MERGE_HEAD'), progressing.head);
    await expect(
      progressing.manager.requireCleanRepositorySet([progressing.repoPath]),
    ).rejects.toMatchObject({ code: 'base_changed' });

    const nested = await fixture();
    const nestedRepo = join(nested.repoPath, 'nested-repository');
    await mkdir(nestedRepo);
    await git(['init', '-q', nestedRepo]);
    await writeFile(join(nestedRepo, 'README.md'), 'nested\n');
    await git(['-C', nestedRepo, 'add', 'README.md']);
    await git([
      '-C',
      nestedRepo,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-q',
      '-m',
      'nested',
    ]);
    await expect(
      nested.manager.requireCleanRepositorySet([nested.repoPath, nestedRepo]),
    ).rejects.toThrow('Nested Git repositories');
  });

  it('rejects a second create for the same agentId', async () => {
    const { repoPath, manager } = await fixture();
    await manager.create({ agentId: 'agent-2', repoPath });

    await expect(manager.create({ agentId: 'agent-2', repoPath })).rejects.toMatchObject({
      code: 'create_failed',
    });
  });

  it('adopts a clean deterministic worktree left by a preparing execution', async () => {
    const { repoPath, head, manager } = await fixture();
    const created = await manager.create({
      agentId: 'agent-prepare',
      worktreeId: 'execution-prepare-1',
      repoPath,
      baseRef: head,
    });

    await expect(
      manager.ensureCreated({
        agentId: 'agent-prepare',
        worktreeId: 'execution-prepare-1',
        repoPath,
        baseRef: head,
      }),
    ).resolves.toEqual(created);
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

  it('collapses Worker changes into one commit and integrates them into a clean workspace', async () => {
    const { repoPath, head, manager } = await fixture();
    const worktreeId = 'execution-1';
    const { path: worktreePath } = await manager.create({
      agentId: 'agent-6',
      worktreeId,
      repoPath,
    });
    await writeFile(join(worktreePath, 'README.md'), 'changed by worker\n');
    await writeFile(join(worktreePath, 'new.txt'), 'new artifact\n');

    const finalized = await manager.finalizeChanges({
      agentId: 'agent-6',
      worktreeId,
      repoPath,
      baseHead: head,
      commitMessage: 'Sprint Coder Mission step',
    });
    const integrated = await manager.integrate({
      repoPath,
      baseHead: head,
      workerHead: finalized.workerHead,
    });

    expect(finalized.changedFiles).toEqual(['README.md', 'new.txt']);
    expect(integrated.outcome).toBe('integrated');
    expect(integrated.integratedHead).not.toBe(head);
    expect(await readFile(join(repoPath, 'README.md'), 'utf8')).toBe('changed by worker\n');
    expect(await readFile(join(repoPath, 'new.txt'), 'utf8')).toBe('new artifact\n');
    expect((await git(['-C', repoPath, 'status', '--porcelain'])).trim()).toBe('');
    await expect(manager.cleanup({ agentId: 'agent-6', worktreeId, repoPath })).resolves.toEqual({
      outcome: 'removed',
    });
  });

  it('recognizes an integration that completed before its durable state was recorded', async () => {
    const { repoPath, head, manager } = await fixture();
    const worktreeId = 'execution-2';
    const { path: worktreePath } = await manager.create({
      agentId: 'agent-7',
      worktreeId,
      repoPath,
    });
    await writeFile(join(worktreePath, 'README.md'), 'recoverable\n');
    const finalized = await manager.finalizeChanges({
      agentId: 'agent-7',
      worktreeId,
      repoPath,
      baseHead: head,
      commitMessage: 'recoverable integration',
    });
    const first = await manager.integrate({
      repoPath,
      baseHead: head,
      workerHead: finalized.workerHead,
    });

    const recovered = await manager.integrate({
      repoPath,
      baseHead: head,
      workerHead: finalized.workerHead,
    });

    expect(first.outcome).toBe('integrated');
    expect(recovered).toEqual({
      integratedHead: first.integratedHead,
      outcome: 'already_integrated',
    });
  });

  it('refuses integration when the primary workspace changed and preserves both sides', async () => {
    const { repoPath, head, manager } = await fixture();
    const worktreeId = 'execution-3';
    const { path: worktreePath } = await manager.create({
      agentId: 'agent-8',
      worktreeId,
      repoPath,
    });
    await writeFile(join(worktreePath, 'README.md'), 'worker version\n');
    const finalized = await manager.finalizeChanges({
      agentId: 'agent-8',
      worktreeId,
      repoPath,
      baseHead: head,
      commitMessage: 'isolated worker result',
    });
    await writeFile(join(repoPath, 'README.md'), 'outside change\n');

    await expect(
      manager.integrate({
        repoPath,
        baseHead: head,
        workerHead: finalized.workerHead,
      }),
    ).rejects.toMatchObject({ code: 'base_changed' });

    expect(await readFile(join(repoPath, 'README.md'), 'utf8')).toBe('outside change\n');
    expect(await readFile(join(worktreePath, 'README.md'), 'utf8')).toBe('worker version\n');
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

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

  it('revalidates a recorded integration without discarding later parent commits', async () => {
    const { repoPath, head, manager } = await fixture();
    const worktreeId = 'execution-revalidate';
    const { path: worktreePath } = await manager.create({
      agentId: 'agent-revalidate',
      worktreeId,
      repoPath,
    });
    await writeFile(join(worktreePath, 'worker.txt'), 'worker result\n');
    const finalized = await manager.finalizeChanges({
      agentId: 'agent-revalidate',
      worktreeId,
      repoPath,
      baseHead: head,
      commitMessage: 'recorded integration',
    });
    const integrated = await manager.integrate({
      repoPath,
      baseHead: head,
      workerHead: finalized.workerHead,
    });
    await writeFile(join(repoPath, 'later.txt'), 'later parent change\n');
    await git(['-C', repoPath, 'add', 'later.txt']);
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
      'later parent commit',
    ]);

    await expect(
      manager.revalidateIntegration({
        repoPath,
        baseHead: head,
        workerHead: finalized.workerHead,
        integratedHead: integrated.integratedHead,
      }),
    ).resolves.toEqual({
      integratedHead: integrated.integratedHead,
      outcome: 'already_integrated',
    });
    expect(await readFile(join(repoPath, 'later.txt'), 'utf8')).toBe('later parent change\n');

    await git(['-C', repoPath, 'reset', '--hard', head]);
    await expect(
      manager.revalidateIntegration({
        repoPath,
        baseHead: head,
        workerHead: finalized.workerHead,
        integratedHead: integrated.integratedHead,
      }),
    ).rejects.toMatchObject({ code: 'base_changed' });
  });

  it('keeps descendant parent commits when a Worker has no changes', async () => {
    const { repoPath, head, manager } = await fixture();

    await writeFile(join(repoPath, 'outside.txt'), 'unsealed\n');
    await expect(
      manager.integrate({ repoPath, baseHead: head, workerHead: head }),
    ).rejects.toMatchObject({ code: 'base_changed' });

    await git(['-C', repoPath, 'add', 'outside.txt']);
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
      'external change',
    ]);
    await expect(
      manager.integrate({ repoPath, baseHead: head, workerHead: head }),
    ).resolves.toEqual({
      integratedHead: expect.any(String),
      outcome: 'no_changes',
    });
  });

  it('cherry-picks independent Worker commits created from the same base in FIFO order', async () => {
    const { repoPath, head, manager } = await fixture();
    const first = await manager.create({
      agentId: 'parallel-a',
      worktreeId: 'parallel-a',
      repoPath,
      baseRef: head,
    });
    const second = await manager.create({
      agentId: 'parallel-b',
      worktreeId: 'parallel-b',
      repoPath,
      baseRef: head,
    });
    await writeFile(join(first.path, 'first.txt'), 'first\n');
    await writeFile(join(second.path, 'second.txt'), 'second\n');
    const firstFinalized = await manager.finalizeChanges({
      agentId: 'parallel-a',
      worktreeId: 'parallel-a',
      repoPath,
      baseHead: head,
      commitMessage: 'first Worker',
    });
    const secondFinalized = await manager.finalizeChanges({
      agentId: 'parallel-b',
      worktreeId: 'parallel-b',
      repoPath,
      baseHead: head,
      commitMessage: 'second Worker',
    });

    const firstIntegrated = await manager.integrate({
      repoPath,
      baseHead: head,
      workerHead: firstFinalized.workerHead,
    });
    const secondIntegrated = await manager.integrate({
      repoPath,
      baseHead: head,
      workerHead: secondFinalized.workerHead,
    });

    expect(firstIntegrated.outcome).toBe('integrated');
    expect(secondIntegrated.outcome).toBe('integrated');
    expect(await readFile(join(repoPath, 'first.txt'), 'utf8')).toBe('first\n');
    expect(await readFile(join(repoPath, 'second.txt'), 'utf8')).toBe('second\n');
    expect((await git(['-C', repoPath, 'rev-list', '--count', `${head}..HEAD`])).trim()).toBe('2');
    expect((await git(['-C', repoPath, 'status', '--porcelain'])).trim()).toBe('');
  });

  it('keeps non-conflicting changes made to different lines of the same file', async () => {
    const { repoPath, manager } = await fixture();
    await writeFile(join(repoPath, 'shared.txt'), 'top\nmiddle\nbottom\n');
    await git(['-C', repoPath, 'add', 'shared.txt']);
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
      'shared base',
    ]);
    const baseHead = (await git(['-C', repoPath, 'rev-parse', 'HEAD'])).trim();
    const first = await manager.create({
      agentId: 'same-file-a',
      worktreeId: 'same-file-a',
      repoPath,
      baseRef: baseHead,
    });
    const second = await manager.create({
      agentId: 'same-file-b',
      worktreeId: 'same-file-b',
      repoPath,
      baseRef: baseHead,
    });
    await writeFile(join(first.path, 'shared.txt'), 'TOP\nmiddle\nbottom\n');
    await writeFile(join(second.path, 'shared.txt'), 'top\nmiddle\nBOTTOM\n');
    const firstFinalized = await manager.finalizeChanges({
      agentId: 'same-file-a',
      worktreeId: 'same-file-a',
      repoPath,
      baseHead,
      commitMessage: 'change top line',
    });
    const secondFinalized = await manager.finalizeChanges({
      agentId: 'same-file-b',
      worktreeId: 'same-file-b',
      repoPath,
      baseHead,
      commitMessage: 'change bottom line',
    });

    await manager.integrate({
      repoPath,
      baseHead,
      workerHead: firstFinalized.workerHead,
    });
    await manager.integrate({
      repoPath,
      baseHead,
      workerHead: secondFinalized.workerHead,
    });

    expect(await readFile(join(repoPath, 'shared.txt'), 'utf8')).toBe('TOP\nmiddle\nBOTTOM\n');
    expect((await git(['-C', repoPath, 'rev-list', '--count', `${baseHead}..HEAD`])).trim()).toBe(
      '2',
    );
    expect((await git(['-C', repoPath, 'status', '--porcelain'])).trim()).toBe('');
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

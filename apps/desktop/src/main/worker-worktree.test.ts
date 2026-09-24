import { afterEach, describe, expect, it } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
  rename,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  WorkerWorktreeManager,
  removeTreeWithoutFollowingLinks,
  type ExecFileImpl,
  type TreeRemovalFs,
} from './worker-worktree';

const execFileAsync = promisify(execFile);
const gitAvailable = isGitAvailable();
const TEST_IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
/**
 * Clones a local submodule: Git refuses the file protocol unless it is allowed, and the clone keeps
 * the committed bytes. A host `core.autocrlf` would otherwise leave the submodule looking modified to
 * the manager's own Git (which reads no host configuration), and a status showing that change would
 * keep the worktree whether or not submodules are checked.
 */
const SUBMODULE_CLONE = ['-c', 'protocol.file.allow=always', '-c', 'core.autocrlf=false'];
/** A Windows junction needs no privilege; elsewhere a directory symlink is the same kind of link. */
const DIRECTORY_LINK = process.platform === 'win32' ? 'junction' : 'dir';

/**
 * The real file system, except that removing a path `fails` names throws `code`, `times` times (a
 * held Windows lock, or a removal cut short part way).
 */
function failingRemovalFs(
  fails: (path: string) => boolean,
  code: string,
  times = Number.POSITIVE_INFINITY,
): TreeRemovalFs {
  let failures = 0;
  const guard = (path: string, action: string): void => {
    if (!fails(path) || failures >= times) return;
    failures += 1;
    throw Object.assign(new Error(`${code}: operation failed, ${action} '${path}'`), { code });
  };
  return {
    lstat: (path) => lstat(path),
    readdir: (path) => readdir(path),
    unlink: async (path) => {
      guard(path, 'unlink');
      await unlink(path);
    },
    rmdir: async (path) => {
      guard(path, 'rmdir');
      await rmdir(path);
    },
    chmod: (path, mode) => chmod(path, mode),
  };
}

function interceptWorktreeRemove(beforeRemove: () => void): ExecFileImpl {
  return async (file, args, options) => {
    if (args.includes('worktree') && args.includes('remove')) beforeRemove();
    const result = await execFileAsync(file, [...args], {
      env: options.env,
      timeout: options.timeout,
    });
    return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };
}

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

  it('recognizes its registered retained checkout using the host path spelling', async () => {
    const { repoPath, head, manager } = await fixture();
    const worktree = await manager.create({ agentId: 'registered', repoPath });
    await expect(
      manager.inspectPreserved({ agentId: 'registered', repoPath, ...worktree }),
    ).resolves.toMatchObject({
      path: await realpath(worktree.path),
      baseHead: head,
      changedFiles: [],
    });
  });

  it('refuses a retained worktree path replaced by a link to the primary checkout', async () => {
    const { repoPath, head, manager, worktreesRoot } = await fixture();
    await mkdir(worktreesRoot, { recursive: true });
    const path = manager.worktreePathFor('linked');
    await symlink(repoPath, path, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(
      manager.inspectPreserved({ agentId: 'linked', repoPath, path, baseHead: head }),
    ).rejects.toThrow('own directory');
  });

  it('reads both rename endpoints and preserves quoted Unicode and control characters from sealed commits', async () => {
    const { repoPath, head, manager } = await fixture();
    const worktree = await manager.create({ agentId: 'scope-test', repoPath });
    await mkdir(join(worktree.path, 'allowed'));
    await rename(join(worktree.path, 'README.md'), join(worktree.path, 'allowed', 'moved.md'));
    const names = [
      '日本語.txt',
      '\ufeffname.txt',
      ...(process.platform === 'win32' ? [] : ['tab\tname.txt', 'line\nname.txt']),
    ];
    for (const name of names) await writeFile(join(worktree.path, name), 'new');
    const finalized = await manager.finalizeChanges({
      agentId: 'scope-test',
      repoPath,
      baseHead: head,
      commitMessage: 'sealed changes',
    });
    expect(finalized.changedFiles).toContain('README.md');
    const changes = await manager.readSealedChanges({
      repoPath,
      baseHead: head,
      workerHead: finalized.workerHead,
    });
    expect(changes).toContainEqual({ status: 'D', path: 'README.md' });
    expect(changes).toContainEqual({ status: 'A', path: 'allowed/moved.md' });
    for (const path of names) expect(changes).toContainEqual({ status: 'A', path });
    expect((await git(['-C', repoPath, 'rev-parse', 'HEAD'])).trim()).toBe(head);
  });

  it.runIf(process.platform === 'linux')(
    'refuses an undecodable Git filename before integration',
    async () => {
      const { repoPath, head, manager } = await fixture();
      const worktree = await manager.create({ agentId: 'invalid-name', repoPath });
      await writeFile(
        Buffer.concat([Buffer.from(`${worktree.path}/`), Buffer.from([255])]),
        'invalid name',
      );
      const finalized = await manager.finalizeChanges({
        agentId: 'invalid-name',
        repoPath,
        baseHead: head,
        commitMessage: 'invalid UTF-8',
      });
      await expect(
        manager.readSealedChanges({ repoPath, baseHead: head, workerHead: finalized.workerHead }),
      ).rejects.toThrow('not valid UTF-8');
      expect((await git(['-C', repoPath, 'rev-parse', 'HEAD'])).trim()).toBe(head);
    },
  );

  it('inspects and integrates the sealed object even when replacement refs exist', async () => {
    const { repoPath, head, manager } = await fixture();
    const worktree = await manager.create({ agentId: 'replace-ref', repoPath });
    await writeFile(join(worktree.path, 'README.md'), 'sealed\n');
    const sealed = await manager.finalizeChanges({
      agentId: 'replace-ref',
      repoPath,
      baseHead: head,
      commitMessage: 'sealed',
    });
    await writeFile(join(worktree.path, 'outside.txt'), 'replacement-only\n');
    const replacement = await manager.finalizeChanges({
      agentId: 'replace-ref',
      repoPath,
      baseHead: head,
      commitMessage: 'replacement',
    });
    await git(['-C', repoPath, 'replace', sealed.workerHead, replacement.workerHead]);
    expect(
      await manager.readSealedChanges({ repoPath, baseHead: head, workerHead: sealed.workerHead }),
    ).toEqual([{ status: 'M', path: 'README.md' }]);
    await manager.integrate({ repoPath, baseHead: head, workerHead: sealed.workerHead });
    expect(await readFile(join(repoPath, 'README.md'), 'utf8')).toBe('sealed\n');
    await expect(stat(join(repoPath, 'outside.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
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

  it('does not execute a repository-local fsmonitor while requiring a clean base', async () => {
    const { repoPath, head, manager } = await fixture();
    const marker = join(repoPath, '..', 'fsmonitor.marker');
    const script = join(repoPath, '..', 'fsmonitor.cjs');
    await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`);
    await git(['-C', repoPath, 'config', 'core.fsmonitor', `node ${JSON.stringify(script)}`]);

    await expect(manager.requireCleanBase(repoPath)).resolves.toEqual({ head });
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
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

  it.each(['cleanup', 'cleanupUnchanged'] as const)(
    '%s unregisters only its own missing worktree and keeps the user missing worktree',
    async (method) => {
      const { repoPath, worktreesRoot } = await fixture();
      const commands: string[][] = [];
      const manager = new WorkerWorktreeManager({
        worktreesRoot,
        execFileImpl: async (file, args, options) => {
          commands.push([...args]);
          const result = await execFileAsync(file, [...args], {
            env: options.env,
            timeout: options.timeout,
          });
          return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
        },
      });
      const created = await manager.create({ agentId: 'agent-gone', repoPath });
      const userRoot = await mkdtemp(join(tmpdir(), 'sprint-coder-user-worktree-'));
      cleanupRoots.push(userRoot);
      const userWorktree = join(userRoot, 'on-unplugged-drive');
      await git(['-C', repoPath, 'worktree', 'add', '-q', '--detach', userWorktree]);
      await rm(created.path, { recursive: true, force: true });
      await rm(userWorktree, { recursive: true, force: true });

      const result =
        method === 'cleanup'
          ? await manager.cleanup({ agentId: 'agent-gone', repoPath })
          : await manager.cleanupUnchanged({
              agentId: 'agent-gone',
              repoPath,
              baseHead: created.baseHead,
            });

      expect(result).toEqual({ outcome: 'removed' });
      const registered = await registeredWorktrees(repoPath);
      expect(registered).toContain(await samePathKey(userWorktree));
      expect(registered).not.toContain(await samePathKey(created.path));
      expect(commands.some((args) => args.includes('prune'))).toBe(false);
    },
  );

  it('keeps a locked missing worktree registered and reports why it could not be removed', async () => {
    const { repoPath, manager } = await fixture();
    const created = await manager.create({ agentId: 'agent-locked-gone', repoPath });
    await git(['-C', repoPath, 'worktree', 'lock', '--reason', 'offline media', created.path]);
    await rm(created.path, { recursive: true, force: true });

    await expect(manager.cleanup({ agentId: 'agent-locked-gone', repoPath })).rejects.toMatchObject(
      { code: 'remove_failed', message: expect.stringMatching(/locked/i) },
    );
    expect(await registeredWorktrees(repoPath)).toContain(await samePathKey(created.path));
  });

  it('retries temporary Windows access denial with exponential backoff', async () => {
    const { repoPath, worktreesRoot, manager } = await fixture();
    await manager.create({ agentId: 'agent-retry', repoPath });
    let removeAttempts = 0;
    const delays: number[] = [];
    const retrying = new WorkerWorktreeManager({
      worktreesRoot,
      platform: 'win32',
      delay: async (milliseconds) => void delays.push(milliseconds),
      execFileImpl: interceptWorktreeRemove(() => {
        removeAttempts += 1;
        if (removeAttempts < 3)
          throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
      }),
    });

    await expect(retrying.cleanup({ agentId: 'agent-retry', repoPath })).resolves.toEqual({
      outcome: 'removed',
    });
    expect(removeAttempts).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it('quarantines a clean Windows worktree while a lock on its files persists', async () => {
    const { repoPath, worktreesRoot, manager } = await fixture();
    const created = await manager.create({ agentId: 'agent-locked', repoPath });
    const locked = join(created.path, 'README.md');
    const delays: number[] = [];
    const retrying = new WorkerWorktreeManager({
      worktreesRoot,
      platform: 'win32',
      delay: async (milliseconds) => void delays.push(milliseconds),
      treeRemovalFs: failingRemovalFs((path) => path === locked, 'EBUSY'),
    });

    await expect(retrying.cleanup({ agentId: 'agent-locked', repoPath })).resolves.toEqual({
      outcome: 'quarantined',
    });
    expect(delays).toEqual([100, 200, 400, 800, 1_600, 3_200]);
    expect(await readFile(locked, 'utf8')).toBe('hello\n');
    // The files go before the registration, so the kept worktree is still registered.
    expect(await registeredWorktrees(repoPath)).toContain(await samePathKey(created.path));
  });

  it('keeps the registration while Git refuses to drop it, and a later cleanup finishes it', async () => {
    const { repoPath, worktreesRoot, manager } = await fixture();
    const created = await manager.create({ agentId: 'agent-unregister-locked', repoPath });
    const delays: number[] = [];
    const retrying = new WorkerWorktreeManager({
      worktreesRoot,
      platform: 'win32',
      delay: async (milliseconds) => void delays.push(milliseconds),
      execFileImpl: interceptWorktreeRemove(() => {
        throw Object.assign(new Error('Access is denied'), { code: 'EPERM' });
      }),
    });

    await expect(
      retrying.cleanup({ agentId: 'agent-unregister-locked', repoPath }),
    ).resolves.toEqual({ outcome: 'quarantined' });
    expect(delays).toEqual([100, 200, 400, 800, 1_600, 3_200]);
    await expect(stat(created.path)).rejects.toThrow();
    expect(await registeredWorktrees(repoPath)).toContain(await samePathKey(created.path));

    await expect(
      manager.cleanup({ agentId: 'agent-unregister-locked', repoPath }),
    ).resolves.toEqual({ outcome: 'removed' });
    expect(await registeredWorktrees(repoPath)).not.toContain(await samePathKey(created.path));
  });

  it('removes an unchanged worktree at its base and unregisters it', async () => {
    const { repoPath, manager } = await fixture();
    const created = await manager.create({ agentId: 'agent-unchanged', repoPath });

    await expect(
      manager.cleanupUnchanged({
        agentId: 'agent-unchanged',
        repoPath,
        baseHead: created.baseHead,
      }),
    ).resolves.toEqual({ outcome: 'removed' });

    await expect(stat(created.path)).rejects.toThrow();
    const listed = await git(['-C', repoPath, 'worktree', 'list', '--porcelain']);
    expect(listed.split('\n').filter((line) => line.startsWith('worktree '))).toHaveLength(1);
  });

  it('keeps a worktree whose HEAD moved past its base even when its status is clean', async () => {
    const { repoPath, manager } = await fixture();
    const created = await manager.create({ agentId: 'agent-moved', repoPath });
    await writeFile(join(created.path, 'README.md'), 'committed by worker\n');
    await git(['-C', created.path, 'add', 'README.md']);
    await git([
      '-C',
      created.path,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-q',
      '-m',
      'worker commit',
    ]);

    await expect(
      manager.cleanupUnchanged({
        agentId: 'agent-moved',
        repoPath,
        baseHead: created.baseHead,
      }),
    ).resolves.toEqual({ outcome: 'quarantined', changed: true });

    expect((await stat(created.path)).isDirectory()).toBe(true);
    expect((await git(['-C', created.path, 'rev-parse', 'HEAD'])).trim()).not.toBe(
      created.baseHead,
    );
  });

  it('tells whether a worktree changed from its base without removing it', async () => {
    const { repoPath, manager } = await fixture();
    const unchanged = await manager.create({ agentId: 'agent-read', repoPath });
    const check = (agentId: string) =>
      manager.hasChangesFromBase({ agentId, baseHead: unchanged.baseHead });

    await expect(check('agent-read')).resolves.toBe(false);
    expect((await stat(unchanged.path)).isDirectory()).toBe(true);

    const untracked = await manager.create({ agentId: 'agent-untracked', repoPath });
    await writeFile(join(untracked.path, 'new.txt'), 'untracked\n');
    await expect(check('agent-untracked')).resolves.toBe(true);

    const committed = await manager.create({ agentId: 'agent-committed', repoPath });
    await writeFile(join(committed.path, 'README.md'), 'committed by an earlier attempt\n');
    await git(['-C', committed.path, 'add', 'README.md']);
    await git([
      '-C',
      committed.path,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-q',
      '-m',
      'earlier attempt',
    ]);
    // A clean status after a commit still differs from the base.
    await expect(check('agent-committed')).resolves.toBe(true);
    expect((await stat(committed.path)).isDirectory()).toBe(true);

    await expect(check('agent-missing')).rejects.toMatchObject({ code: 'create_failed' });
  });

  it('keeps untracked files hidden by a repository status.showUntrackedFiles setting', async () => {
    const { repoPath, manager } = await fixture();
    await git(['-C', repoPath, 'config', 'status.showUntrackedFiles', 'no']);
    const created = await manager.create({ agentId: 'agent-hidden', repoPath });
    await writeFile(join(created.path, 'hidden.txt'), 'untracked\n');

    await expect(
      manager.cleanupUnchanged({
        agentId: 'agent-hidden',
        repoPath,
        baseHead: created.baseHead,
      }),
    ).resolves.toEqual({ outcome: 'quarantined', changed: true });

    expect(await readFile(join(created.path, 'hidden.txt'), 'utf8')).toBe('untracked\n');
  });

  it('removes ignored files together with an otherwise unchanged worktree', async () => {
    const { repoPath, manager } = await fixture();
    await writeFile(join(repoPath, '.gitignore'), 'build/\n');
    await git(['-C', repoPath, 'add', '.gitignore']);
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
      'ignore build',
    ]);
    const created = await manager.create({ agentId: 'agent-ignored', repoPath });
    await mkdir(join(created.path, 'build'));
    await writeFile(join(created.path, 'build', 'out.txt'), 'ignored\n');

    await expect(
      manager.cleanupUnchanged({
        agentId: 'agent-ignored',
        repoPath,
        baseHead: created.baseHead,
      }),
    ).resolves.toEqual({ outcome: 'removed' });
    await expect(stat(created.path)).rejects.toThrow();
  });

  it('keeps an unchanged Windows worktree quarantined while access denial persists', async () => {
    const { repoPath, worktreesRoot, manager } = await fixture();
    const created = await manager.create({ agentId: 'agent-unchanged-locked', repoPath });
    const delays: number[] = [];
    const retrying = new WorkerWorktreeManager({
      worktreesRoot,
      platform: 'win32',
      delay: async (milliseconds) => void delays.push(milliseconds),
      treeRemovalFs: failingRemovalFs((path) => path === created.path, 'EPERM'),
    });

    await expect(
      retrying.cleanupUnchanged({
        agentId: 'agent-unchanged-locked',
        repoPath,
        baseHead: created.baseHead,
      }),
    ).resolves.toEqual({ outcome: 'quarantined' });
    expect(delays).toEqual([100, 200, 400, 800, 1_600, 3_200]);
    expect((await stat(created.path)).isDirectory()).toBe(true);
    expect(await registeredWorktrees(repoPath)).toContain(await samePathKey(created.path));
  });

  it('discards a changed worktree with its commit and untracked files and unregisters it (issue #544)', async () => {
    const { repoPath, head, worktreesRoot } = await fixture();
    const commands: string[][] = [];
    const manager = new WorkerWorktreeManager({
      worktreesRoot,
      execFileImpl: async (file, args, options) => {
        commands.push([...args]);
        const result = await execFileAsync(file, [...args], {
          env: options.env,
          timeout: options.timeout,
        });
        return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
      },
    });
    const branchesBefore = await git(['-C', repoPath, 'branch', '--list']);
    const created = await manager.create({
      agentId: 'agent-discard',
      worktreeId: 'execution-discard-1',
      repoPath,
    });
    await writeFile(join(created.path, 'committed.txt'), 'committed by worker\n');
    await git(['-C', created.path, 'add', 'committed.txt']);
    await git([
      '-C',
      created.path,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-q',
      '-m',
      'worker commit',
    ]);
    await writeFile(join(created.path, 'README.md'), 'edited\n');
    await writeFile(join(created.path, 'untracked.txt'), 'untracked\n');
    // cleanup keeps changed work, which is why the retained worktree needs an explicit discard.
    await expect(
      manager.cleanup({ agentId: 'agent-discard', worktreeId: 'execution-discard-1', repoPath }),
    ).resolves.toEqual({ outcome: 'quarantined' });

    await expect(
      manager.discard({
        agentId: 'agent-discard',
        worktreeId: 'execution-discard-1',
        repoPath,
        path: created.path,
      }),
    ).resolves.toEqual({ outcome: 'removed' });

    await expect(stat(created.path)).rejects.toThrow();
    expect(await registeredWorktrees(repoPath)).not.toContain(await samePathKey(created.path));
    expect((await git(['-C', repoPath, 'rev-parse', 'HEAD'])).trim()).toBe(head);
    expect(await git(['-C', repoPath, 'status', '--porcelain'])).toBe('');
    expect(await git(['-C', repoPath, 'branch', '--list'])).toBe(branchesBefore);
    // Git only drops the registration: it never deletes the files, so it is never forced.
    expect(commands.some((args) => args.includes('worktree') && args.includes('remove'))).toBe(
      true,
    );
    expect(commands.some((args) => args.includes('--force'))).toBe(false);
    expect(commands.some((args) => args.includes('prune'))).toBe(false);
  });

  it('discards only its own missing worktree registration and keeps the user missing worktree', async () => {
    const { repoPath, worktreesRoot } = await fixture();
    const commands: string[][] = [];
    const manager = new WorkerWorktreeManager({
      worktreesRoot,
      execFileImpl: async (file, args, options) => {
        commands.push([...args]);
        const result = await execFileAsync(file, [...args], {
          env: options.env,
          timeout: options.timeout,
        });
        return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
      },
    });
    const created = await manager.create({ agentId: 'agent-discard-gone', repoPath });
    const userRoot = await mkdtemp(join(tmpdir(), 'sprint-coder-user-worktree-'));
    cleanupRoots.push(userRoot);
    const userWorktree = join(userRoot, 'on-unplugged-drive');
    await git(['-C', repoPath, 'worktree', 'add', '-q', '--detach', userWorktree]);
    await rm(created.path, { recursive: true, force: true });
    await rm(userWorktree, { recursive: true, force: true });

    await expect(
      manager.discard({ agentId: 'agent-discard-gone', repoPath, path: created.path }),
    ).resolves.toEqual({ outcome: 'removed' });

    const registered = await registeredWorktrees(repoPath);
    expect(registered).toContain(await samePathKey(userWorktree));
    expect(registered).not.toContain(await samePathKey(created.path));
    expect(commands.some((args) => args.includes('prune'))).toBe(false);
    // Nothing is registered there any more, so a second discard has nothing left to do.
    await expect(
      manager.discard({ agentId: 'agent-discard-gone', repoPath, path: created.path }),
    ).resolves.toEqual({ outcome: 'removed' });
  });

  it('refuses to discard a path it does not own, a path unlike its record, or a link', async () => {
    const { repoPath, manager } = await fixture();
    const created = await manager.create({ agentId: 'agent-owned', repoPath });
    await writeFile(join(created.path, 'kept.txt'), 'kept\n');
    const other = await manager.create({ agentId: 'agent-other', repoPath });

    for (const path of [repoPath, other.path, join(created.path, '..', 'worktree-elsewhere')])
      await expect(
        manager.discard({ agentId: 'agent-owned', repoPath, path }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await readFile(join(created.path, 'kept.txt'), 'utf8')).toBe('kept\n');
    expect((await stat(other.path)).isDirectory()).toBe(true);
    expect(await registeredWorktrees(repoPath)).toContain(await samePathKey(created.path));

    // A link standing in for the owned directory is refused, and its target is left alone.
    const linkedPath = manager.worktreePathFor('agent-linked');
    await symlink(repoPath, linkedPath, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(
      manager.discard({ agentId: 'agent-linked', repoPath, path: linkedPath }),
    ).rejects.toThrow('own directory');
    expect((await stat(join(repoPath, 'README.md'))).isFile()).toBe(true);
  });

  it('retries a discard through a temporary Windows lock on its files', async () => {
    const { repoPath, worktreesRoot, manager } = await fixture();
    const created = await manager.create({ agentId: 'agent-discard-retry', repoPath });
    const busy = join(created.path, 'change.txt');
    await writeFile(busy, 'changed\n');
    const delays: number[] = [];
    const retrying = new WorkerWorktreeManager({
      worktreesRoot,
      platform: 'win32',
      delay: async (milliseconds) => void delays.push(milliseconds),
      treeRemovalFs: failingRemovalFs((path) => path === busy, 'EBUSY', 2),
    });

    await expect(
      retrying.discard({ agentId: 'agent-discard-retry', repoPath, path: created.path }),
    ).resolves.toEqual({ outcome: 'removed' });
    expect(delays).toEqual([100, 200]);
    await expect(stat(created.path)).rejects.toThrow();
    expect(await registeredWorktrees(repoPath)).not.toContain(await samePathKey(created.path));
  });

  it('removes a directory tree without following a link into another folder (issue #544)', async () => {
    const outside = await outsideFolder();
    const root = await mkdtemp(join(tmpdir(), 'sprint-coder-tree-removal-'));
    cleanupRoots.push(root);
    await mkdir(join(root, 'nested', 'deeper'), { recursive: true });
    await writeFile(join(root, 'nested', 'deeper', 'own.txt'), 'own\n');
    await symlink(outside, join(root, 'linked-out'), DIRECTORY_LINK);
    await symlink(
      join(outside, 'sub'),
      join(root, 'nested', 'deeper', 'linked-sub'),
      DIRECTORY_LINK,
    );
    const readOnly = join(root, 'nested', 'read-only.txt');
    await writeFile(readOnly, 'read only\n');
    await chmod(readOnly, 0o444);

    await removeTreeWithoutFollowingLinks(root);

    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    await expectOutsideIntact(outside);
    // A missing tree is already removed, so a removal can simply run again.
    await expect(removeTreeWithoutFollowingLinks(root)).resolves.toBeUndefined();
  });

  it('removes a link by itself: rmdir when unlink refuses a directory link, never chmod or readdir through it', async () => {
    const root = join('tree-root');
    const link = join(root, 'link');
    const calls: string[] = [];
    const refuse = (path: string, code: string) => {
      throw Object.assign(new Error(`${code}: ${path}`), { code });
    };
    const fakeFs: TreeRemovalFs = {
      lstat: async (path) => ({
        isDirectory: () => path === root,
        isSymbolicLink: () => path === link,
      }),
      readdir: async (path) => {
        calls.push(`readdir ${path}`);
        return path === root ? ['link'] : ['behind-the-link.txt'];
      },
      unlink: async (path) => {
        calls.push(`unlink ${path}`);
        // Windows refuses to unlink some directory links; only rmdir removes them.
        refuse(path, 'EPERM');
      },
      rmdir: async (path) => {
        calls.push(`rmdir ${path}`);
      },
      chmod: async (path) => {
        // chmod follows a link, so it would change the folder the link points at.
        calls.push(`chmod ${path}`);
      },
    };

    await removeTreeWithoutFollowingLinks(root, fakeFs);

    expect(calls).toEqual([`readdir ${root}`, `unlink ${link}`, `rmdir ${link}`, `rmdir ${root}`]);
  });

  it('discards a worktree holding a directory link without touching what it points at (issue #544)', async () => {
    const { repoPath, manager } = await fixture();
    const outside = await outsideFolder();
    const created = await manager.create({ agentId: 'agent-discard-link', repoPath });
    await symlink(outside, join(created.path, 'junction-out'), DIRECTORY_LINK);
    await mkdir(join(created.path, 'work'));
    await symlink(join(outside, 'sub'), join(created.path, 'work', 'nested-link'), DIRECTORY_LINK);

    await expect(
      manager.discard({ agentId: 'agent-discard-link', repoPath, path: created.path }),
    ).resolves.toEqual({ outcome: 'removed' });

    await expect(lstat(created.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await registeredWorktrees(repoPath)).not.toContain(await samePathKey(created.path));
    await expectOutsideIntact(outside);
  });

  it('reclaims an unchanged worktree whose ignored link points outside, keeping the target (issue #544)', async () => {
    const { repoPath, manager } = await fixture();
    await writeFile(join(repoPath, '.gitignore'), 'linked/\n');
    await git(['-C', repoPath, 'add', '.gitignore']);
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
      'ignore linked',
    ]);
    const outside = await outsideFolder();
    const created = await manager.create({ agentId: 'agent-ignored-link', repoPath });
    await symlink(outside, join(created.path, 'linked'), DIRECTORY_LINK);
    expect(await git(['-C', created.path, 'status', '--porcelain', '--untracked-files=all'])).toBe(
      '',
    );

    await expect(
      manager.cleanupUnchanged({
        agentId: 'agent-ignored-link',
        repoPath,
        baseHead: created.baseHead,
      }),
    ).resolves.toEqual({ outcome: 'removed' });

    await expect(lstat(created.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await registeredWorktrees(repoPath)).not.toContain(await samePathKey(created.path));
    await expectOutsideIntact(outside);
  });

  it('keeps the rest and the registration when a discard stops part way, and finishes on the next one', async () => {
    const { repoPath, worktreesRoot, manager } = await fixture();
    const created = await manager.create({ agentId: 'agent-discard-partial', repoPath });
    await writeFile(join(created.path, 'a.txt'), 'first\n');
    const failing = join(created.path, 'b.txt');
    await writeFile(failing, 'second\n');
    const interrupted = new WorkerWorktreeManager({
      worktreesRoot,
      treeRemovalFs: failingRemovalFs((path) => path === failing, 'EIO', 1),
    });

    await expect(
      interrupted.discard({ agentId: 'agent-discard-partial', repoPath, path: created.path }),
    ).rejects.toMatchObject({ code: 'remove_failed' });
    expect(await readFile(failing, 'utf8')).toBe('second\n');
    // `.git` goes last, so what is left is still a worktree Git can read and unregister.
    expect((await git(['-C', created.path, 'rev-parse', 'HEAD'])).trim()).toBe(created.baseHead);
    expect(await registeredWorktrees(repoPath)).toContain(await samePathKey(created.path));

    await expect(
      manager.discard({ agentId: 'agent-discard-partial', repoPath, path: created.path }),
    ).resolves.toEqual({ outcome: 'removed' });
    await expect(lstat(created.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await registeredWorktrees(repoPath)).not.toContain(await samePathKey(created.path));
  });

  it('inspects a retained worktree without changing it', async () => {
    const { repoPath, manager } = await fixture();
    const created = await manager.create({ agentId: 'agent-inspect', repoPath });
    await writeFile(join(created.path, 'committed.txt'), 'committed by worker\n');
    await git(['-C', created.path, 'add', 'committed.txt']);
    await git([
      '-C',
      created.path,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-q',
      '-m',
      'worker commit',
    ]);
    await writeFile(join(created.path, 'README.md'), 'edited\n');
    await mkdir(join(created.path, 'nested'));
    await writeFile(join(created.path, 'nested', '日本語.txt'), 'untracked\n');
    const input = {
      agentId: 'agent-inspect',
      repoPath,
      path: created.path,
      baseHead: created.baseHead,
      limit: 500,
    };
    const statusBefore = await git(['-C', created.path, 'status', '--porcelain']);

    const inspection = await manager.inspectChanges(input);

    expect(inspection.head).not.toBe(created.baseHead);
    expect(inspection.commitsSinceBase).toBe(1);
    expect(inspection.status).toEqual([
      { code: ' M', path: 'README.md' },
      { code: '??', path: 'nested/日本語.txt' },
    ]);
    expect(inspection.statusTruncated).toBe(false);
    expect(inspection.changesFromBase).toEqual([
      { status: 'M', path: 'README.md' },
      { status: 'A', path: 'committed.txt' },
    ]);
    expect(inspection.changesFromBaseTruncated).toBe(false);
    expect(await git(['-C', created.path, 'status', '--porcelain'])).toBe(statusBefore);

    const cut = await manager.inspectChanges({ ...input, limit: 1 });
    expect(cut.status).toHaveLength(1);
    expect(cut.statusTruncated).toBe(true);
    expect(cut.changesFromBase).toHaveLength(1);
    expect(cut.changesFromBaseTruncated).toBe(true);

    const untouched = await manager.create({ agentId: 'agent-inspect-clean', repoPath });
    await expect(
      manager.inspectChanges({
        ...input,
        agentId: 'agent-inspect-clean',
        path: untouched.path,
      }),
    ).resolves.toMatchObject({
      head: untouched.baseHead,
      commitsSinceBase: 0,
      status: [],
      changesFromBase: [],
    });
    await expect(manager.inspectChanges({ ...input, path: repoPath })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('keeps a worktree whose submodule holds a Worker commit when cleaning up without review (issue #544)', async () => {
    const { repoPath, manager } = await fixture();
    const source = await submoduleSource();
    const created = await manager.create({ agentId: 'agent-submodule', repoPath });
    await git(['-C', created.path, ...SUBMODULE_CLONE, 'submodule', 'add', '-q', source, 'sub']);
    await git(['-C', created.path, ...TEST_IDENTITY, 'commit', '-q', '-m', 'add submodule']);
    const sub = join(created.path, 'sub');
    await writeFile(join(sub, 'worker.txt'), 'only here\n');
    await git(['-C', sub, 'add', 'worker.txt']);
    await git(['-C', sub, ...TEST_IDENTITY, 'commit', '-q', '-m', 'worker commit in submodule']);
    const workerCommit = (await git(['-C', sub, 'rev-parse', 'HEAD'])).trim();
    await git(['-C', created.path, 'add', 'sub']);
    await git(['-C', created.path, ...TEST_IDENTITY, 'commit', '-q', '-m', 'point at it']);
    // Status is clean: nothing but the submodule store holds the Worker's submodule commit.
    expect(await git(['-C', created.path, 'status', '--porcelain'])).toBe('');
    const modules = resolve(
      created.path,
      (await git(['-C', created.path, 'rev-parse', '--git-path', 'modules'])).trim(),
    );
    const gitDir = resolve(
      created.path,
      (await git(['-C', created.path, 'rev-parse', '--git-dir'])).trim(),
    );

    // The list reads the same test, so the discard confirmation can warn about the submodule.
    await expect(
      manager.hasSubmodules({ agentId: 'agent-submodule', repoPath, path: created.path }),
    ).resolves.toBe(true);
    const plain = await manager.create({ agentId: 'agent-no-submodule', repoPath });
    await expect(
      manager.hasSubmodules({ agentId: 'agent-no-submodule', repoPath, path: plain.path }),
    ).resolves.toBe(false);
    // A worktree it cannot read counts as holding one, so the user is warned, not reassured.
    await expect(
      manager.hasSubmodules({ agentId: 'agent-no-submodule', repoPath, path: repoPath }),
    ).resolves.toBe(true);

    await expect(manager.cleanup({ agentId: 'agent-submodule', repoPath })).resolves.toEqual({
      outcome: 'quarantined',
    });
    expect((await stat(modules)).isDirectory()).toBe(true);
    expect((await git(['-C', sub, 'cat-file', '-t', workerCommit])).trim()).toBe('commit');
    expect(await readFile(join(sub, 'worker.txt'), 'utf8')).toBe('only here\n');
    expect(await registeredWorktrees(repoPath)).toContain(await samePathKey(created.path));

    // A discard the user confirmed removes it, submodule store and all.
    await expect(
      manager.discard({ agentId: 'agent-submodule', repoPath, path: created.path }),
    ).resolves.toEqual({ outcome: 'removed' });
    await expect(lstat(created.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(gitDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await registeredWorktrees(repoPath)).not.toContain(await samePathKey(created.path));
  });

  it('keeps an unchanged worktree with an initialized submodule, whose store status cannot vouch for (issue #544)', async () => {
    const { repoPath, manager } = await fixture();
    const source = await submoduleSource();
    await git(['-C', repoPath, ...SUBMODULE_CLONE, 'submodule', 'add', '-q', source, 'sub']);
    await git(['-C', repoPath, ...TEST_IDENTITY, 'commit', '-q', '-m', 'add submodule']);
    const created = await manager.create({ agentId: 'agent-submodule-unchanged', repoPath });
    await git(['-C', created.path, ...SUBMODULE_CLONE, 'submodule', 'update', '--init', '-q']);
    const sub = join(created.path, 'sub');
    const recorded = (await git(['-C', sub, 'rev-parse', 'HEAD'])).trim();
    await git(['-C', sub, 'checkout', '-q', '-b', 'worker']);
    await git(['-C', sub, ...TEST_IDENTITY, 'commit', '-q', '--allow-empty', '-m', 'worker']);
    const workerCommit = (await git(['-C', sub, 'rev-parse', 'HEAD'])).trim();
    await git(['-C', sub, 'checkout', '-q', '--detach', recorded]);
    expect(
      await git([
        '-C',
        created.path,
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--ignore-submodules=none',
      ]),
    ).toBe('');

    await expect(
      manager.cleanupUnchanged({
        agentId: 'agent-submodule-unchanged',
        repoPath,
        baseHead: created.baseHead,
      }),
    ).resolves.toEqual({ outcome: 'quarantined', changed: true });
    expect((await git(['-C', sub, 'rev-parse', 'worker'])).trim()).toBe(workerCommit);
    expect(await registeredWorktrees(repoPath)).toContain(await samePathKey(created.path));
  });

  it('keeps a worktree when only its submodule store, or only a filled gitlink, holds Worker work (issue #544)', async () => {
    const { repoPath, manager } = await fixture();
    const source = await submoduleSource();
    const cleanStatus = async (path: string) =>
      expect(await git(['-C', path, 'status', '--porcelain'])).toBe('');

    // A repository embedded as a gitlink keeps its own `.git`; there is no submodule store.
    const embedded = await manager.create({ agentId: 'agent-embedded', repoPath });
    const embeddedSub = join(embedded.path, 'sub');
    await git(['-C', embedded.path, ...SUBMODULE_CLONE, 'clone', '-q', source, 'sub']);
    await git(['-C', embeddedSub, ...TEST_IDENTITY, 'commit', '-q', '--allow-empty', '-m', 'w']);
    const embeddedCommit = (await git(['-C', embeddedSub, 'rev-parse', 'HEAD'])).trim();
    await git(['-C', embedded.path, 'add', 'sub']);
    await git(['-C', embedded.path, ...TEST_IDENTITY, 'commit', '-q', '-m', 'embed']);
    await cleanStatus(embedded.path);
    const embeddedModules = resolve(
      embedded.path,
      (await git(['-C', embedded.path, 'rev-parse', '--git-path', 'modules'])).trim(),
    );
    await expect(lstat(embeddedModules)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(manager.cleanup({ agentId: 'agent-embedded', repoPath })).resolves.toEqual({
      outcome: 'quarantined',
    });
    expect((await git(['-C', embeddedSub, 'cat-file', '-t', embeddedCommit])).trim()).toBe(
      'commit',
    );

    // A deinitialized submodule leaves an empty directory, and its commits only in the store.
    const deinited = await manager.create({ agentId: 'agent-deinit', repoPath });
    const deinitedSub = join(deinited.path, 'sub');
    await git(['-C', deinited.path, ...SUBMODULE_CLONE, 'submodule', 'add', '-q', source, 'sub']);
    await git(['-C', deinitedSub, ...TEST_IDENTITY, 'commit', '-q', '--allow-empty', '-m', 'w']);
    const storedCommit = (await git(['-C', deinitedSub, 'rev-parse', 'HEAD'])).trim();
    await git(['-C', deinited.path, 'add', 'sub']);
    await git(['-C', deinited.path, ...TEST_IDENTITY, 'commit', '-q', '-m', 'point at it']);
    await git(['-C', deinited.path, 'submodule', 'deinit', '-q', '-f', 'sub']);
    expect(await readdir(deinitedSub)).toEqual([]);
    await cleanStatus(deinited.path);
    const store = join(
      resolve(
        deinited.path,
        (await git(['-C', deinited.path, 'rev-parse', '--git-path', 'modules'])).trim(),
      ),
      'sub',
    );
    await expect(manager.cleanup({ agentId: 'agent-deinit', repoPath })).resolves.toEqual({
      outcome: 'quarantined',
    });
    expect((await git(['--git-dir', store, 'cat-file', '-t', storedCommit])).trim()).toBe('commit');
  });

  it('keeps a worktree Git holds locked when cleaning up, and refuses to discard it (issue #544)', async () => {
    const { repoPath, manager } = await fixture();
    const created = await manager.create({ agentId: 'agent-git-locked', repoPath });
    await git(['-C', repoPath, 'worktree', 'lock', '--reason', 'kept by the user', created.path]);

    await expect(manager.cleanup({ agentId: 'agent-git-locked', repoPath })).resolves.toEqual({
      outcome: 'quarantined',
    });
    // Unlocking may let it qualify later, so it is not reported as changed.
    await expect(
      manager.cleanupUnchanged({
        agentId: 'agent-git-locked',
        repoPath,
        baseHead: created.baseHead,
      }),
    ).resolves.toEqual({ outcome: 'quarantined' });
    await expect(
      manager.discard({ agentId: 'agent-git-locked', repoPath, path: created.path }),
    ).rejects.toMatchObject({ code: 'locked' });
    expect(await readFile(join(created.path, 'README.md'), 'utf8')).toBe('hello\n');

    // The lock is read from the repository, so it holds even once the worktree's `.git` is gone.
    await rm(join(created.path, '.git'));
    await expect(
      manager.discard({ agentId: 'agent-git-locked', repoPath, path: created.path }),
    ).rejects.toMatchObject({ code: 'locked' });
    expect(await readFile(join(created.path, 'README.md'), 'utf8')).toBe('hello\n');
    expect(await registeredWorktrees(repoPath)).toContain(await samePathKey(created.path));

    await git(['-C', repoPath, 'worktree', 'unlock', created.path]);
    await expect(
      manager.discard({ agentId: 'agent-git-locked', repoPath, path: created.path }),
    ).resolves.toEqual({ outcome: 'removed' });
    expect(await registeredWorktrees(repoPath)).not.toContain(await samePathKey(created.path));
  });

  it('reads long change lists with a wide buffer and refuses one past it as too large', async () => {
    const { repoPath, worktreesRoot, manager } = await fixture();
    const created = await manager.create({ agentId: 'agent-inspect-large', repoPath });
    const buffers: Array<{ args: readonly string[]; maxBuffer: number | undefined }> = [];
    let overflow = false;
    const inspecting = new WorkerWorktreeManager({
      worktreesRoot,
      execFileImpl: async (file, args, options) => {
        buffers.push({ args, maxBuffer: options.maxBuffer });
        if (overflow && args.includes('status'))
          throw Object.assign(new Error('stdout maxBuffer length exceeded'), {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          });
        const result = await execFileAsync(file, [...args], {
          env: options.env,
          timeout: options.timeout,
          ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
        });
        return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
      },
    });
    const input = {
      agentId: 'agent-inspect-large',
      repoPath,
      path: created.path,
      baseHead: created.baseHead,
      limit: 500,
    };

    await inspecting.inspectChanges(input);
    for (const listing of ['status', 'diff'])
      expect(
        buffers.find(({ args }) => args.includes(listing) && !args.includes('--list'))?.maxBuffer,
      ).toBeGreaterThanOrEqual(32 * 1024 * 1024);

    overflow = true;
    await expect(inspecting.inspectChanges(input)).rejects.toMatchObject({ code: 'too_large' });
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
    await writeFile(join(repoPath, 'after-integration.txt'), 'later parent commit\n');
    await git(['-C', repoPath, 'add', 'after-integration.txt']);
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
      'later unrelated commit',
    ]);
    const laterHead = (await git(['-C', repoPath, 'rev-parse', 'HEAD'])).trim();

    const recovered = await manager.integrate({
      repoPath,
      baseHead: head,
      workerHead: finalized.workerHead,
    });

    expect(first.outcome).toBe('integrated');
    expect(laterHead).not.toBe(first.integratedHead);
    expect(recovered).toEqual({
      integratedHead: first.integratedHead,
      outcome: 'already_integrated',
    });
    await expect(
      manager.revalidateIntegration({
        repoPath,
        baseHead: head,
        workerHead: finalized.workerHead,
        integratedHead: recovered.integratedHead,
      }),
    ).resolves.toMatchObject({ outcome: 'already_integrated' });
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

  it('does not mistake the same replacement at a different location for the Worker change', async () => {
    const { repoPath, manager } = await fixture();
    const lines = ['foo', '2', '3', '4', '5', '6', '7', '8', '9', 'foo'];
    await writeFile(join(repoPath, 'duplicates.txt'), `${lines.join('\n')}\n`);
    await git(['-C', repoPath, 'add', 'duplicates.txt']);
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
      'duplicate lines base',
    ]);
    const baseHead = (await git(['-C', repoPath, 'rev-parse', 'HEAD'])).trim();
    const worker = await manager.create({
      agentId: 'duplicate-location',
      worktreeId: 'duplicate-location',
      repoPath,
      baseRef: baseHead,
    });
    await writeFile(
      join(worker.path, 'duplicates.txt'),
      `${['bar', ...lines.slice(1)].join('\n')}\n`,
    );
    const finalized = await manager.finalizeChanges({
      agentId: 'duplicate-location',
      worktreeId: 'duplicate-location',
      repoPath,
      baseHead,
      commitMessage: 'change first duplicate',
    });
    await writeFile(
      join(repoPath, 'duplicates.txt'),
      `${[...lines.slice(0, -1), 'bar'].join('\n')}\n`,
    );
    await git(['-C', repoPath, 'add', 'duplicates.txt']);
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
      'change second duplicate',
    ]);

    await expect(
      manager.integrate({
        repoPath,
        baseHead,
        workerHead: finalized.workerHead,
      }),
    ).resolves.toMatchObject({ outcome: 'integrated' });
    expect(await readFile(join(repoPath, 'duplicates.txt'), 'utf8')).toBe(
      `${['bar', ...lines.slice(1, -1), 'bar'].join('\n')}\n`,
    );
    expect((await git(['-C', repoPath, 'rev-list', '--count', `${baseHead}..HEAD`])).trim()).toBe(
      '2',
    );
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

  /** A separate local repository with one commit, to add as a submodule. */
  async function submoduleSource(): Promise<string> {
    const { repoPath } = await makeRepo();
    cleanupRoots.push(repoPath);
    return repoPath;
  }

  /** A folder outside every worktree, with a file at its top and one below. */
  async function outsideFolder(): Promise<string> {
    const outside = await mkdtemp(join(tmpdir(), 'sprint-coder-outside-'));
    cleanupRoots.push(outside);
    await mkdir(join(outside, 'sub'));
    await writeFile(join(outside, 'precious.txt'), 'precious\n');
    await writeFile(join(outside, 'sub', 'deep.txt'), 'deep\n');
    return outside;
  }

  async function expectOutsideIntact(outside: string): Promise<void> {
    expect(await readFile(join(outside, 'precious.txt'), 'utf8')).toBe('precious\n');
    expect(await readFile(join(outside, 'sub', 'deep.txt'), 'utf8')).toBe('deep\n');
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

/**
 * A registration may point at a directory that no longer exists, so compare through the real path
 * of its (existing) parent: macOS temp paths are symlinks (/var -> /private/var) and Git records
 * the real one. Git prints forward slashes on Windows, where paths are also case-insensitive.
 */
async function samePathKey(path: string): Promise<string> {
  const real = join(await realpath(dirname(path)), basename(path));
  return process.platform === 'win32' ? real.toLocaleLowerCase('en-US') : real;
}

async function registeredWorktrees(repoPath: string): Promise<string[]> {
  const listed = await git(['-C', repoPath, 'worktree', 'list', '--porcelain']);
  return Promise.all(
    listed
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => samePathKey(line.slice('worktree '.length))),
  );
}

function isGitAvailable(): boolean {
  try {
    const result = spawnSync('git', ['--version']);
    return result.error === undefined && result.status === 0;
  } catch {
    return false;
  }
}

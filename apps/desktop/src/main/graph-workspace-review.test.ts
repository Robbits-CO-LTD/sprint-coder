import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstatSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerWorktreeManager } from './worker-worktree';
import { loadNativeSafeFs, prepareNativeSafeFsLockDirectory } from './native-safe-fs';
import { reviewGraphWorkspace } from './graph-workspace-review';
import type { SealedPostImageObserver } from './persistence';

const exec = promisify(execFile);
// Measured mainpc wall time for the three-observation binary/rename case is 25.4 seconds.
const nativeReviewTimeout = process.platform === 'win32' ? 60_000 : 20_000;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })),
  );
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'graph-workspace-review-')));
  roots.push(root);
  const repoPath = join(root, 'repository');
  await exec('git', ['init', '-q', repoPath]);
  await writeFile(join(repoPath, 'tracked.txt'), 'base');
  await exec('git', ['-C', repoPath, 'add', 'tracked.txt']);
  await exec('git', [
    '-C',
    repoPath,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-qm',
    'base',
  ]);
  const manager = new WorkerWorktreeManager({ worktreesRoot: join(root, 'worktrees') });
  const input = {
    agentId: 'worker-a',
    worktreeId: 'execution-a',
    repoPath,
    ...(await manager.create({ agentId: 'worker-a', worktreeId: 'execution-a', repoPath })),
  };
  const boundary = loadNativeSafeFs({
    lockDirectoryPath: await prepareNativeSafeFsLockDirectory(root),
  });
  const observer: SealedPostImageObserver = (binding) => {
    const identity = lstatSync(binding.workspacePath, { bigint: true });
    const session = boundary.openReadSession({
      ...binding,
      rootDev: String(identity.dev),
      rootIno: String(identity.ino),
    });
    return {
      rootIdentityDigest: session.rootIdentityDigest,
      observe: (segments) => boundary.observeSealedPostImage(session, segments),
      close: () => boundary.closeReadSession(session),
    };
  };
  return {
    manager,
    input,
    observer,
    root,
    review: () => reviewGraphWorkspace(manager, input, observer),
  };
}

it(
  'binds tracked, renamed, deleted and untracked binary bytes without staging or committing',
  async () => {
    const f = await fixture();
    await rename(join(f.input.path, 'tracked.txt'), join(f.input.path, 'renamed.txt'));
    await writeFile(join(f.input.path, 'binary.dat'), Buffer.from([0, 255, 1]));
    const first = await f.review();
    expect(first.changedFiles).toEqual(['binary.dat', 'renamed.txt', 'tracked.txt']);
    expect((await f.review()).digest).toBe(first.digest);
    await writeFile(join(f.input.path, 'binary.dat'), Buffer.from([0, 255, 2]));
    expect((await f.review()).digest).not.toBe(first.digest);
    expect((await exec('git', ['-C', f.input.path, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(
      f.input.baseHead,
    );
    expect(
      (await exec('git', ['-C', f.input.path, 'diff', '--cached', '--name-only'])).stdout,
    ).toBe('');
  },
  nativeReviewTimeout,
);

it(
  'binds index staging independently from unchanged working bytes',
  async () => {
    const f = await fixture();
    await writeFile(join(f.input.path, 'tracked.txt'), 'changed');
    const first = await f.review();
    await exec('git', ['-C', f.input.path, 'add', 'tracked.txt']);
    expect((await f.review()).digest).not.toBe(first.digest);
  },
  nativeReviewTimeout,
);

it(
  'refuses missing native observation and cross-owner or cross-repository worktrees',
  async () => {
    const f = await fixture();
    await expect(reviewGraphWorkspace(f.manager, f.input, () => null)).rejects.toThrow(
      'unavailable',
    );
    await expect(
      reviewGraphWorkspace(f.manager, { ...f.input, worktreeId: 'other' }, f.observer),
    ).rejects.toThrow('owner');
    const other = join(f.root, 'other-repository');
    await exec('git', ['init', '-q', other]);
    await expect(
      reviewGraphWorkspace(f.manager, { ...f.input, repoPath: other }, f.observer),
    ).rejects.toThrow('another repository');
  },
  nativeReviewTimeout,
);

it(
  'rejects a symlink type change through the descriptor-relative observation',
  async () => {
    const f = await fixture();
    await rm(join(f.input.path, 'tracked.txt'));
    await symlink(join(f.input.repoPath, 'tracked.txt'), join(f.input.path, 'tracked.txt'));
    await expect(f.review()).rejects.toThrow();
  },
  nativeReviewTimeout,
);

it(
  'rejects bytes changed between inventory and verification observations',
  async () => {
    const f = await fixture();
    await writeFile(join(f.input.path, 'tracked.txt'), 'first');
    let observations = 0;
    const observer: SealedPostImageObserver = (root) => {
      const session = f.observer(root)!;
      return {
        ...session,
        observe: (path) => {
          const image = session.observe(path);
          if (path[0] === 'tracked.txt' && ++observations === 2 && image.kind === 'file')
            return { ...image, contentHash: 'f'.repeat(64) };
          return image;
        },
      };
    };
    await expect(reviewGraphWorkspace(f.manager, f.input, observer)).rejects.toThrow(
      'changed during review',
    );
  },
  nativeReviewTimeout,
);

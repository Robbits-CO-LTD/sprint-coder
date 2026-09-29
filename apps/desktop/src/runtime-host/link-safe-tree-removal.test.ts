import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { removeTreeWithoutFollowingLinks } from '../main/worker-worktree';
import {
  removeTreeWithoutFollowingLinksSync,
  type SyncTreeRemovalFs,
} from './link-safe-tree-removal';

// Only synthetic folders under a per-test root are touched. The root itself is removed with Main's
// independent link-safe removal, so a failure here cannot reach past a link either.
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeTreeWithoutFollowingLinks(root);
});

function testRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sprint-coder-link-safe-removal-test-'));
  roots.push(root);
  return root;
}

/** A folder outside the removed tree, with a file whose survival each test checks. */
function outsideTarget(root: string): string {
  const outside = join(root, 'outside');
  mkdirSync(join(outside, 'nested'), { recursive: true });
  writeFileSync(join(outside, 'keep.txt'), 'keep');
  writeFileSync(join(outside, 'nested', 'keep.txt'), 'nested keep');
  return outside;
}

function expectOutsideUntouched(outside: string): void {
  expect(readdirSync(outside).sort()).toEqual(['keep.txt', 'nested']);
  expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
  expect(readFileSync(join(outside, 'nested', 'keep.txt'), 'utf8')).toBe('nested keep');
}

// Electron's Node follows a Windows junction in a recursive rmSync (#582); POSIX has no junction.
const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';

function codedError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/**
 * A junction at `link` to `target` spelled as `\\?\Volume{GUID}\...`, which an account without
 * administrator rights can create and `lstat` does not report as a link. False when it cannot be.
 */
function createVolumeGuidJunction(link: string, target: string): boolean {
  const resolvedTarget = realpathSync.native(target);
  try {
    const volume = execFileSync('mountvol', [parse(resolvedTarget).root, '/L'], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    const volumeTarget = volume + resolvedTarget.slice(parse(resolvedTarget).root.length);
    execFileSync('cmd', ['/d', '/c', 'mklink', '/J', link, volumeTarget], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/** `rmdir` removes a junction itself, never what it points at. */
function removeJunctionItself(link: string): void {
  try {
    rmdirSync(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function recordingFs(overrides: Partial<SyncTreeRemovalFs> = {}) {
  const calls: string[] = [];
  const fs: SyncTreeRemovalFs = {
    lstat: (path) => lstatSync(path),
    readdir: (path) => {
      calls.push(`readdir ${path}`);
      return readdirSync(path);
    },
    realpath: (path) => realpathSync.native(path),
    unlink: vi.fn(),
    rmdir: vi.fn(),
    chmod: vi.fn(),
    ...overrides,
  };
  return { fs, calls };
}

describe('removeTreeWithoutFollowingLinksSync', () => {
  it('removes files and empty or non-empty folders, and nothing beside the root', () => {
    const root = testRoot();
    const target = join(root, 'turn');
    mkdirSync(join(target, 'empty'), { recursive: true });
    mkdirSync(join(target, 'full', 'deeper'), { recursive: true });
    writeFileSync(join(target, 'file.txt'), 'x');
    writeFileSync(join(target, 'full', 'deeper', 'file.txt'), 'x');
    writeFileSync(join(root, 'sibling.txt'), 'sibling');

    removeTreeWithoutFollowingLinksSync(target);

    expect(existsSync(target)).toBe(false);
    expect(readdirSync(root)).toEqual(['sibling.txt']);
  });

  it('removes a directory link or junction itself and leaves what it points at', () => {
    const root = testRoot();
    const outside = outsideTarget(root);
    const target = join(root, 'turn');
    mkdirSync(join(target, 'home', '.grok'), { recursive: true });
    symlinkSync(outside, join(target, 'linked'), directoryLinkType);
    symlinkSync(outside, join(target, 'home', '.grok', 'linked'), directoryLinkType);

    removeTreeWithoutFollowingLinksSync(target);

    expect(existsSync(target)).toBe(false);
    expectOutsideUntouched(outside);
  });

  it('removes only the link when the root itself is a link', () => {
    const root = testRoot();
    const outside = outsideTarget(root);
    const link = join(root, 'turn');
    symlinkSync(outside, link, directoryLinkType);

    removeTreeWithoutFollowingLinksSync(link);

    expect(existsSync(link)).toBe(false);
    expectOutsideUntouched(outside);
  });

  it('removes a file symbolic link and leaves its target', (context) => {
    const root = testRoot();
    const outside = outsideTarget(root);
    const target = join(root, 'turn');
    mkdirSync(target);
    try {
      symlinkSync(join(outside, 'keep.txt'), join(target, 'linked.txt'), 'file');
    } catch (error) {
      // Windows only lets an elevated or developer-mode account create a file symbolic link.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return context.skip();
      throw error;
    }

    removeTreeWithoutFollowingLinksSync(target);

    expect(existsSync(target)).toBe(false);
    expectOutsideUntouched(outside);
  });

  it('removes a link whose target is already gone', () => {
    const root = testRoot();
    const target = join(root, 'turn');
    mkdirSync(target);
    const vanished = join(root, 'vanished');
    mkdirSync(vanished);
    symlinkSync(vanished, join(target, 'dangling'), directoryLinkType);
    removeTreeWithoutFollowingLinksSync(vanished);

    removeTreeWithoutFollowingLinksSync(target);

    expect(readdirSync(root)).toEqual([]);
  });

  it('treats a missing root as removed and is safe to run twice', () => {
    const root = testRoot();
    const target = join(root, 'turn');
    mkdirSync(target);
    writeFileSync(join(target, 'file.txt'), 'x');

    removeTreeWithoutFollowingLinksSync(target);
    removeTreeWithoutFollowingLinksSync(target);
    removeTreeWithoutFollowingLinksSync(join(root, 'never-created'));

    expect(readdirSync(root)).toEqual([]);
  });

  it('clears a read-only attribute before removing a file', () => {
    const root = testRoot();
    const target = join(root, 'turn');
    mkdirSync(target);
    const file = join(target, 'read-only.txt');
    writeFileSync(file, 'x');
    chmodSync(file, 0o444);

    removeTreeWithoutFollowingLinksSync(target);

    expect(existsSync(target)).toBe(false);
  });

  it('treats a directory that resolves elsewhere as a link and never reads it', () => {
    const root = testRoot();
    const outside = outsideTarget(root);
    const target = join(root, 'turn');
    const disguised = join(target, 'disguised');
    mkdirSync(disguised, { recursive: true });
    writeFileSync(join(disguised, 'inside.txt'), 'x');
    // What a junction to a `\\?\Volume{GUID}\` path looks like: lstat reports a directory.
    const { fs, calls } = recordingFs({
      realpath: (path) => (path === disguised ? outside : realpathSync.native(path)),
    });

    removeTreeWithoutFollowingLinksSync(target, fs);

    expect(calls).toEqual([`readdir ${target}`]);
    expect(fs.unlink).toHaveBeenCalledWith(disguised);
    expect(fs.unlink).not.toHaveBeenCalledWith(join(disguised, 'inside.txt'));
    expect(fs.rmdir).toHaveBeenCalledTimes(1);
    expect(fs.rmdir).toHaveBeenCalledWith(target);
  });

  it('removes only the root itself when the root resolves elsewhere', () => {
    const root = testRoot();
    const outside = outsideTarget(root);
    const target = join(root, 'turn');
    mkdirSync(target);
    const { fs, calls } = recordingFs({
      realpath: (path) => (path === target ? outside : realpathSync.native(path)),
    });

    removeTreeWithoutFollowingLinksSync(target, fs);

    expect(calls).toEqual([]);
    expect(fs.unlink).toHaveBeenCalledWith(target);
    expect(fs.rmdir).not.toHaveBeenCalled();
  });

  it('stops without reading a directory whose location cannot be resolved', () => {
    const root = testRoot();
    const target = join(root, 'turn');
    mkdirSync(join(target, 'folder'), { recursive: true });
    const denied = codedError('EACCES');
    const { fs, calls } = recordingFs({
      realpath: (path) => {
        if (path === join(target, 'folder')) throw denied;
        return realpathSync.native(path);
      },
    });

    expect(() => removeTreeWithoutFollowingLinksSync(target, fs)).toThrow(denied);

    expect(calls).toEqual([`readdir ${target}`]);
    expect(fs.unlink).not.toHaveBeenCalled();
    expect(fs.rmdir).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'win32')(
    'removes a junction to a volume GUID path itself and leaves what it points at',
    (context) => {
      const root = testRoot();
      const outside = outsideTarget(root);
      const target = join(root, 'turn');
      mkdirSync(target);
      const link = join(target, 'linked');
      if (!createVolumeGuidJunction(link, outside)) return context.skip();
      try {
        removeTreeWithoutFollowingLinksSync(target);

        expect(existsSync(target)).toBe(false);
        expectOutsideUntouched(outside);
      } finally {
        // Main's removal below does not recognize this junction either; take it out by itself.
        removeJunctionItself(link);
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'removes a volume GUID junction whose target is gone, and the root with it',
    (context) => {
      const root = testRoot();
      const gone = join(root, 'gone');
      mkdirSync(gone);
      const target = join(root, 'turn');
      mkdirSync(target);
      const link = join(target, 'linked');
      if (!createVolumeGuidJunction(link, gone)) return context.skip();
      rmdirSync(gone);
      try {
        removeTreeWithoutFollowingLinksSync(target);

        expect(existsSync(target)).toBe(false);
      } finally {
        removeJunctionItself(link);
      }
    },
  );

  it('removes a listed entry that lstat cannot find with rmdir, then the root', () => {
    const root = testRoot();
    const target = join(root, 'turn');
    const dangling = join(target, 'dangling');
    mkdirSync(dangling, { recursive: true });
    const rmdir = vi.fn((path: string) => rmdirSync(path));
    // What a junction whose `\\?\Volume{GUID}\` target is gone looks like: lstat follows it.
    const { fs } = recordingFs({
      lstat: (path) => {
        if (path === dangling) throw codedError('ENOENT');
        return lstatSync(path);
      },
      rmdir,
    });

    removeTreeWithoutFollowingLinksSync(target, fs);

    expect(rmdir.mock.calls).toEqual([[dangling], [target]]);
    expect(existsSync(target)).toBe(false);
  });

  it('does not touch a root that is already gone', () => {
    const root = testRoot();
    const { fs } = recordingFs();

    removeTreeWithoutFollowingLinksSync(join(root, 'never-created'), fs);

    expect(fs.rmdir).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it('never descends into a link even when unlinking it is refused', () => {
    const root = testRoot();
    const outside = outsideTarget(root);
    const target = join(root, 'turn');
    mkdirSync(target);
    const link = join(target, 'linked');
    symlinkSync(outside, link, directoryLinkType);
    const { fs, calls } = recordingFs({
      unlink: vi.fn(() => {
        throw codedError('EPERM');
      }),
    });

    removeTreeWithoutFollowingLinksSync(target, fs);

    expect(fs.rmdir).toHaveBeenCalledWith(link);
    expect(fs.rmdir).toHaveBeenLastCalledWith(target);
    expect(calls).toEqual([`readdir ${target}`]);
    expectOutsideUntouched(outside);
  });

  it('stops at the first error without a fallback and keeps what remains', () => {
    const root = testRoot();
    const target = join(root, 'turn');
    mkdirSync(join(target, 'folder'), { recursive: true });
    writeFileSync(join(target, 'folder', 'locked.txt'), 'x');
    const busy = codedError('EBUSY');
    const { fs } = recordingFs({
      unlink: vi.fn(() => {
        throw busy;
      }),
    });

    expect(() => removeTreeWithoutFollowingLinksSync(target, fs)).toThrow(busy);

    expect(fs.rmdir).not.toHaveBeenCalled();
    expect(fs.chmod).not.toHaveBeenCalled();
    expect(readFileSync(join(target, 'folder', 'locked.txt'), 'utf8')).toBe('x');
  });

  it('stops without removing anything when an entry cannot be examined', () => {
    const root = testRoot();
    const target = join(root, 'turn');
    mkdirSync(target);
    writeFileSync(join(target, 'file.txt'), 'x');
    const denied = codedError('EACCES');
    const { fs } = recordingFs({
      lstat: (path) => {
        if (path !== target) throw denied;
        return lstatSync(path);
      },
    });

    expect(() => removeTreeWithoutFollowingLinksSync(target, fs)).toThrow(denied);

    expect(fs.unlink).not.toHaveBeenCalled();
    expect(fs.rmdir).not.toHaveBeenCalled();
    expect(readdirSync(target)).toEqual(['file.txt']);
  });

  it('counts an entry that disappears during the removal as removed', () => {
    const root = testRoot();
    const target = join(root, 'turn');
    mkdirSync(target);
    writeFileSync(join(target, 'file.txt'), 'x');
    const { fs } = recordingFs({
      unlink: vi.fn(() => {
        throw codedError('ENOENT');
      }),
    });

    expect(() => removeTreeWithoutFollowingLinksSync(target, fs)).not.toThrow();
    expect(fs.rmdir).toHaveBeenCalledWith(target);
  });
});

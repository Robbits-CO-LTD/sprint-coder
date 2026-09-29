import { chmodSync, lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The file system calls `removeTreeWithoutFollowingLinksSync` makes. Tests replace them to make a
 * removal fail part way, independently of how a Node version's own recursive removal behaves.
 */
export type SyncTreeRemovalFs = Readonly<{
  lstat(path: string): Readonly<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
  readdir(path: string): string[];
  unlink(path: string): void;
  rmdir(path: string): void;
  chmod(path: string, mode: number): void;
}>;

const nodeSyncTreeRemovalFs: SyncTreeRemovalFs = Object.freeze({
  lstat: (path: string) => lstatSync(path),
  readdir: (path: string) => readdirSync(path),
  unlink: (path: string) => unlinkSync(path),
  rmdir: (path: string) => rmdirSync(path),
  chmod: (path: string, mode: number) => chmodSync(path, mode),
});

/**
 * Delete a Turn's own temporary `root` and everything below it without ever following a link
 * (issue #582). The synchronous counterpart of `removeTreeWithoutFollowingLinks` in
 * `main/worker-worktree.ts`: cleanup also runs from a process `exit` handler, where nothing
 * asynchronous completes. In the Node that Electron ships, a recursive `rmSync` empties the folder
 * behind a Windows directory junction, so it must not be used on a folder a CLI could write to.
 *
 * Every entry is examined with `lstat`: a link, including a junction (which `lstat` reports as a
 * link and not a directory), is removed by itself and what it points at is left alone. Only a real
 * directory is descended into. An entry that is already gone counts as removed, so a removal that
 * stopped part way can simply run again. Any other error stops the removal and reaches the caller
 * unchanged; there is no fallback to a recursive removal.
 */
export function removeTreeWithoutFollowingLinksSync(
  root: string,
  fs: SyncTreeRemovalFs = nodeSyncTreeRemovalFs,
): void {
  removeEntry(root, fs);
}

function removeEntry(path: string, fs: SyncTreeRemovalFs): void {
  let entry: ReturnType<SyncTreeRemovalFs['lstat']>;
  try {
    entry = fs.lstat(path);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  if (entry.isSymbolicLink()) return removeLink(path, fs);
  if (!entry.isDirectory()) return removeFile(path, fs);
  let names: string[];
  try {
    names = fs.readdir(path);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  for (const name of names) removeEntry(join(path, name), fs);
  ignoreMissing(() => {
    try {
      fs.rmdir(path);
    } catch (error) {
      if (!isAccessError(error)) throw error;
      // A read-only directory on Windows refuses removal until its attribute is cleared.
      fs.chmod(path, 0o777);
      fs.rmdir(path);
    }
  });
}

/** The link itself: `unlink` removes a file link, and `rmdir` a directory link or junction. */
function removeLink(path: string, fs: SyncTreeRemovalFs): void {
  ignoreMissing(() => {
    try {
      fs.unlink(path);
    } catch (error) {
      if (!isAccessError(error) && errorCode(error) !== 'EISDIR') throw error;
      fs.rmdir(path);
    }
  });
}

function removeFile(path: string, fs: SyncTreeRemovalFs): void {
  ignoreMissing(() => {
    try {
      fs.unlink(path);
    } catch (error) {
      if (!isAccessError(error)) throw error;
      // A read-only file on Windows refuses deletion until its attribute is cleared.
      fs.chmod(path, 0o666);
      fs.unlink(path);
    }
  });
}

function ignoreMissing(action: () => void): void {
  try {
    action();
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

function isAccessError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'EPERM' || code === 'EACCES';
}

function isEnoent(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code ?? '')
    : '';
}

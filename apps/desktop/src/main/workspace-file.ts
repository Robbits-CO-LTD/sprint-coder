import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { resolveSafeWorkspaceFile } from './workspace-safe-path';

/** A file larger than this is not something anyone watches scroll past; the tail is what matters. */
const MAX_PREVIEW_BYTES = 262_144;

/**
 * Reads the tail of a file inside the Workspace, for Runtimes that report an edit without its body
 * (issue #39).
 *
 * Every refusal here is deliberate:
 *
 *   - **`lstat`, not `stat`.** A symlink is not followed. The same lesson as issue #11's generated
 *     images: a Runtime that plants `notes.md -> ~/.ssh/id_rsa` inside the Workspace would otherwise
 *     get the target's contents rendered in the UI, and the path check upstream would see nothing
 *     wrong because the *link* really is in the Workspace.
 *   - **Regular files only.** A fifo would block the Main process; a device file has no end.
 *   - **The tail, not the head.** A long file's interesting part is where the writing stopped.
 *   - **Binary is rejected.** A NUL byte in the sample means this is not something to show as text,
 *     and pasting a binary blob into the DOM helps nobody.
 *
 * Returns null on any of those, and on any I/O error: this is a display nicety, and a Turn must
 * never fail because its preview could not be produced.
 */
export function readWorkspaceTextFile(workspacePath: string, relativePath: string): string | null {
  const safe = resolveSafeWorkspaceFile(workspacePath, relativePath);
  if (safe.path === null) return null;
  const absolute = safe.path;
  let fd: number | null = null;
  try {
    fd = openSync(
      absolute,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    );
    const stat = fstatSync(fd, { bigint: true });
    if (
      stat.dev !== safe.identity.dev ||
      stat.ino !== safe.identity.ino ||
      stat.nlink !== 1n ||
      safe.identity.nlink !== 1n
    )
      return null;
    if (!stat.isFile()) return null;
    if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const size = Number(stat.size);
    const start = size > MAX_PREVIEW_BYTES ? size - MAX_PREVIEW_BYTES : 0;
    const length = Math.min(size, MAX_PREVIEW_BYTES);
    if (length === 0) return '';
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, start);
    const slice = buffer.subarray(0, read);
    if (slice.includes(0)) return null;
    return slice.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null)
      try {
        closeSync(fd);
      } catch {
        // Nothing to do and nothing to report: the content, if any, is already read.
      }
  }
}

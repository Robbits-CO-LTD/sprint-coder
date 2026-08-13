import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  futimesSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { exchangePosixFiles, replaceWindowsFileWithBackup } from './native-file-publication';
import { resolveSafeWorkspaceFile } from './workspace-safe-path';

// Reading a Workspace file in full so the user can edit it, and writing their edit back (issue #43).
//
// This is the app's only user-initiated write path, and it is deliberately separate from the Edit
// Saga. That machinery exists to constrain what a *Runtime* may do to the Workspace — it is gated to
// packaged builds by native-mutation-platform-gate.ts and is fail-closed by design. A person who
// opened a file in the editor and pressed save is not an agent side effect, and routing them through
// a gate that cannot open in a dev build would mean the editor never works.
//
// So the boundary here is narrow and explicit instead:
//
//   - the path must resolve inside the Workspace root, checked the same way reads are;
//   - `lstat`, so a symlink is never followed (the lesson from issue #11's generated images: a link
//     planted inside the Workspace passes a path check while pointing anywhere);
//   - regular files only;
//   - the caller must present the digest it started from, and a mismatch refuses the write.
//
// The size cap is a correctness requirement, not a performance one. workspace-file.ts returns the
// last 262KB of a file because it feeds a live view; saving that tail back would overwrite the file
// with its own end and silently drop everything before it. Editing therefore uses its own full read
// with its own cap, and a file past that cap is not editable at all.

/** Files above this are not opened for editing. Refusing beats truncating. */
export const MAX_EDITABLE_BYTES = 2_097_152;

export type OpenRefusal =
  'too_large' | 'binary' | 'not_a_file' | 'outside_workspace' | 'recovery_required';

export type OpenedFile =
  | { editable: true; path: string; text: string; digest: string; reason: null }
  | { editable: false; path: string; text: ''; digest: string; reason: OpenRefusal };

export function openWorkspaceFileForEdit(workspacePath: string, relativePath: string): OpenedFile {
  const refuse = (reason: OpenRefusal): OpenedFile => ({
    editable: false,
    path: relativePath,
    text: '',
    digest: EMPTY_DIGEST,
    reason,
  });
  const safe = resolveSafeWorkspaceFile(workspacePath, relativePath);
  if (safe.path === null) return refuse(safe.reason);
  const absolute = safe.path;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      absolute,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    );
    const stat = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(stat, safe.identity)) return refuse('outside_workspace');
    if (!stat.isFile()) return refuse('not_a_file');
    if (stat.size > BigInt(MAX_EDITABLE_BYTES)) return refuse('too_large');
    const bytes = readFileSync(descriptor);
    if (bytes.includes(0)) return refuse('binary');
    let text: string;
    try {
      // Buffer.toString() silently replaces malformed sequences with U+FFFD. Saving that text would
      // irreversibly corrupt Shift-JIS or damaged UTF-8, so only strict UTF-8 is editable.
      // Keep U+FEFF in the editor value so a UTF-8 BOM is written back unchanged. TextDecoder's
      // default consumes it, which would make an otherwise no-op save remove three bytes.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return refuse('binary');
    }
    return {
      editable: true,
      path: relativePath,
      text,
      digest: digestOf(bytes),
      reason: null,
    };
  } catch {
    return refuse('not_a_file');
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

/** Compatibility entry point. Atomic saves never require workspace-side recovery data. */
export function recoverWorkspaceFileForEdit(
  workspacePath: string,
  relativePath: string,
): OpenedFile {
  return openWorkspaceFileForEdit(workspacePath, relativePath);
}

export type SaveOutcome = {
  outcome: 'saved' | 'conflict' | 'refused';
  digest: string | null;
  reason: OpenRefusal | 'io_error' | null;
  conflictPath: string | null;
};

/** Reads only the digest used to reconcile a durable user-save intent; it never repairs or writes. */
export function observeWorkspaceFileDigest(
  workspacePath: string,
  relativePath: string,
): string | null {
  const opened = openWorkspaceFileForEdit(workspacePath, relativePath);
  return opened.editable ? opened.digest : null;
}

/**
 * Writes the user's edit, but only if the file on disk still matches what they started from.
 *
 * The digest check is the whole safety story for concurrent editing. A Runtime may be rewriting the
 * same file while the user types; refusing lets the UI offer a real choice instead of one side
 * silently winning.
 *
 * The target is opened once for validation. Replacement bytes are staged and durably flushed in a
 * uniquely-named, exclusively-created sibling copied from that target. The target identity and
 * digest are revalidated immediately before publishing. Publication is one atomic sibling rename,
 * so another writer can observe the complete old file or the complete new file, never a
 * truncated/interleaved buffer. Copying the target to the staging sibling first retains the file
 * metadata that the host filesystem copies with it. Workspace files are never trusted as recovery
 * metadata.
 */
export function saveWorkspaceFile(
  workspacePath: string,
  relativePath: string,
  text: string,
  baseDigest: string,
): SaveOutcome {
  const refuse = (reason: OpenRefusal | 'io_error'): SaveOutcome => ({
    outcome: 'refused',
    digest: null,
    reason,
    conflictPath: null,
  });
  if (Buffer.byteLength(text, 'utf8') > MAX_EDITABLE_BYTES) return refuse('too_large');
  if (!SHA256_PATTERN.test(baseDigest)) return refuse('io_error');
  const safe = resolveSafeWorkspaceFile(workspacePath, relativePath);
  if (safe.path === null) return refuse(safe.reason);
  const absolute = safe.path;

  let descriptor: number | null = null;
  let stagingDescriptor: number | null = null;
  const nonce = randomBytes(16).toString('hex');
  const stagingRelative = `${relativePath}.sprint-coder-stage-${nonce}.tmp`;
  const backupRelative = `${relativePath}.sprint-coder-backup-${nonce}.tmp`;
  const staging = `${absolute}.sprint-coder-stage-${nonce}.tmp`;
  const backup = `${absolute}.sprint-coder-backup-${nonce}.tmp`;
  let ownsStaging = false;
  let ownsBackup = false;
  let publicationAttempted = false;
  try {
    descriptor = openSync(
      absolute,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    );
    const stat = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(stat, safe.identity)) return refuse('outside_workspace');
    if (!stat.isFile()) return refuse('not_a_file');
    if (stat.size > BigInt(MAX_EDITABLE_BYTES)) return refuse('too_large');
    const current = readDescriptor(descriptor, Number(stat.size));
    // Not an error: the file changed under the editor, so this write is not the one to make.
    if (digestOf(current) !== baseDigest)
      return { outcome: 'conflict', digest: null, reason: null, conflictPath: null };

    const bytes = Buffer.from(text, 'utf8');
    // POSIX starts from a copy of the validated target so copyable metadata is retained. Windows
    // creates the staging inode through one exclusive handle; File.Replace retains the target ACL.
    // Claim the nonce path first so a partial creation is always cleaned up after ENOSPC/EIO.
    ownsStaging = true;
    const originalMode = Number(stat.mode & 0o7777n);
    let stagedIdentity: ReturnType<typeof fstatSync> | null = null;
    if (process.platform === 'win32') {
      // Create and retain the exclusive handle used for all writes. Reopening this pathname would
      // let a Workspace watcher replace it with a symlink and redirect truncation outside the
      // Workspace. File.Replace later retains the live destination's ACL.
      stagingDescriptor = openSync(
        staging,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
        0o600,
      );
      const stagingStat = fstatSync(stagingDescriptor, { bigint: true });
      if (!stagingStat.isFile() || stagingStat.nlink !== 1n) return refuse('outside_workspace');
    } else {
      stageTargetFile(absolute, staging);
      // A watcher can replace the freshly-copied pathname before we make a read-only staging file
      // writable. Open without following links first and mutate only that validated inode, so a
      // planted symlink cannot redirect chmod outside the Workspace.
      stagingDescriptor = openSync(staging, constants.O_RDONLY | constants.O_NOFOLLOW);
      stagedIdentity = fstatSync(stagingDescriptor, { bigint: true });
      if (!stagedIdentity.isFile() || stagedIdentity.nlink !== 1n)
        return refuse('outside_workspace');
      fchmodSync(stagingDescriptor, originalMode | 0o200);
      closeSync(stagingDescriptor);
      stagingDescriptor = null;
    }
    if (stagingDescriptor === null) {
      stagingDescriptor = openSync(staging, constants.O_RDWR | constants.O_NOFOLLOW);
      const stagingStat = fstatSync(stagingDescriptor, { bigint: true });
      if (
        !stagingStat.isFile() ||
        stagingStat.nlink !== 1n ||
        (stagedIdentity !== null && !sameIdentity(stagingStat, stagedIdentity))
      )
        return refuse('outside_workspace');
    }

    replaceDescriptorContents(stagingDescriptor, bytes);
    if (digestOf(readDescriptor(stagingDescriptor, bytes.length)) !== digestOf(bytes))
      return refuse('io_error');
    restoreStagedMetadata(descriptor, stagingDescriptor, originalMode);
    closeSync(stagingDescriptor);
    stagingDescriptor = null;

    const finalTarget = resolveSafeWorkspaceFile(workspacePath, relativePath);
    if (
      finalTarget.path === null ||
      finalTarget.path !== absolute ||
      !sameIdentity(finalTarget.identity, safe.identity)
    )
      return refuse('outside_workspace');

    const latestStat = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(latestStat, safe.identity)) return refuse('outside_workspace');
    if (latestStat.size > BigInt(MAX_EDITABLE_BYTES)) return refuse('too_large');
    if (digestOf(readDescriptor(descriptor, Number(latestStat.size))) !== baseDigest)
      return { outcome: 'conflict', digest: null, reason: null, conflictPath: null };

    // Windows will not replace an open destination. Closing only after the final identity/digest
    // check keeps the race window as small as the filesystem API permits; rename itself is atomic.
    closeSync(descriptor);
    descriptor = null;
    const publication = publishStagedFile(
      staging,
      absolute,
      backup,
      baseDigest,
      digestOf(bytes),
      () => {
        publicationAttempted = true;
      },
    );
    if (publication === 'conflict' || publication === 'conflict_backup') {
      // Atomic rollback moves the version displaced at rollback time into staging. Retaining it is
      // essential: deleting it could destroy a third-party edit made after the first exchange.
      const preservedBackup = publication === 'conflict_backup';
      if (preservedBackup) ownsBackup = false;
      else ownsStaging = false;
      return {
        outcome: 'conflict',
        digest: null,
        reason: null,
        conflictPath: preservedBackup ? backupRelative : stagingRelative,
      };
    }
    if (publication === 'intervened') {
      ownsBackup = existsSync(backup);
      return { outcome: 'conflict', digest: null, reason: null, conflictPath: null };
    }
    ownsBackup = existsSync(backup);
    try {
      syncParentDirectory(absolute);
    } catch {
      // Publication is the commit point: the target already contains the complete replacement.
      // Some FUSE and network filesystems reject directory fsync even though the atomic rename
      // succeeded. Reporting a refusal here would leave the editor stale and make a retry conflict.
    }
    return { outcome: 'saved', digest: digestOf(bytes), reason: null, conflictPath: null };
  } catch (error) {
    if (error instanceof AtomicExchangeUnsupportedError) return refuse('io_error');
    if (publicationAttempted) {
      if (existsSync(staging)) {
        ownsStaging = false;
        return {
          outcome: 'refused',
          digest: null,
          reason: 'io_error',
          conflictPath: stagingRelative,
        };
      }
      if (existsSync(backup)) {
        ownsBackup = false;
        return {
          outcome: 'refused',
          digest: null,
          reason: 'io_error',
          conflictPath: backupRelative,
        };
      }
    }
    return refuse('io_error');
  } finally {
    if (stagingDescriptor !== null)
      try {
        closeSync(stagingDescriptor);
      } catch {
        // Cleanup below is still attempted.
      }
    if (ownsStaging)
      try {
        unlinkSync(staging);
      } catch {
        // A crash-safe atomic save never mutates the target before publication.
      }
    if (ownsBackup)
      try {
        unlinkSync(backup);
      } catch {
        // The backup remains an inert, untrusted file; no later open consumes or deletes it.
      }
    if (descriptor !== null) closeSync(descriptor);
  }
}

function syncParentDirectory(absolute: string): void {
  if (process.platform === 'win32') return;
  const descriptor = openSync(dirname(absolute), constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Atomically publishes complete bytes while retaining the destination's Windows security data. */
function publishStagedFile(
  staging: string,
  absolute: string,
  backup: string,
  baseDigest: string,
  replacementDigest: string,
  markPublished: () => void,
): 'published' | 'conflict' | 'conflict_backup' | 'intervened' {
  if (process.platform !== 'win32') {
    try {
      exchangePosixFiles(staging, absolute);
    } catch (error) {
      // There is no portable sequence of ordinary POSIX rename/link operations that can both
      // publish and restore without overwriting a writer racing either boundary. On filesystems
      // without atomic exchange, leave the live destination untouched and fail closed.
      if (isUnsupportedExchange(error)) throw new AtomicExchangeUnsupportedError(error);
      throw error;
    }
    markPublished();
    try {
      if (digestOf(readFileSync(staging)) === baseDigest)
        return digestOf(readFileSync(absolute)) === replacementDigest ? 'published' : 'intervened';
      exchangePosixFiles(staging, absolute);
      return 'conflict';
    } catch (error) {
      try {
        exchangePosixFiles(staging, absolute);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'POSIX atomic publication and rollback both failed',
          { cause: rollbackError },
        );
      }
      throw error;
    }
  }
  // ReplaceFileW retains the destination ACL and atomically places its boundary version in backup.
  replaceWindowsFileWithBackup(staging, absolute, backup);
  markPublished();
  try {
    if (digestOf(readFileSync(backup)) === baseDigest)
      return digestOf(readFileSync(absolute)) === replacementDigest ? 'published' : 'intervened';
    replaceWindowsFileWithBackup(backup, absolute, staging);
    return 'conflict';
  } catch (error) {
    try {
      replaceWindowsFileWithBackup(backup, absolute, staging);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Windows atomic publication and rollback both failed',
        { cause: rollbackError },
      );
    }
    throw error;
  }
}

function stageTargetFile(absolute: string, staging: string): void {
  // copyFile does not promise POSIX ACL/xattr retention. Use the trusted system copy command on
  // supported hosts so an atomic editor save cannot silently strip security metadata.
  if (process.platform === 'linux') {
    execFileSync(
      '/bin/cp',
      ['--preserve=all', '--reflink=auto', '--no-target-directory', absolute, staging],
      { stdio: 'ignore' },
    );
    return;
  }
  if (process.platform === 'darwin') {
    execFileSync('/bin/cp', ['-p', absolute, staging], { stdio: 'ignore' });
    return;
  }
  throw new Error(`Atomic metadata-preserving saves are unsupported on ${process.platform}`);
}

function restoreStagedMetadata(
  sourceDescriptor: number,
  stagingDescriptor: number,
  originalMode: number,
): void {
  if (process.platform === 'linux') {
    // Linux clears security.capability when file contents change. Reapply attributes after the
    // write without reopening either pathname. Passing the already-validated descriptors to fixed
    // child fds keeps a hostile rename/symlink swap from redirecting metadata outside the Workspace.
    execFileSync(
      '/bin/cp',
      [
        '--attributes-only',
        '--preserve=all',
        '--no-target-directory',
        '/proc/self/fd/3',
        '/proc/self/fd/4',
      ],
      { stdio: ['ignore', 'ignore', 'ignore', sourceDescriptor, stagingDescriptor] },
    );
  }
  const now = new Date();
  futimesSync(stagingDescriptor, now, now);
  fchmodSync(stagingDescriptor, originalMode);
}

function isUnsupportedExchange(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'UNSUPPORTED';
}

class AtomicExchangeUnsupportedError extends Error {
  constructor(cause: unknown) {
    super('Atomic file exchange is unsupported by this filesystem', { cause });
    this.name = 'AtomicExchangeUnsupportedError';
  }
}

const EMPTY_DIGEST = createHash('sha256').update('').digest('hex');
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function digestOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readDescriptor(descriptor: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(descriptor, bytes, offset, size - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  return offset === size ? bytes : bytes.subarray(0, offset);
}

function replaceDescriptorContents(descriptor: number, bytes: Buffer): void {
  ftruncateSync(descriptor, 0);
  let offset = 0;
  while (offset < bytes.length)
    offset += writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
  fsyncSync(descriptor);
}

function sameIdentity(
  actual: Readonly<{ dev: bigint; ino: bigint; nlink: bigint }>,
  expected: Readonly<{ dev: bigint; ino: bigint; nlink: bigint }>,
): boolean {
  return (
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.nlink === 1n &&
    expected.nlink === 1n
  );
}

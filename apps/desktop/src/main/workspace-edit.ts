import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
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

export type OpenRefusal = 'too_large' | 'binary' | 'not_a_file' | 'outside_workspace';

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

export type SaveOutcome = {
  outcome: 'saved' | 'conflict' | 'refused';
  digest: string | null;
  reason: OpenRefusal | 'io_error' | null;
};

/**
 * Writes the user's edit, but only if the file on disk still matches what they started from.
 *
 * The digest check is the whole safety story for concurrent editing. A Runtime may be rewriting the
 * same file while the user types; refusing lets the UI offer a real choice instead of one side
 * silently winning.
 *
 * The target is opened once for validation. Replacement bytes are staged and durably flushed in a
 * random, exclusively-created sibling copied from that target, which retains its mode and Windows
 * ACL. The target identity is revalidated immediately before an atomic rename. A failed stage never
 * truncates the user's original file.
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
  });
  if (Buffer.byteLength(text, 'utf8') > MAX_EDITABLE_BYTES) return refuse('too_large');
  const safe = resolveSafeWorkspaceFile(workspacePath, relativePath);
  if (safe.path === null) return refuse(safe.reason);
  const absolute = safe.path;

  let descriptor: number | null = null;
  let temporaryDescriptor: number | null = null;
  let temporary: string | null = null;
  try {
    descriptor = openSync(
      absolute,
      constants.O_RDWR | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    );
    const stat = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(stat, safe.identity)) return refuse('outside_workspace');
    if (!stat.isFile()) return refuse('not_a_file');
    if (stat.size > BigInt(MAX_EDITABLE_BYTES)) return refuse('too_large');
    const current = readFileSync(descriptor);
    // Not an error: the file changed under the editor, so this write is not the one to make.
    if (digestOf(current) !== baseDigest)
      return { outcome: 'conflict', digest: null, reason: null };

    const bytes = Buffer.from(text, 'utf8');
    temporary = `${absolute}.sprint-coder-save-${randomUUID()}.tmp`;
    copyFileSync(absolute, temporary, constants.COPYFILE_EXCL);
    temporaryDescriptor = openSync(
      temporary,
      constants.O_RDWR | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    );
    const temporaryStat = fstatSync(temporaryDescriptor, { bigint: true });
    if (!temporaryStat.isFile() || temporaryStat.nlink !== 1n) return refuse('outside_workspace');
    // copyFileSync is pathname based. If the target changed during that copy, never publish it.
    if (digestOf(readFileSync(temporaryDescriptor)) !== baseDigest)
      return { outcome: 'conflict', digest: null, reason: null };

    ftruncateSync(temporaryDescriptor, 0);
    let offset = 0;
    while (offset < bytes.length)
      offset += writeSync(temporaryDescriptor, bytes, offset, bytes.length - offset, offset);
    if (process.platform !== 'win32') fchmodSync(temporaryDescriptor, Number(stat.mode & 0o7777n));
    fsyncSync(temporaryDescriptor);
    closeSync(temporaryDescriptor);
    temporaryDescriptor = null;

    const finalTarget = resolveSafeWorkspaceFile(workspacePath, relativePath);
    if (
      finalTarget.path === null ||
      finalTarget.path !== absolute ||
      !sameIdentity(finalTarget.identity, safe.identity)
    )
      return refuse('outside_workspace');
    // Windows does not allow replacing a file while our validation handle is open. The identity
    // was just revalidated above; close only at the final publication boundary.
    if (process.platform === 'win32') {
      closeSync(descriptor);
      descriptor = null;
    }
    renameSync(temporary, absolute);
    temporary = null;
    syncParentDirectory(dirname(absolute));
    return { outcome: 'saved', digest: digestOf(bytes), reason: null };
  } catch {
    return refuse('io_error');
  } finally {
    if (temporaryDescriptor !== null)
      try {
        closeSync(temporaryDescriptor);
      } catch {
        // The operation already failed; cleanup below is still attempted.
      }
    if (temporary !== null)
      try {
        unlinkSync(temporary);
      } catch {
        // A failed stage must not obscure the original refusal.
      }
    if (descriptor !== null) closeSync(descriptor);
  }
}

const EMPTY_DIGEST = createHash('sha256').update('').digest('hex');

function digestOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
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

function syncParentDirectory(parent: string): void {
  if (process.platform === 'win32') return;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(parent, constants.O_RDONLY);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

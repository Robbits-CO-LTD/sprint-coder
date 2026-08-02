import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  readSync,
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
  let safe = resolveSafeWorkspaceFile(workspacePath, relativePath);
  if (safe.path === null) return refuse(safe.reason);
  try {
    recoverInterruptedSave(safe.path);
  } catch {
    return refuse('not_a_file');
  }
  // Recovery writes through the existing descriptor, but re-resolve anyway so this boundary never
  // relies on identity information captured before filesystem repair.
  safe = resolveSafeWorkspaceFile(workspacePath, relativePath);
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
 * exclusively-created sibling copied from that target. Before the live inode is touched, a durable
 * journal records both the original and replacement digests. The target identity and digest are
 * revalidated immediately before publishing. Publication writes through the original descriptor so
 * the inode — including its ACLs and extended attributes — is retained. If the process or machine
 * stops mid-write, the next open/save restores the flushed recovery copy before exposing the file.
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
  if (!SHA256_PATTERN.test(baseDigest)) return refuse('io_error');
  let safe = resolveSafeWorkspaceFile(workspacePath, relativePath);
  if (safe.path === null) return refuse(safe.reason);
  try {
    recoverInterruptedSave(safe.path);
  } catch {
    return refuse('io_error');
  }
  safe = resolveSafeWorkspaceFile(workspacePath, relativePath);
  if (safe.path === null) return refuse(safe.reason);
  const absolute = safe.path;

  let descriptor: number | null = null;
  let recoveryDescriptor: number | null = null;
  let recovery: string | null = null;
  let stagingDescriptor: number | null = null;
  let staging: string | null = null;
  let journalDescriptor: number | null = null;
  let journal: string | null = null;
  let original: Buffer | null = null;
  let targetMutationStarted = false;
  let preserveRecoveryCopy = false;
  try {
    descriptor = openSync(
      absolute,
      constants.O_RDWR | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    );
    const stat = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(stat, safe.identity)) return refuse('outside_workspace');
    if (!stat.isFile()) return refuse('not_a_file');
    if (stat.size > BigInt(MAX_EDITABLE_BYTES)) return refuse('too_large');
    const current = readDescriptor(descriptor, Number(stat.size));
    original = current;
    // Not an error: the file changed under the editor, so this write is not the one to make.
    if (digestOf(current) !== baseDigest)
      return { outcome: 'conflict', digest: null, reason: null };

    const bytes = Buffer.from(text, 'utf8');
    const transaction = transactionPaths(absolute);
    recovery = transaction.recovery;
    staging = transaction.staging;
    journal = transaction.journal;
    copyFileSync(absolute, recovery, constants.COPYFILE_EXCL);
    recoveryDescriptor = openSync(
      recovery,
      constants.O_RDWR | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    );
    const recoveryStat = fstatSync(recoveryDescriptor, { bigint: true });
    if (!recoveryStat.isFile() || recoveryStat.nlink !== 1n) return refuse('outside_workspace');
    // copyFileSync is pathname based. If the target changed during that copy, never publish it.
    if (digestOf(readDescriptor(recoveryDescriptor, Number(recoveryStat.size))) !== baseDigest)
      return { outcome: 'conflict', digest: null, reason: null };
    fsyncSync(recoveryDescriptor);
    closeSync(recoveryDescriptor);
    recoveryDescriptor = null;

    stagingDescriptor = openSync(
      staging,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_RDWR |
        (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
      0o600,
    );
    const stagingStat = fstatSync(stagingDescriptor, { bigint: true });
    if (!stagingStat.isFile() || stagingStat.nlink !== 1n) return refuse('outside_workspace');

    replaceDescriptorContents(stagingDescriptor, bytes);
    if (digestOf(readDescriptor(stagingDescriptor, bytes.length)) !== digestOf(bytes))
      return refuse('io_error');
    closeSync(stagingDescriptor);
    stagingDescriptor = null;

    const journalBytes = Buffer.from(
      JSON.stringify({ version: 1, originalDigest: baseDigest, newDigest: digestOf(bytes) }),
      'utf8',
    );
    journalDescriptor = openSync(
      journal,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_RDWR |
        (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
      0o600,
    );
    replaceDescriptorContents(journalDescriptor, journalBytes);
    closeSync(journalDescriptor);
    journalDescriptor = null;
    syncParentDirectory(absolute);

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
      return { outcome: 'conflict', digest: null, reason: null };

    targetMutationStarted = true;
    replaceDescriptorContents(descriptor, bytes);
    targetMutationStarted = false;
    return { outcome: 'saved', digest: digestOf(bytes), reason: null };
  } catch {
    if (targetMutationStarted && descriptor !== null && original !== null) {
      try {
        replaceDescriptorContents(descriptor, original);
        targetMutationStarted = false;
      } catch {
        // Keep the untouched original bytes on disk if even restoring the original inode fails.
        preserveRecoveryCopy = true;
      }
    }
    return refuse('io_error');
  } finally {
    if (recoveryDescriptor !== null)
      try {
        closeSync(recoveryDescriptor);
      } catch {
        // The operation already failed; cleanup below is still attempted.
      }
    if (stagingDescriptor !== null)
      try {
        closeSync(stagingDescriptor);
      } catch {
        // The operation already failed; cleanup below is still attempted.
      }
    if (journalDescriptor !== null)
      try {
        closeSync(journalDescriptor);
      } catch {
        // The operation already failed; cleanup below is still attempted.
      }
    // Remove the recovery bytes first and the journal last. If the process stops during cleanup,
    // the remaining journal can prove that an already-complete target is safe to keep.
    let transactionPayloadRemoved = true;
    if (recovery !== null && !preserveRecoveryCopy)
      try {
        unlinkSync(recovery);
      } catch {
        transactionPayloadRemoved = false;
      }
    if (staging !== null && !preserveRecoveryCopy)
      try {
        unlinkSync(staging);
      } catch {
        transactionPayloadRemoved = false;
      }
    if (journal !== null && !preserveRecoveryCopy && transactionPayloadRemoved)
      try {
        unlinkSync(journal);
      } catch {
        // A later open can safely repeat cleanup from the durable journal.
      }
    if (descriptor !== null) closeSync(descriptor);
  }
}

type SaveJournal = Readonly<{
  version: 1;
  originalDigest: string;
  newDigest: string;
}>;

const RECOVERY_SUFFIX = '.sprint-coder-recovery.tmp';
const STAGING_SUFFIX = '.sprint-coder-stage.tmp';
const JOURNAL_SUFFIX = '.sprint-coder-save.json';

function transactionPaths(absolute: string): Readonly<{
  recovery: string;
  staging: string;
  journal: string;
}> {
  return {
    recovery: `${absolute}${RECOVERY_SUFFIX}`,
    staging: `${absolute}${STAGING_SUFFIX}`,
    journal: `${absolute}${JOURNAL_SUFFIX}`,
  };
}

/** Repairs an interrupted in-place publication before callers can observe or overwrite it. */
function recoverInterruptedSave(absolute: string): void {
  const transaction = transactionPaths(absolute);
  const hasRecovery = existsSync(transaction.recovery);
  const hasStage = existsSync(transaction.staging);
  const hasJournal = existsSync(transaction.journal);
  if (!hasRecovery && !hasStage && !hasJournal) return;

  let targetDescriptor: number | null = null;
  let recoveryDescriptor: number | null = null;
  let journalDescriptor: number | null = null;
  try {
    // Publication never begins until both recovery bytes and the journal have been flushed. An
    // incomplete pre-journal transaction is deliberately left fail-closed instead of deleting a
    // user-created lookalike file.
    if (!hasJournal) throw new Error('Incomplete save transaction');

    journalDescriptor = openSync(
      transaction.journal,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    );
    const journalStat = fstatSync(journalDescriptor, { bigint: true });
    if (!journalStat.isFile() || journalStat.nlink !== 1n || journalStat.size > 1_024n)
      throw new Error('Unsafe save journal');
    const parsed: unknown = JSON.parse(
      readDescriptor(journalDescriptor, Number(journalStat.size)).toString('utf8'),
    );
    if (!isSaveJournal(parsed)) throw new Error('Invalid save journal');

    targetDescriptor = openSync(
      absolute,
      constants.O_RDWR | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    );
    const targetStat = fstatSync(targetDescriptor, { bigint: true });
    if (
      !targetStat.isFile() ||
      targetStat.nlink !== 1n ||
      targetStat.size > BigInt(MAX_EDITABLE_BYTES)
    )
      throw new Error('Unsafe save target');
    const targetBytes = readDescriptor(targetDescriptor, Number(targetStat.size));
    const targetDigest = digestOf(targetBytes);

    if (targetDigest !== parsed.originalDigest && targetDigest !== parsed.newDigest) {
      if (!hasRecovery) throw new Error('Save recovery bytes are missing');
      recoveryDescriptor = openSync(
        transaction.recovery,
        constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
      );
      const recoveryStat = fstatSync(recoveryDescriptor, { bigint: true });
      if (
        !recoveryStat.isFile() ||
        recoveryStat.nlink !== 1n ||
        recoveryStat.size > BigInt(MAX_EDITABLE_BYTES)
      )
        throw new Error('Unsafe save recovery file');
      const original = readDescriptor(recoveryDescriptor, Number(recoveryStat.size));
      if (digestOf(original) !== parsed.originalDigest)
        throw new Error('Save recovery digest mismatch');
      // A partial write and a legitimate post-crash external edit can have identical bytes (empty
      // is a prefix of every value). There is no safe automatic choice. Keep the verified original
      // recovery copy and fail closed so Sprint Coder never overwrites a newer external edit.
      throw new Error('Interrupted save requires explicit recovery');
    }
  } finally {
    if (journalDescriptor !== null) closeSync(journalDescriptor);
    if (recoveryDescriptor !== null) closeSync(recoveryDescriptor);
    if (targetDescriptor !== null) closeSync(targetDescriptor);
  }

  // Journal-last deletion makes an interrupted cleanup distinguishable from an interrupted write.
  if (hasRecovery) unlinkSync(transaction.recovery);
  if (hasStage) unlinkSync(transaction.staging);
  unlinkSync(transaction.journal);
}

function isSaveJournal(value: unknown): value is SaveJournal {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SaveJournal>;
  return (
    candidate.version === 1 &&
    typeof candidate.originalDigest === 'string' &&
    SHA256_PATTERN.test(candidate.originalDigest) &&
    typeof candidate.newDigest === 'string' &&
    SHA256_PATTERN.test(candidate.newDigest)
  );
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

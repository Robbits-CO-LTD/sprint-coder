import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  chmodSync,
  constants,
  copyFileSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  readSync,
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
};

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
 * so another
 * writer can observe the complete old file or the complete new file, never a truncated/interleaved
 * buffer. Copying the target to the staging sibling first retains the file metadata that the host
 * filesystem copies with it. Workspace files are never trusted as recovery metadata.
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
  const safe = resolveSafeWorkspaceFile(workspacePath, relativePath);
  if (safe.path === null) return refuse(safe.reason);
  const absolute = safe.path;

  let descriptor: number | null = null;
  let stagingDescriptor: number | null = null;
  const nonce = randomBytes(16).toString('hex');
  const staging = `${absolute}.sprint-coder-stage-${nonce}.tmp`;
  const backup = `${absolute}.sprint-coder-backup-${nonce}.tmp`;
  let ownsStaging = false;
  let ownsBackup = false;
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
      return { outcome: 'conflict', digest: null, reason: null };

    const bytes = Buffer.from(text, 'utf8');
    // Start from a copy of the validated target so mode and other copyable metadata are retained.
    // Windows publication below separately uses File.Replace to retain the destination ACL.
    copyFileSync(absolute, staging, constants.COPYFILE_EXCL);
    ownsStaging = true;
    const originalMode = Number(stat.mode & 0o777n);
    chmodSync(staging, originalMode | 0o200);
    stagingDescriptor = openSync(
      staging,
      constants.O_RDWR | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    );
    const stagingStat = fstatSync(stagingDescriptor, { bigint: true });
    if (!stagingStat.isFile() || stagingStat.nlink !== 1n) return refuse('outside_workspace');

    replaceDescriptorContents(stagingDescriptor, bytes);
    if (digestOf(readDescriptor(stagingDescriptor, bytes.length)) !== digestOf(bytes))
      return refuse('io_error');
    closeSync(stagingDescriptor);
    stagingDescriptor = null;
    chmodSync(staging, originalMode);

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

    // Windows will not replace an open destination. Closing only after the final identity/digest
    // check keeps the race window as small as the filesystem API permits; rename itself is atomic.
    closeSync(descriptor);
    descriptor = null;
    publishStagedFile(staging, absolute, backup);
    ownsStaging = false;
    ownsBackup = process.platform === 'win32';
    syncParentDirectory(absolute);
    return { outcome: 'saved', digest: digestOf(bytes), reason: null };
  } catch {
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

const WINDOWS_POWERSHELL = `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const WINDOWS_ATOMIC_REPLACE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[System.IO.File]::Replace(
  $env:SPRINT_CODER_REPLACEMENT,
  $env:SPRINT_CODER_TARGET,
  $env:SPRINT_CODER_BACKUP,
  $false
)
`;

/** Atomically publishes complete bytes while retaining the destination's Windows security data. */
function publishStagedFile(staging: string, absolute: string, backup: string): void {
  if (process.platform !== 'win32') {
    renameSync(staging, absolute);
    return;
  }
  // File.Replace maps to ReplaceFileW. Unlike MoveFileEx/rename, it retains the destination ACL and
  // other mergeable metadata while swapping the fully-flushed sibling into place atomically.
  execFileSync(
    WINDOWS_POWERSHELL,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(WINDOWS_ATOMIC_REPLACE_SCRIPT, 'utf16le').toString('base64'),
    ],
    {
      env: {
        SystemRoot: process.env['SystemRoot'] ?? '',
        WINDIR: process.env['WINDIR'] ?? '',
        TEMP: process.env['TEMP'] ?? '',
        TMP: process.env['TMP'] ?? '',
        USERPROFILE: process.env['USERPROFILE'] ?? '',
        SPRINT_CODER_REPLACEMENT: staging,
        SPRINT_CODER_TARGET: absolute,
        SPRINT_CODER_BACKUP: backup,
      },
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 10_000,
      windowsHide: true,
    },
  );
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

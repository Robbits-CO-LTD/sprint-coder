import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
  const absolute = insideWorkspace(workspacePath, relativePath);
  if (absolute === null) return refuse('outside_workspace');
  try {
    const stat = lstatSync(absolute);
    if (!stat.isFile()) return refuse('not_a_file');
    if (stat.size > MAX_EDITABLE_BYTES) return refuse('too_large');
    const bytes = readFileSync(absolute);
    // A NUL byte anywhere means this is not text. Round-tripping it through a UTF-8 string and back
    // would not reproduce the original bytes, so editing it would corrupt the file.
    if (bytes.includes(0)) return refuse('binary');
    return {
      editable: true,
      path: relativePath,
      text: bytes.toString('utf8'),
      digest: digestOf(bytes),
      reason: null,
    };
  } catch {
    return refuse('not_a_file');
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
 * Written to a temporary sibling and renamed, so a crash or a full disk cannot leave a half-written
 * file where working code used to be. The temp file is removed on any failure.
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
  const absolute = insideWorkspace(workspacePath, relativePath);
  if (absolute === null) return refuse('outside_workspace');

  let current: Buffer;
  try {
    const stat = lstatSync(absolute);
    if (!stat.isFile()) return refuse('not_a_file');
    if (stat.size > MAX_EDITABLE_BYTES) return refuse('too_large');
    current = readFileSync(absolute);
  } catch {
    return refuse('not_a_file');
  }
  // Not an error: the file changed under the editor, so this write is not the one to make.
  if (digestOf(current) !== baseDigest) return { outcome: 'conflict', digest: null, reason: null };

  const bytes = Buffer.from(text, 'utf8');
  const temporary = `${absolute}.sprint-coder-save-${process.pid}`;
  try {
    writeFileSync(temporary, bytes, { mode: 0o600 });
    renameSync(temporary, absolute);
    return { outcome: 'saved', digest: digestOf(bytes), reason: null };
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      // Nothing further to do: the original file is untouched, which is what matters.
    }
    return refuse('io_error');
  }
}

const EMPTY_DIGEST = createHash('sha256').update('').digest('hex');

function digestOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The absolute path, or null when it is not inside the Workspace.
 *
 * Compared on the resolved path with a trailing separator, so `/ws-other/a.ts` cannot pass as being
 * inside `/ws`. The parent directory is checked too: a path whose directory escapes the root would
 * otherwise let the atomic-rename temp file be written outside it.
 */
function insideWorkspace(workspacePath: string, relativePath: string): string | null {
  if (relativePath.length === 0 || relativePath.length > 1024) return null;
  const root = resolve(workspacePath);
  const absolute = resolve(root, relativePath);
  const prefix = root.endsWith('/') ? root : `${root}/`;
  if (!absolute.startsWith(prefix)) return null;
  if (!dirname(absolute).startsWith(root)) return null;
  return absolute;
}

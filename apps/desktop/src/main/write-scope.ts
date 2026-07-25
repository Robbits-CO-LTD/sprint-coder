import type { AccessPreset, RuntimeWriteScope } from '@sprint-coder/contracts';

/**
 * The Access preset a Task is set to, plus whether it has a Workspace, decides how much the Runtime
 * may write this Turn (issue #37).
 *
 * Two inputs, both required:
 *
 *   - **The preset** is the user's standing choice for this Task.
 *   - **The Workspace** is what makes a write meaningful. Without one the adapters run in a
 *     throwaway temp directory that is deleted when the Turn ends, so a write capability there
 *     would produce edits nobody can see, review, or keep — worse than no edit, because the model
 *     would report success. This returns `read-only` for that case at every preset, and both
 *     adapters independently refuse a write scope with a null workspace as well; a write would have
 *     to get past both.
 *
 * `ask` maps to `read-only` rather than to a prompt because neither CLI can be asked mid-turn:
 * `codex exec` is one-shot stdin with no answerable approval channel, and `claude -p` has no
 * permission-prompt hook on 2.1.218 (verified — the flag is absent from its help, and
 * `--permission-mode manual` simply denies and reports the denial afterwards). Pretending to ask
 * and then silently allowing would be the worst of the three options, so `ask` means "propose, do
 * not write", and what was refused is reported after the fact from Claude's `permission_denials`.
 */
export function resolveWriteScope(
  preset: AccessPreset,
  workspacePath: string | null,
): RuntimeWriteScope {
  if (workspacePath === null) return 'read-only';
  return preset === 'full' ? 'full' : preset === 'auto' ? 'workspace-write' : 'read-only';
}

/**
 * Makes a Runtime-reported absolute path relative to the Workspace, or rejects it.
 *
 * Rejection is the point. A path outside the Workspace root, or one that climbs out of it with
 * `..`, is not shown at all — the timeline is a place the user trusts, and rendering
 * `/Users/x/.ssh/id_rsa` there because a Runtime said so would make that trust a liability. The
 * comparison is on the resolved, separator-normalised path so that neither a symlink-shaped string
 * nor a `foo/../..` segment can look like it is inside.
 */
export function relativizeWorkspacePath(
  workspacePath: string,
  candidate: string,
  resolve: (path: string) => string,
  relative: (from: string, to: string) => string,
): string | null {
  if (candidate.length === 0 || candidate.length > 4096) return null;
  const root = resolve(workspacePath);
  const target = resolve(candidate);
  if (target === root) return null;
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsoluteLike(rel)) return null;
  const portable = rel.replaceAll('\\', '/');
  return portable.length > 1024 ? null : portable;
}

function isAbsoluteLike(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}

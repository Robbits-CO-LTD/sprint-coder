import type { EffectiveWorkspaceSet } from '@sprint-coder/contracts';

/**
 * Resolves a model-supplied Workspace root without letting an invented identifier select a
 * different root. Smaller local models commonly populate optional string fields with labels such
 * as "workspace". When the sealed Turn has exactly one root, that value is unambiguous and can be
 * canonicalized safely. Multi-root Turns remain strict: an unknown identifier is always rejected.
 */
export function resolveWorkspaceToolRoot(
  workspace: EffectiveWorkspaceSet,
  requestedRootId: string | null | undefined,
): EffectiveWorkspaceSet['roots'][number] | null {
  const normalizedRootId =
    requestedRootId === undefined ||
    requestedRootId === null ||
    requestedRootId === 'legacy-primary'
      ? workspace.primaryRootId
      : requestedRootId;
  const exact = workspace.roots.find(({ rootId }) => rootId === normalizedRootId);
  if (exact !== undefined) return exact;
  return workspace.roots.length === 1 ? workspace.roots[0]! : null;
}

/**
 * Returns the stable user-facing label for a root in the complete sealed Turn Workspace.
 *
 * File-change events and persisted Saga diffs are produced by different paths. Deriving label
 * disambiguation from either path's partial result set makes the same root render differently when
 * one producer has not reported yet. The sealed Workspace is the shared authority for both.
 */
export function displayWorkspaceRootLabel(
  workspace: EffectiveWorkspaceSet,
  root: EffectiveWorkspaceSet['roots'][number],
): string {
  const maxLength = 200;
  const bounded = root.label.slice(0, maxLength);
  if (workspace.roots.length <= 1) return bounded;
  const index = workspace.roots.findIndex(({ rootId }) => rootId === root.rootId);
  if (index < 0) return bounded;
  // A fixed-width sealed-Workspace ordinal keeps every multi-root label distinct even when an
  // untrusted Project label itself looks like a generated suffix. UUIDs stay out of the UI.
  const suffix = ` [${String(index + 1).padStart(2, '0')}]`;
  return `${root.label.slice(0, maxLength - suffix.length)}${suffix}`;
}

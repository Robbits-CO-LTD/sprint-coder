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

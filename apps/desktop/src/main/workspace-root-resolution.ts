import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { EffectiveWorkspaceSet } from '@sprint-coder/contracts';

/**
 * Resolves a model-supplied Workspace root without letting an invented identifier select a
 * different root. Smaller local models commonly populate optional string fields with labels such
 * as "workspace". When the sealed Turn has exactly one root, that value is unambiguous and can be
 * canonicalized safely. Multi-root Turns remain strict: an unknown identifier is always rejected.
 *
 * When the model omits `rootId` but every target is an absolute path lexically inside exactly one
 * root, that root is selected (issue #840). This only chooses which root's PathGuard runs: the
 * guard still canonicalizes the target, follows no escaping link and refuses anything outside the
 * chosen root, and a target inside no root still falls back to the primary root and is refused.
 */
export function resolveWorkspaceToolRoot(
  workspace: EffectiveWorkspaceSet,
  requestedRootId: string | null | undefined,
  targetPaths: readonly (string | null | undefined)[] = [],
): EffectiveWorkspaceSet['roots'][number] | null {
  const omitted =
    requestedRootId === undefined ||
    requestedRootId === null ||
    requestedRootId === 'legacy-primary';
  if (omitted) {
    const inferred = rootContainingAbsoluteTargets(workspace, targetPaths);
    if (inferred !== null) return inferred;
  }
  const normalizedRootId = omitted ? workspace.primaryRootId : requestedRootId;
  const exact = workspace.roots.find(({ rootId }) => rootId === normalizedRootId);
  if (exact !== undefined) return exact;
  return workspace.roots.length === 1 ? workspace.roots[0]! : null;
}

function rootContainingAbsoluteTargets(
  workspace: EffectiveWorkspaceSet,
  targetPaths: readonly (string | null | undefined)[],
): EffectiveWorkspaceSet['roots'][number] | null {
  if (workspace.roots.length < 2) return null;
  const targets = targetPaths.filter(
    (path): path is string => typeof path === 'string' && path.length > 0,
  );
  if (targets.length === 0 || !targets.every((path) => isAbsolute(path))) return null;
  let selected: EffectiveWorkspaceSet['roots'][number] | null = null;
  for (const target of targets) {
    const containing = workspace.roots.filter((root) => isLexicallyWithin(root.path, target));
    if (containing.length !== 1) return null;
    if (selected !== null && selected !== containing[0]) return null;
    selected = containing[0]!;
  }
  return selected;
}

function isLexicallyWithin(root: string, target: string): boolean {
  const relation = relative(resolve(root), resolve(target));
  return (
    relation === '' ||
    (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  );
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

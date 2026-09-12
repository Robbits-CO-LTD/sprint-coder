import type { GraphMissionRecord } from './graph-mission-record';
import { graphMissionStoredContextSchema } from './graph-mission-record';
import { canonicalGraphJson } from './graph-document';
import type { GraphWriteFootprint } from './graph-write-conflicts';

/** Match the complete set of prepared claims to the immutable agreed definition. */
export function validateGraphWriteInventory(
  graph: GraphMissionRecord,
  stepKey: string,
  footprints: readonly GraphWriteFootprint[],
): void {
  const step = graph.plan.steps.find((step) => step.key === stepKey);
  if (!step) throw new Error('Graph write step not found');
  const context = graphMissionStoredContextSchema.parse(JSON.parse(graph.contextJson));
  const roots = new Map(context.roots);
  const claims =
    step.access === 'read-only'
      ? []
      : step.writeClaims.length > 0
        ? step.writeClaims
        : context.workspace.roots.map((root) => ({
            rootId: root.rootId,
            path: null,
            semanticKeys: [],
          }));
  if (step.access === 'workspace-write' && claims.length === 0)
    throw new Error('Graph write Workspace is unavailable');
  const normalize = (rootId: string, path: string | null, semanticKeys: readonly string[]) => ({
    rootId: rootId === 'legacy-primary' ? context.workspace.primaryRootId : rootId,
    path,
    semanticKeys: [...semanticKeys].sort(),
  });
  const expected = claims
    .map((claim) => canonicalGraphJson(normalize(claim.rootId, claim.path, claim.semanticKeys)))
    .sort();
  const actual = footprints
    .map((footprint) => {
      if (
        footprint.stepKey !== stepKey ||
        roots.get(footprint.rootId) !== footprint.rootIdentityDigest
      )
        throw new Error('Graph write root or step binding mismatch');
      return canonicalGraphJson(
        normalize(footprint.rootId, footprint.relativePath, footprint.semanticKeys),
      );
    })
    .sort();
  if (canonicalGraphJson(expected) !== canonicalGraphJson(actual))
    throw new Error('Graph write declarations do not match prepared claims');
}

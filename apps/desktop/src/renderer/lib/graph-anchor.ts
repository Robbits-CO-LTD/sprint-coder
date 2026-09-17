import { parseGraphInlineReference } from '@sprint-coder/contracts';
import type { GraphInlineReference } from '@sprint-coder/contracts';
import type { GraphVersionRef } from '../store/appStore';

/** Every anchor block Main appends where a graph was rendered (contracts `formatGraphInlineMarker`);
 * the fence may be longer than three backticks when the JSON itself contains a backtick run. */
const GRAPH_ANCHOR_BLOCK = /`{3,}sprint-graph\n([\s\S]*?)\n`{3,}/gu;

/** True when the reference names a version this Task really saved. */
export function knownGraphVersion(
  versions: readonly GraphVersionRef[] | undefined,
  reference: Pick<GraphInlineReference, 'graphId' | 'revision' | 'renderRevision'>,
): boolean {
  return (
    versions?.some(
      (version) =>
        version.id === reference.graphId &&
        version.revision === reference.revision &&
        version.renderRevision === reference.renderRevision,
    ) ?? false
  );
}

/**
 * True when the text carries at least one anchor that will render as a graph card — a well-formed
 * reference to a saved version. A fence a person or a model typed by hand does not count, so it
 * cannot hide the saved-graph card that stands in when a transcript has no real anchor.
 */
export function hasKnownGraphAnchor(
  text: string,
  versions: readonly GraphVersionRef[] | undefined,
): boolean {
  for (const match of text.matchAll(GRAPH_ANCHOR_BLOCK)) {
    const reference = parseGraphInlineReference(match[1] ?? '');
    if (reference !== null && knownGraphVersion(versions, reference)) return true;
  }
  return false;
}

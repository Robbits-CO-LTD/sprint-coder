import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { GRAPH_INLINE_FENCE_LANG, parseGraphInlineReference } from '@sprint-coder/contracts';
import type { GraphInlineReference } from '@sprint-coder/contracts';
import type { GraphVersionRef } from '../store/appStore';

/** The same parse the Markdown component performs (remark + GFM), so "this text carries an anchor"
 * agrees with "a card renders for it" — a fence swallowed by an unclosed `~~~` block, for one, is
 * ordinary code to both. */
const markdown = unified().use(remarkParse).use(remarkGfm);

/** Every well-formed anchor that renders as a `sprint-graph` code block, in document order. */
export function graphAnchorReferences(text: string): GraphInlineReference[] {
  const references: GraphInlineReference[] = [];
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const record = node as { type?: unknown; lang?: unknown; value?: unknown; children?: unknown };
    if (
      record.type === 'code' &&
      record.lang === GRAPH_INLINE_FENCE_LANG &&
      typeof record.value === 'string'
    ) {
      const reference = parseGraphInlineReference(record.value);
      if (reference !== null) references.push(reference);
    }
    if (Array.isArray(record.children)) for (const child of record.children) walk(child);
  };
  walk(markdown.parse(text));
  return references;
}

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
 * reference to a saved version, in a fence Markdown really treats as a `sprint-graph` block. A
 * fence a person or a model typed by hand does not count, so it cannot hide the saved-graph card
 * that stands in when a transcript has no real anchor.
 */
export function hasKnownGraphAnchor(
  text: string,
  versions: readonly GraphVersionRef[] | undefined,
): boolean {
  return graphAnchorReferences(text).some((reference) => knownGraphVersion(versions, reference));
}

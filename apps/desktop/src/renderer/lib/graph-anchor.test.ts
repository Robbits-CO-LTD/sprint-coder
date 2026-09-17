import { describe, expect, it } from 'vitest';
import { formatGraphInlineMarker } from '@sprint-coder/contracts';
import { hasKnownGraphAnchor, knownGraphVersion } from './graph-anchor';

const versions = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    revision: 2,
    renderRevision: 3,
    title: 'T',
    kind: 'workflow' as const,
  },
];
const reference = {
  graphId: versions[0]!.id,
  revision: 2,
  renderRevision: 3,
  title: 'a ``` b',
  kind: 'workflow' as const,
  nodeCount: 3,
  edgeCount: 2,
};

describe('graph anchors in a transcript', () => {
  it('recognises the anchor Main appends, including one with a lengthened fence', () => {
    const text = `調査しました。${formatGraphInlineMarker(reference)}次へ。`;
    expect(hasKnownGraphAnchor(text, versions)).toBe(true);
  });

  it('ignores fences that are not a saved reference', () => {
    expect(hasKnownGraphAnchor('```sprint-graph\n{}\n```', versions)).toBe(false);
    expect(hasKnownGraphAnchor('```sprint-graph\nnot json\n```', versions)).toBe(false);
    const forged = JSON.stringify({ ...reference, renderRevision: 9 });
    expect(hasKnownGraphAnchor(`\`\`\`sprint-graph\n${forged}\n\`\`\``, versions)).toBe(false);
    expect(hasKnownGraphAnchor(formatGraphInlineMarker(reference), undefined)).toBe(false);
    expect(hasKnownGraphAnchor('no anchors here', versions)).toBe(false);
  });

  it('matches a version on graph id and both revisions', () => {
    expect(knownGraphVersion(versions, reference)).toBe(true);
    expect(knownGraphVersion(versions, { ...reference, revision: 1 })).toBe(false);
    expect(knownGraphVersion(undefined, reference)).toBe(false);
  });
});

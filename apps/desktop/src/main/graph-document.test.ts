import { describe, expect, it } from 'vitest';
import {
  graphSemanticDigest,
  nextGraphDocument,
  parseStoredGraphDocument,
  validateGraphDocumentWrite,
} from './graph-document';

const taskId = '00000000-0000-4000-8000-000000000001';
const architecture = {
  schema_version: 1,
  diagram_type: 'architecture',
  meta: { title: 'Plan' },
  components: [
    { id: 'client', type: 'backend', label: 'Client', pos: [40, 40] },
    { id: 'server', type: 'backend', label: 'Server', pos: [260, 40] },
  ],
  connections: [{ id: 'request', from: 'client', to: 'server', label: 'Request' }],
};

describe('graph document semantics', () => {
  it('versions relationship judgments independently of layout and annotation order', () => {
    const annotations = [
      { elementKind: 'node', elementId: 'server', basis: 'proposed', rationale: 'Add a server' },
      {
        elementKind: 'edge',
        elementId: 'request',
        basis: 'inferred',
        rationale: 'Likely request flow',
      },
    ] as const;
    const first = nextGraphDocument(taskId, architecture, null, [], annotations);
    const reordered = nextGraphDocument(
      taskId,
      architecture,
      first,
      [],
      [...annotations].reverse(),
    );
    expect(reordered.semanticRevision).toBe(first.semanticRevision);
    const revised = nextGraphDocument(
      taskId,
      architecture,
      reordered,
      [],
      [annotations[0], { ...annotations[1], basis: 'proposed', rationale: 'Introduce this flow' }],
    );
    expect(revised.semanticRevision).toBe(first.semanticRevision + 1);
    expect(parseStoredGraphDocument(JSON.parse(JSON.stringify(revised)))).toEqual(revised);
    expect(() => parseStoredGraphDocument({ ...revised, annotations })).toThrow('content mismatch');
    expect(nextGraphDocument(taskId, architecture, revised).annotations).toEqual([]);
    const legacy = nextGraphDocument(taskId, architecture, null);
    const { annotations: _annotations, ...oldRecord } = legacy;
    expect(parseStoredGraphDocument(oldRecord)).toEqual(legacy);
  });

  it('rejects missing, duplicated, incorrectly typed and self-certified relationship bindings', () => {
    const annotation = {
      elementKind: 'edge',
      elementId: 'request',
      basis: 'inferred',
      rationale: 'Hypothesis',
    } as const;
    for (const annotations of [
      [annotation, annotation],
      [{ ...annotation, elementId: 'missing' }],
      [{ ...annotation, elementKind: 'node' as const }],
    ])
      expect(() => nextGraphDocument(taskId, architecture, null, [], annotations)).toThrow(
        'annotations',
      );
    const saved = nextGraphDocument(taskId, architecture, null, [], [annotation]);
    expect(() =>
      parseStoredGraphDocument({ ...saved, annotations: [{ ...annotation, basis: 'verified' }] }),
    ).toThrow();
    expect(() =>
      parseStoredGraphDocument({ ...saved, annotations: [{ ...annotation, rationale: '' }] }),
    ).toThrow();
  });

  it('keeps meaning across geometry, presentation and object/element ordering changes', () => {
    const changed = {
      ...architecture,
      meta: {
        quality_profile: 'showcase',
        title: 'Plan',
        animation: 'none',
        visual_preset: 'blueprint',
      },
      layout: { mode: 'grid', cols: 2 },
      components: [...architecture.components]
        .reverse()
        .map((node) => ({ ...node, pos: [180, 200], size: [200, 100] })),
      connections: architecture.connections.map((edge) => ({
        ...edge,
        route: 'auto',
        labelDx: 40,
      })),
    };
    expect(graphSemanticDigest(changed)).toBe(graphSemanticDigest(architecture));
    const first = nextGraphDocument(taskId, architecture, null);
    const redraw = nextGraphDocument(taskId, changed, first);
    expect(redraw).toMatchObject({
      id: first.id,
      semanticRevision: 1,
      renderRevision: 2,
      createdAt: first.createdAt,
    });
  });

  it('revises labels, relations and stable identities without guessing equivalence', () => {
    const digest = graphSemanticDigest(architecture);
    for (const diagram of [
      { ...architecture, meta: { title: 'Different plan' } },
      {
        ...architecture,
        components: architecture.components.map((node) => ({ ...node, label: 'Renamed' })),
      },
      {
        ...architecture,
        connections: [{ id: 'request', from: 'server', to: 'client', label: 'Request' }],
      },
      { ...architecture, connections: [] },
    ])
      expect(graphSemanticDigest(diagram)).not.toBe(digest);
    const first = nextGraphDocument(taskId, architecture, null);
    const second = nextGraphDocument(
      taskId,
      { ...architecture, meta: { title: 'New plan' } },
      first,
    );
    expect(second).toMatchObject({ semanticRevision: 2, renderRevision: 2 });
    expect(() => validateGraphDocumentWrite({ ...second, semanticRevision: 1 }, first, 1)).toThrow(
      'revision conflict',
    );
    expect(() => validateGraphDocumentWrite(second, first, 0)).toThrow('revision conflict');
    expect(() =>
      parseStoredGraphDocument({ ...second, semanticDigest: first.semanticDigest }),
    ).toThrow('content mismatch');
  });

  it('preserves workflow phase membership when layout columns move together', () => {
    const workflow = {
      schema_version: 2,
      diagram_type: 'workflow',
      meta: { title: 'Workflow' },
      lanes: [{ id: 'work', label: 'Work' }],
      phases: [{ id: 'implement', label: 'Implement', fromCol: 0, toCol: 1 }],
      nodes: [
        { id: 'a', type: 'backend', label: 'A', lane: 'work', col: 0 },
        { id: 'b', type: 'backend', label: 'B', lane: 'work', col: 2 },
      ],
      edges: [{ id: 'ab', from: 'a', to: 'b' }],
    };
    const shifted = {
      ...workflow,
      phases: [{ ...workflow.phases[0]!, fromCol: 1, toCol: 2 }],
      nodes: workflow.nodes.map((node) => ({ ...node, col: node.col + 1 })),
    };
    expect(graphSemanticDigest(shifted)).toBe(graphSemanticDigest(workflow));
    expect(
      graphSemanticDigest({
        ...workflow,
        nodes: workflow.nodes.map((node) => ({ ...node, col: node.col + 2 })),
      }),
    ).not.toBe(graphSemanticDigest(workflow));
  });
});

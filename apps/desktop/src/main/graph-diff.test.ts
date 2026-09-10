import { describe, expect, it } from 'vitest';
import { nextGraphDocument } from './graph-document';
import { compareGraphDocuments } from './graph-diff';

const taskId = '00000000-0000-4000-8000-000000000001';
const diagram = {
  schema_version: 1,
  diagram_type: 'architecture',
  meta: { title: 'Plan' },
  components: [
    { id: 'a', type: 'backend', label: 'Client', pos: [40, 40] },
    { id: 'b', type: 'backend', label: 'Server', pos: [260, 40] },
  ],
  connections: [{ id: 'ab', from: 'a', to: 'b', label: 'Request' }],
};

describe('saved graph comparison', () => {
  it('shows added, changed and removed relationship judgments as semantic changes', () => {
    const annotation = {
      elementKind: 'edge',
      elementId: 'ab',
      basis: 'inferred',
      rationale: 'Possible flow',
    } as const;
    const first = nextGraphDocument(taskId, diagram, null);
    const second = nextGraphDocument(taskId, diagram, first, [], [annotation]);
    expect(compareGraphDocuments(first, second).changes).toEqual([
      expect.objectContaining({ kind: 'annotation', id: 'edge:ab', action: 'added' }),
    ]);
    const third = nextGraphDocument(
      taskId,
      diagram,
      second,
      [],
      [{ ...annotation, basis: 'proposed' }],
    );
    expect(compareGraphDocuments(second, third)).toMatchObject({
      contentChanged: true,
      presentationOnly: false,
      changes: [
        {
          kind: 'annotation',
          id: 'edge:ab',
          action: 'changed',
          fields: [{ name: 'basis', before: 'inferred', after: 'proposed' }],
        },
      ],
    });
    const fourth = nextGraphDocument(taskId, diagram, third);
    expect(compareGraphDocuments(third, fourth).changes).toEqual([
      expect.objectContaining({ kind: 'annotation', id: 'edge:ab', action: 'removed' }),
    ]);
  });

  it('reports added/removed IDs, labels, directions and metadata with before/after values', () => {
    const first = nextGraphDocument(taskId, diagram, null);
    const second = nextGraphDocument(
      taskId,
      {
        ...diagram,
        meta: { title: 'Revised' },
        components: [
          { ...diagram.components[0]!, label: 'Gateway' },
          { id: 'c', type: 'backend', label: 'Store', pos: [480, 40] },
        ],
        connections: [{ id: 'ab', from: 'c', to: 'a', label: 'Response' }],
      },
      first,
    );
    const result = compareGraphDocuments(first, second);
    expect(result).toMatchObject({ contentChanged: true, presentationOnly: false });
    expect(result.changes.find((change) => change.id === 'a')).toMatchObject({
      kind: 'node',
      action: 'changed',
      fields: [{ name: 'label', before: 'Client', after: 'Gateway' }],
    });
    expect(result.changes.find((change) => change.id === 'b')).toMatchObject({
      kind: 'node',
      action: 'removed',
    });
    expect(result.changes.find((change) => change.id === 'c')).toMatchObject({
      kind: 'node',
      action: 'added',
    });
    expect(result.changes.find((change) => change.id === 'ab')?.fields).toEqual([
      { name: 'from', before: 'a', after: 'c' },
      { name: 'label', before: 'Request', after: 'Response' },
      { name: 'to', before: 'b', after: 'a' },
    ]);
    expect(result.changes.find((change) => change.id === 'meta')?.fields).toEqual([
      { name: 'title', before: 'Plan', after: 'Revised' },
    ]);
  });

  it('separates presentation-only updates and never infers identity from similar labels', () => {
    const first = nextGraphDocument(taskId, diagram, null);
    const moved = nextGraphDocument(
      taskId,
      { ...diagram, components: diagram.components.map((node) => ({ ...node, pos: [80, 100] })) },
      first,
    );
    expect(compareGraphDocuments(first, moved)).toMatchObject({
      contentChanged: false,
      presentationOnly: true,
      changes: [],
    });
    const replaced = nextGraphDocument(
      taskId,
      {
        ...diagram,
        components: diagram.components.map((node) => ({ ...node, id: `${node.id}new` })),
        connections: [{ id: 'abnew', from: 'anew', to: 'bnew', label: 'Request' }],
      },
      first,
    );
    const changes = compareGraphDocuments(first, replaced).changes;
    expect(changes.filter((change) => change.action === 'removed')).toHaveLength(3);
    expect(changes.filter((change) => change.action === 'added')).toHaveLength(3);
    expect(changes.filter((change) => change.action === 'changed')).toEqual([]);
  });

  it('refuses different tasks, graphs, reverse order and corrupted content', () => {
    const first = nextGraphDocument(taskId, diagram, null);
    const second = nextGraphDocument(taskId, { ...diagram, meta: { title: 'New' } }, first);
    expect(() => compareGraphDocuments(second, first)).toThrow();
    expect(() => compareGraphDocuments(first, { ...second, taskId: 'other' })).toThrow();
    expect(() =>
      compareGraphDocuments(first, { ...second, id: '00000000-0000-4000-8000-000000000002' }),
    ).toThrow();
    expect(() =>
      compareGraphDocuments(first, { ...second, semanticDigest: first.semanticDigest }),
    ).toThrow();
  });
});

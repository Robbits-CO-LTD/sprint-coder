import {
  graphDiffSchema,
  type GraphDiff,
  type GraphDocument,
  type GraphVersionSummary,
} from '@sprint-coder/contracts';
import {
  canonicalGraphJson,
  graphSemanticProjection,
  parseStoredGraphDocument,
} from './graph-document';

type Change = GraphDiff['changes'][number];

export function graphVersionSummary(document: GraphDocument): GraphVersionSummary {
  const { id, taskId, kind, title, semanticRevision, renderRevision, updatedAt } = document;
  return { id, taskId, kind, title, semanticRevision, renderRevision, updatedAt };
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function valueText(value: unknown): string | null {
  return value === undefined ? null : typeof value === 'string' ? value : canonicalGraphJson(value);
}

function fields(before: Record<string, unknown>, after: Record<string, unknown>): Change['fields'] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter((name) => canonicalGraphJson(before[name]) !== canonicalGraphJson(after[name]))
    .map((name) => ({ name, before: valueText(before[name]), after: valueText(after[name]) }));
}

function indexed(value: unknown): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const entry of Array.isArray(value) ? value : []) {
    const record = object(entry);
    const id = record['id'];
    if (typeof id !== 'string' || result.has(id))
      throw new Error('Ambiguous graph element identity');
    result.set(id, record);
  }
  return result;
}

export function compareGraphDocuments(oldValue: GraphDocument, newValue: GraphDocument): GraphDiff {
  const before = parseStoredGraphDocument(oldValue);
  const after = parseStoredGraphDocument(newValue);
  if (
    before.taskId !== after.taskId ||
    before.id !== after.id ||
    before.renderRevision >= after.renderRevision
  )
    throw new Error('Cannot compare unrelated or reversed graph versions');
  const changes: Change[] = [];
  const oldProjection = graphSemanticProjection(before.diagram);
  const newProjection = graphSemanticProjection(after.diagram);
  function add(
    kind: Change['kind'],
    id: string | null,
    oldRecord: Record<string, unknown> | undefined,
    newRecord: Record<string, unknown> | undefined,
  ) {
    const differences = fields(oldRecord ?? {}, newRecord ?? {});
    if (differences.length === 0) return;
    changes.push({
      kind,
      id,
      action: oldRecord === undefined ? 'added' : newRecord === undefined ? 'removed' : 'changed',
      beforeLabel: oldRecord ? valueText(oldRecord['label']) : null,
      afterLabel: newRecord ? valueText(newRecord['label']) : null,
      fields: differences,
    });
  }
  function compareRecords(kind: Change['kind'], oldRecords: unknown, newRecords: unknown) {
    const oldIndex = indexed(oldRecords);
    const newIndex = indexed(newRecords);
    for (const id of [...new Set([...oldIndex.keys(), ...newIndex.keys()])].sort()) {
      if (before.kind !== after.kind) {
        if (oldIndex.has(id)) add(kind, id, oldIndex.get(id), undefined);
        if (newIndex.has(id)) add(kind, id, undefined, newIndex.get(id));
      } else add(kind, id, oldIndex.get(id), newIndex.get(id));
    }
  }
  const oldNodeKey = before.kind === 'architecture' ? 'components' : 'nodes';
  const newNodeKey = after.kind === 'architecture' ? 'components' : 'nodes';
  const oldEdgeKey = before.kind === 'architecture' ? 'connections' : 'edges';
  const newEdgeKey = after.kind === 'architecture' ? 'connections' : 'edges';
  compareRecords('node', oldProjection[oldNodeKey], newProjection[newNodeKey]);
  compareRecords('edge', oldProjection[oldEdgeKey], newProjection[newEdgeKey]);
  for (const [key, kind] of [
    ['lanes', 'lane'],
    ['phases', 'phase'],
    ['groups', 'group'],
  ] as const)
    compareRecords(kind, oldProjection[key], newProjection[key]);
  add('diagram', 'meta', object(oldProjection['meta']), object(newProjection['meta']));
  const recordKeys = new Set([
    'components',
    'nodes',
    'connections',
    'edges',
    'lanes',
    'phases',
    'groups',
    'meta',
  ]);
  add(
    'diagram',
    'document',
    Object.fromEntries(Object.entries(oldProjection).filter(([key]) => !recordKeys.has(key))),
    Object.fromEntries(Object.entries(newProjection).filter(([key]) => !recordKeys.has(key))),
  );
  const sourceRecord = (source: GraphDocument['sources'][number]) => {
    const { observedAt: _observedAt, ...fields } = source;
    return { ...fields, label: `${source.path}:${source.lineStart}-${source.lineEnd}` };
  };
  compareRecords('source', before.sources.map(sourceRecord), after.sources.map(sourceRecord));
  const contentChanged = before.semanticDigest !== after.semanticDigest;
  return graphDiffSchema.parse({
    graphId: before.id,
    taskId: before.taskId,
    before: graphVersionSummary(before),
    after: graphVersionSummary(after),
    contentChanged,
    presentationOnly:
      !contentChanged && canonicalGraphJson(before.diagram) !== canonicalGraphJson(after.diagram),
    changes,
  });
}

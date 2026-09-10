import { createHash, randomUUID } from 'node:crypto';
import { graphDocumentSchema, type GraphDocument } from '@sprint-coder/contracts';
import { prepareGraphInput } from './graph-input';

export interface GraphDocumentStore {
  getGraphDocument(taskId: string): GraphDocument | null;
  saveGraphDocument(document: GraphDocument, expectedRenderRevision: number): GraphDocument;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function omit(value: unknown, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(object(value)).filter(([key]) => !keys.includes(key)));
}

function entries(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object) : [];
}

function byId(values: Record<string, unknown>[]): Record<string, unknown>[] {
  return values.sort((a, b) =>
    String(a['id']) < String(b['id']) ? -1 : String(a['id']) > String(b['id']) ? 1 : 0,
  );
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, stable(child)]),
    );
  return value;
}

/** The pinned IR's geometry is presentation; labels, relations and group membership are meaning.
 * Unknown fields stay in the digest rather than silently granting them layout-only status. */
export function graphSemanticDigest(diagram: Record<string, unknown>): string {
  const workflow = diagram['diagram_type'] === 'workflow';
  const nodeKey = workflow ? 'nodes' : 'components';
  const edgeKey = workflow ? 'edges' : 'connections';
  const nodes = entries(diagram[nodeKey]);
  const projection = {
    ...omit(diagram, ['layout']),
    meta: omit(diagram['meta'], ['animation', 'visual_preset', 'quality_profile', 'viewBox']),
    [nodeKey]: byId(
      nodes.map((node) => omit(node, ['pos', 'size', 'row', 'col', 'width', 'height', 'yOffset'])),
    ),
    [edgeKey]: byId(
      entries(diagram[edgeKey]).map((edge) =>
        omit(edge, [
          'fromSide',
          'toSide',
          'route',
          'via',
          'labelAt',
          'labelDx',
          'labelDy',
          'labelSegment',
          'channelX',
          'channelY',
          'bias',
          'width',
        ]),
      ),
    ),
  };
  if (workflow) {
    for (const key of ['lanes', 'phases', 'groups']) {
      if (!(key in diagram)) continue;
      projection[key] = byId(
        entries(diagram[key]).map((entry) =>
          key === 'lanes'
            ? entry
            : {
                ...omit(entry, ['fromCol', 'toCol']),
                members: nodes
                  .filter(
                    (node) =>
                      typeof node['col'] === 'number' &&
                      typeof entry['fromCol'] === 'number' &&
                      typeof entry['toCol'] === 'number' &&
                      node['col'] >= entry['fromCol'] &&
                      node['col'] <= entry['toCol'] &&
                      (key === 'phases' || node['lane'] === entry['lane']),
                  )
                  .map((node) => node['id'])
                  .sort(),
              },
        ),
      );
    }
  } else if ('boundaries' in diagram) {
    projection['boundaries'] = entries(diagram['boundaries']).map((boundary) =>
      omit(boundary, ['pad']),
    );
  }
  return createHash('sha256')
    .update(JSON.stringify(stable(projection)))
    .digest('hex');
}

export function nextGraphDocument(
  taskId: string,
  diagram: Record<string, unknown>,
  prior: GraphDocument | null,
): GraphDocument {
  const input = prepareGraphInput({ taskId, diagram });
  const digest = graphSemanticDigest(input.diagram);
  const now = new Date().toISOString();
  return graphDocumentSchema.parse({
    id: prior?.id ?? randomUUID(),
    taskId,
    kind: input.kind,
    title: input.title,
    semanticRevision: (prior?.semanticRevision ?? 0) + (prior?.semanticDigest === digest ? 0 : 1),
    renderRevision: (prior?.renderRevision ?? 0) + 1,
    semanticDigest: digest,
    diagram: input.diagram,
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
  });
}

export function parseStoredGraphDocument(value: unknown): GraphDocument {
  const document = graphDocumentSchema.parse(value);
  const input = prepareGraphInput({ taskId: document.taskId, diagram: document.diagram });
  if (
    document.kind !== input.kind ||
    document.title !== input.title ||
    document.semanticDigest !== graphSemanticDigest(input.diagram) ||
    document.semanticRevision > document.renderRevision
  )
    throw new Error('Graph document content mismatch');
  return document;
}

export function validateGraphDocumentWrite(
  document: GraphDocument,
  prior: GraphDocument | null,
  expectedRenderRevision: number,
): GraphDocument {
  const parsed = graphDocumentSchema.parse(document);
  const expected = nextGraphDocument(parsed.taskId, parsed.diagram, prior);
  if (
    (prior?.renderRevision ?? 0) !== expectedRenderRevision ||
    parsed.renderRevision !== expected.renderRevision ||
    parsed.semanticRevision !== expected.semanticRevision ||
    parsed.semanticDigest !== expected.semanticDigest ||
    parsed.kind !== expected.kind ||
    parsed.title !== expected.title ||
    (prior !== null && (parsed.id !== prior.id || parsed.createdAt !== prior.createdAt))
  )
    throw new Error('Graph document revision conflict');
  return parsed;
}

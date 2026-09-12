import { z } from 'zod';
import { graphRenderInputSchema } from '@sprint-coder/contracts';

export const ARCHIFY_REVISION = 'ed7f4d4b48d4424d36edfed8043de3de8dea6b45';
export const ARCHIFY_MANIFEST_SHA256 =
  'faea7dbaa8623e066779ccb9cd916a2f8bcd8262d552fedbd64b77d6d9eb707d';

export type PreparedGraphInput = Readonly<{
  taskId: string;
  kind: 'architecture' | 'workflow';
  title: string;
  diagram: Record<string, unknown>;
  nodeIds: readonly string[];
  edgeIds: readonly string[];
}>;

const ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u;
const forbidden = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'brand',
  'repository',
  'source',
  'sources',
  'output',
  'template',
  'repo_root',
]);

export function prepareGraphInput(input: unknown): PreparedGraphInput {
  const parsed = graphRenderInputSchema.parse(input);
  let values = 0;
  const inspect = (value: unknown, depth: number): void => {
    if (++values > 20_000 || depth > 12) throw new Error('Graph input exceeds its bounds');
    if (typeof value === 'string' && value.length > 4_000)
      throw new Error('Graph text exceeds its bounds');
    if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > 100_000))
      throw new Error('Invalid graph coordinate');
    if (Array.isArray(value)) {
      if (value.length > 256) throw new Error('Graph collection exceeds its bounds');
      value.forEach((child) => inspect(child, depth + 1));
    } else if (value !== null && typeof value === 'object') {
      if (Object.keys(value).length > 64) throw new Error('Graph object exceeds its bounds');
      for (const [key, child] of Object.entries(value)) {
        if (forbidden.has(key))
          throw new Error('Graph external resources and output paths are not permitted');
        inspect(child, depth + 1);
      }
    }
  };
  inspect(parsed.diagram, 0);
  if (Buffer.byteLength(JSON.stringify(parsed.diagram)) > 256 * 1024)
    throw new Error('Graph input is too large');
  const kind = parsed.diagram['diagram_type'];
  if (kind !== 'architecture' && kind !== 'workflow') throw new Error('Unsupported graph kind');
  const meta = z
    .object({ title: z.string().min(1).max(160) })
    .passthrough()
    .parse(parsed.diagram['meta']);
  const nodeKey = kind === 'architecture' ? 'components' : 'nodes';
  const edgeKey = kind === 'architecture' ? 'connections' : 'edges';
  const nodes = z
    .array(z.object({ id: z.string().regex(ID) }).passthrough())
    .min(1)
    .max(64)
    .parse(parsed.diagram[nodeKey]);
  const edges = z
    .array(
      z
        .object({ id: z.string().regex(ID), from: z.string().regex(ID), to: z.string().regex(ID) })
        .passthrough(),
    )
    .max(192)
    .parse(parsed.diagram[edgeKey] ?? []);
  const nodeIds = nodes.map(({ id }) => id);
  const edgeIds = edges.map(({ id }) => id);
  if (
    new Set([...nodeIds, ...edgeIds]).size !== nodeIds.length + edgeIds.length ||
    edges.some(({ from, to }) => !nodeIds.includes(from) || !nodeIds.includes(to))
  )
    throw new Error('Invalid graph element identities');
  const diagram = {
    ...parsed.diagram,
    meta: {
      ...meta,
      quality_profile: meta['quality_profile'] === undefined ? 'standard' : meta['quality_profile'],
    },
  };
  return { taskId: parsed.taskId, kind, title: meta.title, diagram, nodeIds, edgeIds };
}

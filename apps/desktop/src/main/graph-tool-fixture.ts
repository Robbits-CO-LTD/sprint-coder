import { z } from 'zod';
import { graphDocumentSchema } from '@sprint-coder/contracts';
import type { ModelSampler } from './intelligence-loop';

export const GRAPH_TOOL_FIXTURE_MARKER = '[fixture:graph-proposal]';
export function isGraphToolFixture(input: string, environment = process.env): boolean {
  return (
    environment['SPRINT_CODER_E2E_GRAPH_FIXTURE'] === '1' && input === GRAPH_TOOL_FIXTURE_MARKER
  );
}

/** An explicit Mock-only model response script; all tool execution remains on the real harness. */
export const graphToolFixtureSampler: ModelSampler = ({ transcript }) => {
  const result = (callId: string): unknown => {
    const item = transcript.find(
      (entry) => entry.type === 'tool-result' && entry.callId === callId,
    );
    if (!item || item.type !== 'tool-result') return undefined;
    if (item.isError) throw new Error('Graph fixture tool failed');
    return JSON.parse(item.content);
  };
  const initial = result('graph-fixture-read');
  if (initial === undefined)
    return {
      kind: 'tool-calls',
      calls: [{ callId: 'graph-fixture-read', toolName: 'graph_read_document', arguments: {} }],
    };
  const before = z.object({ document: graphDocumentSchema.nullable() }).parse(initial);
  const published = result('graph-fixture-propose');
  if (published === undefined)
    return {
      kind: 'tool-calls',
      calls: [
        {
          callId: 'graph-fixture-propose',
          toolName: 'graph_propose_document',
          arguments: {
            expectedRenderRevision: before.document?.renderRevision ?? 0,
            diagram: {
              schema_version: 1,
              diagram_type: 'architecture',
              meta: { title: 'Graph tool proposal' },
              components: ['client', 'api', 'store'].map((id, index) => ({
                id,
                type: 'backend',
                label: id,
                pos: [40 + index * 220, 40],
              })),
              connections: [
                { id: 'request', from: 'client', to: 'api' },
                { id: 'persist', from: 'api', to: 'store' },
              ],
              cards: [],
            },
          },
        },
      ],
    };
  const saved = z
    .object({
      graphId: z.string().uuid(),
      renderRevision: z.number().int().positive(),
      phase: z.literal('draft'),
      executionStarted: z.literal(false),
    })
    .parse(published);
  const readback = result('graph-fixture-verify');
  if (readback === undefined)
    return {
      kind: 'tool-calls',
      calls: [
        {
          callId: 'graph-fixture-verify',
          toolName: 'graph_read_document',
          arguments: { renderRevision: saved.renderRevision },
        },
      ],
    };
  const checked = z
    .object({
      document: graphDocumentSchema,
      sourceEvidence: z.literal('unverified'),
      executionStarted: z.literal(false),
    })
    .parse(readback);
  if (
    checked.document.id !== saved.graphId ||
    checked.document.title !== 'Graph tool proposal' ||
    checked.document.renderRevision !== saved.renderRevision
  )
    throw new Error('Graph fixture readback did not match the saved proposal');
  return {
    kind: 'final',
    text: 'GRAPH_TOOL_FLOW_OK: 図案を保存しました。グラフから確認できます。実行は開始していません。',
  };
};

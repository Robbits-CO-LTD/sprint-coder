import { z } from 'zod';
import type { ModelSampler } from './intelligence-loop';

export const GRAPH_TOOL_FIXTURE_MARKER = '[fixture:graph-proposal]';
export const GRAPH_SOURCE_FIXTURE_MARKER = '[fixture:graph-source-proposal]';
export function isGraphToolFixture(input: string, environment = process.env): boolean {
  return (
    environment['SPRINT_CODER_E2E_GRAPH_FIXTURE'] === '1' &&
    [GRAPH_TOOL_FIXTURE_MARKER, GRAPH_SOURCE_FIXTURE_MARKER].includes(input)
  );
}

/** An explicit Mock-only model response script; all tool execution remains on the real harness. */
export const createGraphToolFixtureSampler =
  (withSource: boolean): ModelSampler =>
  ({ transcript }) => {
    const result = (callId: string): unknown => {
      const item = transcript.find(
        (entry) => entry.type === 'tool-result' && entry.callId === callId,
      );
      if (!item || item.type !== 'tool-result') return undefined;
      if (item.isError) throw new Error('Graph fixture tool failed');
      return JSON.parse(item.content);
    };
    const file = result('graph-fixture-file');
    if (withSource && file === undefined)
      return {
        kind: 'tool-calls',
        calls: [
          {
            callId: 'graph-fixture-file',
            toolName: 'read_file',
            arguments: { path: 'graph-source.ts', lineStart: 1, lineEnd: 3 },
          },
        ],
      };
    const source = withSource
      ? z.object({ revision: z.object({ tokenId: z.string().uuid() }) }).parse(file)
      : null;
    const initial = result('graph-fixture-read');
    if (initial === undefined)
      return {
        kind: 'tool-calls',
        calls: [{ callId: 'graph-fixture-read', toolName: 'graph_read_document', arguments: {} }],
      };
    const before = z
      .object({ document: z.object({ renderRevision: z.number().int().positive() }).nullable() })
      .parse(initial);
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
              annotations: source
                ? []
                : [
                    {
                      elementKind: 'node',
                      elementId: 'api',
                      basis: 'inferred',
                      rationale: 'APIの役割は推定です。',
                    },
                    {
                      elementKind: 'node',
                      elementId: 'store',
                      basis: 'proposed',
                      rationale: '保存先の追加を提案します。',
                    },
                    {
                      elementKind: 'edge',
                      elementId: 'persist',
                      basis: 'proposed',
                      rationale: '保存処理を追加する案です。',
                    },
                  ],
              sources: source
                ? [
                    {
                      kind: 'read',
                      tokenId: source.revision.tokenId,
                      elementKind: 'node',
                      elementId: 'api',
                      lineStart: 1,
                      lineEnd: 3,
                    },
                  ]
                : [],
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
        document: z.object({
          id: z.string().uuid(),
          title: z.string(),
          renderRevision: z.number().int().positive(),
          sources: z.array(z.object({ id: z.string().uuid(), path: z.string() })),
          annotations: z.array(
            z.object({
              elementKind: z.enum(['node', 'edge']),
              elementId: z.string(),
              basis: z.enum(['inferred', 'proposed']),
              rationale: z.string(),
            }),
          ),
        }),
        sourceEvidence: z.literal(withSource ? 'snapshot-references' : 'unverified'),
        executionStarted: z.literal(false),
      })
      .parse(readback);
    if (
      checked.document.id !== saved.graphId ||
      checked.document.title !== 'Graph tool proposal' ||
      checked.document.renderRevision !== saved.renderRevision
    )
      throw new Error('Graph fixture readback did not match the saved proposal');
    if (withSource && !checked.document.sources.some((entry) => entry.path === 'graph-source.ts'))
      throw new Error('Source fixture was not bound');
    if (
      !withSource &&
      !checked.document.annotations.some(
        (entry) => entry.elementId === 'api' && entry.basis === 'inferred',
      )
    )
      throw new Error('Relationship annotation was not saved');
    return {
      kind: 'final',
      text: 'GRAPH_TOOL_FLOW_OK: 図案を保存しました。グラフから確認できます。実行は開始していません。',
    };
  };

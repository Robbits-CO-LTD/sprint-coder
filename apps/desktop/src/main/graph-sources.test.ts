import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, rename, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { GraphReadReceipts, bindGraphSources, graphDocumentForModel } from './graph-sources';
import { FileRevisionRegistry } from './file-revision';
import { createPathGuard, revalidatePathGuard } from './path-guard';
import { assessProviderDisclosure } from './provider-disclosure-classifier';
import { nextGraphDocument } from './graph-document';
import { previewGraphSource } from './graph-source-preview';
import { compareGraphDocuments } from './graph-diff';
import type { GraphSourceRequest } from '@sprint-coder/contracts';

const roots: string[] = [];
const context = { taskId: 'task-a', turnId: 'turn-a', workspaceId: 'workspace', policyEpoch: 1 };
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(text: string, lines?: { start: number; end: number }) {
  const root = await mkdtemp(join(tmpdir(), 'sc-graph-sources-'));
  roots.push(root);
  await writeFile(join(root, 'code.ts'), text);
  const guard = await createPathGuard({
    workspacePath: root,
    rootId: 'root-a',
    targetPath: 'code.ts',
    operation: 'read',
  });
  const registry = new FileRevisionRegistry();
  const read = await registry.readGuarded({ owner: context, guard, policyEpoch: 1 });
  const observed = registry.observed({ owner: context, reference: read.reference, policyEpoch: 1 });
  const disclosed = assessProviderDisclosure(read.content, 'code.ts').redactedContent;
  const returned = lines
    ? disclosed
        .split('\n')
        .slice(lines.start - 1, lines.end)
        .join('\n')
    : disclosed;
  const receipts = new GraphReadReceipts();
  receipts.record({
    context,
    workspaceDigest: 'workspace',
    guard,
    observed,
    disclosed,
    returned,
    range: lines
      ? { unit: 'line', ...lines }
      : { unit: 'byte', start: 0, end: Buffer.byteLength(disclosed) },
    observedAt: '2026-09-11T00:00:00Z',
  });
  const request = (start: number, end = start): GraphSourceRequest => ({
    kind: 'read',
    tokenId: read.reference.tokenId,
    elementKind: 'node',
    elementId: 'api',
    lineStart: start,
    lineEnd: end,
  });
  return { root, receipts, guard, registry, read, request };
}
const diagram = {
  schema_version: 1,
  diagram_type: 'architecture',
  meta: { title: 'Sources' },
  components: [{ id: 'api', type: 'backend', label: 'API', pos: [40, 40] }],
  connections: [],
};

describe('Main-owned graph source snapshots', () => {
  it('keeps source IDs across rereads while revising changed bytes and rejecting dangling element links', async () => {
    const { receipts, request } = await fixture('original\n');
    const original = receipts.resolve([request(1)], context, 'workspace')[0]!;
    const first = nextGraphDocument(context.taskId, diagram, null, [original]);
    const again = { ...original, observedAt: '2026-09-11T01:00:00Z' };
    const same = nextGraphDocument(context.taskId, diagram, first, [again]);
    expect(same.semanticRevision).toBe(first.semanticRevision);
    expect(compareGraphDocuments(first, same).changes).toEqual([]);
    const updated = {
      ...again,
      contentHash: createHash('sha256').update('updated\n').digest('hex'),
      excerpt: 'updated',
      excerptHash: createHash('sha256').update('updated').digest('hex'),
    };
    const sources = bindGraphSources([request(1)], [updated], first);
    expect(sources[0]!.id).toBe(original.id);
    const revised = nextGraphDocument(context.taskId, diagram, first, sources);
    expect(revised.semanticRevision).toBe(first.semanticRevision + 1);
    expect(compareGraphDocuments(first, revised).changes).toContainEqual(
      expect.objectContaining({ kind: 'source', action: 'changed' }),
    );
    expect(() =>
      nextGraphDocument(context.taskId, diagram, first, [{ ...original, elementId: 'absent' }]),
    ).toThrow();
  });
  it('binds disclosed lines and raw-byte hashes, including BOM/CRLF, without persisting tokens', async () => {
    const text = '\uFEFFone\r\ntwo\r\nthree\r\n';
    const { receipts, request, registry, read } = await fixture(text, { start: 2, end: 3 });
    const [source] = receipts.resolve([request(2)], context, 'workspace');
    expect(source).toMatchObject({
      path: 'code.ts',
      excerpt: 'two\r',
      lineStart: 2,
      contentHash: createHash('sha256').update(text).digest('hex'),
    });
    expect(source).not.toHaveProperty('tokenId');
    const edge = receipts.resolve(
      [
        {
          kind: 'read',
          tokenId: read.reference.tokenId,
          elementKind: 'edge',
          elementId: 'call',
          lineStart: 2,
          lineEnd: 2,
        },
      ],
      context,
      'workspace',
    );
    expect(
      nextGraphDocument(
        context.taskId,
        {
          ...diagram,
          components: [
            ...diagram.components,
            { id: 'db', type: 'backend', label: 'DB', pos: [260, 40] },
          ],
          connections: [{ id: 'call', from: 'api', to: 'db' }],
        },
        null,
        edge,
      ).sources[0],
    ).toMatchObject({ elementKind: 'edge', elementId: 'call' });
    expect(() => receipts.resolve([request(1)], context, 'workspace')).toThrow('delivered read');
    expect(() =>
      receipts.resolve([request(2)], { ...context, turnId: 'other' }, 'workspace'),
    ).toThrow();
    expect(() => receipts.resolve([request(2)], context, 'other-workspace')).toThrow();
    expect(() =>
      registry.observed({ owner: context, reference: read.reference, policyEpoch: 2 }),
    ).toThrow();
    receipts.finishTurn(context.taskId, context.turnId);
    expect(() => receipts.resolve([request(2)], context, 'workspace')).toThrow();
  });

  it('rejects redacted lines and does not replay excerpt/hash data through graph_read_document', async () => {
    const { receipts, request } = await fixture(
      'export const visible = 1;\npassword="secret-value-123";\nexport const tail = 2;',
    );
    const sources = receipts.resolve([request(1), request(3)], context, 'workspace');
    expect(() => receipts.resolve([request(2)], context, 'workspace')).toThrow('disclosed code');
    const annotations = [
      {
        elementKind: 'node',
        elementId: 'api',
        basis: 'inferred',
        rationale: 'The role remains a hypothesis',
      },
    ] as const;
    const document = nextGraphDocument(context.taskId, diagram, null, sources, annotations);
    expect(graphDocumentForModel(document)).toMatchObject({ annotations });
    const output = JSON.stringify(graphDocumentForModel(document));
    expect(output).not.toContain('excerpt');
    expect(output).not.toContain('contentHash');
    expect(output).not.toContain('export const');
    expect(output).not.toContain('secret-value');
    const retained = bindGraphSources([{ kind: 'saved', sourceId: sources[0]!.id }], [], document);
    expect(retained).toEqual([sources[0]]);
    expect(() =>
      bindGraphSources([{ kind: 'saved', sourceId: sources[0]!.id }], [], null),
    ).toThrow();
  });

  it('separates current/changed/root-replaced/missing source content without modifying the saved snapshot', async () => {
    const { root, receipts, request, guard } = await fixture('before\n');
    const source = receipts.resolve([request(1)], context, 'workspace')[0]!;
    expect((await previewGraphSource(source, root, 1)).status).toBe('current');
    await writeFile(join(root, 'code.ts'), 'after\n');
    expect(await previewGraphSource(source, root, 1)).toMatchObject({
      status: 'changed',
      currentExcerpt: 'after',
      source: { excerpt: 'before' },
    });
    await rm(join(root, 'code.ts'));
    expect((await previewGraphSource(source, root, 1)).status).toBe('missing');
    const moved = `${root}-old`;
    roots.push(moved);
    await rename(root, moved);
    await mkdir(root);
    expect((await previewGraphSource(source, root, 1)).status).toBe('root_changed');
    await expect(revalidatePathGuard(guard)).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a source that is replaced with an escaping symlink',
    async () => {
      const { root, receipts, request } = await fixture('safe\n');
      const source = receipts.resolve([request(1)], context, 'workspace')[0]!;
      const outside = await mkdtemp(join(tmpdir(), 'sc-graph-outside-'));
      roots.push(outside);
      await writeFile(join(outside, 'private.txt'), 'not disclosed');
      await rm(join(root, 'code.ts'));
      await symlink(join(outside, 'private.txt'), join(root, 'code.ts'));
      expect(await previewGraphSource(source, root, 1)).toMatchObject({
        status: 'unavailable',
        currentExcerpt: null,
      });
    },
  );
});

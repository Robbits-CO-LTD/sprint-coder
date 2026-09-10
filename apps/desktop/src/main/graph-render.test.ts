import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { GraphRenderService } from './graph-render';
import { prepareGraphInput } from './graph-input';
import { prepareGraphHtml, trustedArchifyScripts } from './graph-html';
import { validateGraphDocumentWrite, type GraphDocumentStore } from './graph-document';
import type { GraphDocument } from '@sprint-coder/contracts';

const roots: string[] = [];
const vendorRoot = resolve('vendor/archify');
const execute = promisify(execFile);
const taskId = '00000000-0000-4000-8000-000000000001';
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function diagram(kind: 'architecture' | 'workflow') {
  const nodes = ['client', 'api', 'store'].map((id, i) => ({
    id,
    type: 'backend',
    label: id,
    ...(kind === 'architecture' ? { pos: [40 + i * 220, 40] } : { lane: 'steps', col: i }),
  }));
  const edges = [
    { id: 'request', from: 'client', to: 'api' },
    { id: 'persist', from: 'api', to: 'store' },
  ];
  return {
    schema_version: kind === 'workflow' ? 2 : 1,
    diagram_type: kind,
    meta: { title: 'Graph fixture' },
    cards: [],
    ...(kind === 'architecture'
      ? { components: nodes, connections: edges }
      : { nodes, edges, lanes: [{ id: 'steps', label: 'Steps' }] }),
  };
}

describe('Archify generation boundary', () => {
  it.each(['architecture', 'workflow'] as const)(
    'renders and independently checks the pinned %s renderer',
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), 'sc-graph-test-'));
      roots.push(root);
      const documents = new Map<string, GraphDocument>();
      const history = new Map<string, GraphDocument[]>();
      const store: GraphDocumentStore = {
        getGraphDocument: (id) => structuredClone(documents.get(id) ?? null),
        getGraphDocumentVersion: (id, revision) =>
          structuredClone(history.get(id)?.find((doc) => doc.renderRevision === revision) ?? null),
        listGraphDocumentVersions: (id, limit = 25, before = Number.MAX_SAFE_INTEGER) =>
          structuredClone(
            (history.get(id) ?? [])
              .filter((doc) => doc.renderRevision < before)
              .slice()
              .reverse()
              .slice(0, limit),
          ),
        saveGraphDocument: (document, expected) => {
          const saved = validateGraphDocumentWrite(
            document,
            documents.get(document.taskId) ?? null,
            expected,
          );
          documents.set(document.taskId, saved);
          history.set(document.taskId, [...(history.get(document.taskId) ?? []), saved]);
          return saved;
        },
      };
      const createService = () =>
        new GraphRenderService({
          store,
          vendorRoot,
          workRoot: root,
          workerPath: '/unused',
          parentOrigin: 'app://bundle',
          run: async (mode, input, directory) => {
            const entry =
              mode === 'render'
                ? join(vendorRoot, 'renderers', input.kind, `render-${input.kind}.mjs`)
                : join(vendorRoot, 'scripts', 'check-render-output.mjs');
            const paths =
              mode === 'render'
                ? [join(directory, 'input.json'), join(directory, 'diagram.html')]
                : [join(directory, 'diagram.html')];
            return (
              await execute(process.execPath, [entry, ...paths], {
                timeout: 15_000,
                maxBuffer: 256 * 1024,
                env: { ARCHIFY_UPDATE_CHECK_DISABLED: '1' },
              })
            ).stdout;
          },
        });
      const service = createService();
      const view = await service.render({ taskId, diagram: diagram(kind) });
      expect(view.nodeIds).toEqual(['client', 'api', 'store']);
      expect(service.history({ taskId }).versions).toMatchObject([
        { renderRevision: 1, semanticRevision: 1 },
      ]);
      expect(() =>
        service.compare({ taskId, beforeRenderRevision: 1, afterRenderRevision: 2 }),
      ).toThrow('not found');
      const response = service.response(new URL(view.artifactUrl));
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Security-Policy')).toContain("connect-src 'none'");
      expect(response.headers.get('Content-Security-Policy')).not.toContain(
        "script-src 'unsafe-inline'",
      );
      const html = await response.text();
      expect(html).toContain('data-node-id="client"');
      expect(html).toContain('sprint-graph-selection');
      await expect(
        service.render({
          taskId,
          diagram: { ...diagram(kind), meta: { title: 'unsafe', output: '/outside.html' } },
        }),
      ).rejects.toThrow();
      const reopened = (await service.get(taskId))!;
      expect(reopened).toMatchObject({
        id: view.id,
        revision: view.revision,
        viewRevision: view.viewRevision + 1,
      });
      expect(service.response(new URL(view.artifactUrl)).status).toBe(404);
      service.release(taskId, view.instanceId);
      expect(service.response(new URL(reopened.artifactUrl)).status).toBe(200);
      service.release(taskId, reopened.instanceId);
      expect(service.response(new URL(reopened.artifactUrl)).status).toBe(404);
      expect(service.response(new URL(`${view.artifactUrl}?arbitrary=1`)).status).toBe(404);
      service.dispose();
      expect(service.response(new URL(view.artifactUrl)).status).toBe(404);
      const afterRestart = createService();
      const [earlierRestore, restored] = await Promise.all([
        afterRestart.get(taskId),
        afterRestart.get(taskId),
      ]);
      expect(earlierRestore).not.toBeNull();
      expect(restored).not.toBeNull();
      expect(restored).toMatchObject({ id: view.id, revision: view.revision, digest: view.digest });
      expect(restored!.instanceId).not.toBe(view.instanceId);
      expect(afterRestart.response(new URL(earlierRestore!.artifactUrl)).status).toBe(404);
      expect(afterRestart.response(new URL(restored!.artifactUrl)).status).toBe(200);
      expect(store.getGraphDocument(taskId)?.renderRevision).toBe(1);
      afterRestart.dispose();
    },
  );

  it('rejects external-resource and output controls before invoking Archify', () => {
    expect(
      prepareGraphInput({
        taskId,
        diagram: {
          ...diagram('architecture'),
          meta: { title: 'Strict graph', quality_profile: 'showcase' },
        },
      }).diagram,
    ).toMatchObject({ meta: { quality_profile: 'showcase' } });
    for (const field of ['output', 'repository', 'brand', 'source']) {
      expect(() =>
        prepareGraphInput({
          taskId,
          diagram: {
            ...diagram('architecture'),
            meta: { title: 'bad', [field]: 'https://example.com' },
          },
        }),
      ).toThrow();
    }
    const invalid = diagram('architecture');
    expect(() =>
      prepareGraphInput({
        taskId,
        diagram: { ...invalid, connections: [{ id: 'missing', from: 'client', to: 'absent' }] },
      }),
    ).toThrow();
  });

  it('refuses executable HTML that did not come from the pinned viewer', async () => {
    const template = await readFile(join(vendorRoot, 'assets/template.html'), 'utf8');
    const scripts = trustedArchifyScripts(template);
    const binding = {
      graphId: taskId,
      revision: 1,
      instanceId: taskId,
      parentOrigin: 'app://bundle',
    };
    for (const injection of [
      '<script>alert(1)</script>',
      '<img src="https://example.com/x">',
      '<svg onload="alert(1)"></svg>',
      '<iframe src="https://example.com"></iframe>',
    ]) {
      expect(() =>
        prepareGraphHtml(template.replace('</body>', `${injection}</body>`), scripts, binding),
      ).toThrow();
    }
  });
});

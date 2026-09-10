import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { utilityProcess, type UtilityProcess } from 'electron';
import { z } from 'zod';
import type {
  GraphDocument,
  GraphView,
  GraphGeneration,
  GraphRenderInput,
  GraphSourceRef,
} from '@sprint-coder/contracts';
import {
  graphHistoryInputSchema,
  graphHistorySchema,
  graphCompareInputSchema,
  graphRenderInputSchema,
  type GraphHistory,
  type GraphDiff,
} from '@sprint-coder/contracts';
import { ARCHIFY_MANIFEST_SHA256, prepareGraphInput, type PreparedGraphInput } from './graph-input';
import { prepareGraphHtml, trustedArchifyScripts } from './graph-html';
import { nextGraphDocument, type GraphDocumentStore } from './graph-document';
import { compareGraphDocuments, graphVersionSummary } from './graph-diff';
import { graphGenerationActive } from './graph-generation';
import { secureLogger } from './secure-logger';

type StoredGraph = {
  document: GraphDocument;
  view: GraphView;
  rawHtml: string;
  response: { html: string; csp: string };
  live: boolean;
};
type Run = (
  mode: 'render' | 'check',
  input: PreparedGraphInput,
  directory: string,
  signal: AbortSignal,
) => Promise<string>;
type RunningGraph = { controller: AbortController; done: Promise<void>; generationId?: string };

export class GraphRenderService {
  private readonly documents = new Map<string, StoredGraph>();
  private readonly running = new Map<string, RunningGraph>();
  private readonly generationListeners = new Set<(value: GraphGeneration) => void>();
  private closed = false;
  private readonly restoring = new Map<string, Promise<GraphView>>();
  private scripts: readonly string[] | null = null;
  private readonly run: Run;

  constructor(
    private readonly options: {
      vendorRoot: string;
      workRoot: string;
      workerPath: string;
      parentOrigin: string;
      store: GraphDocumentStore;
      run?: Run;
    },
  ) {
    this.run =
      options.run ??
      ((mode, input, directory, signal) => this.runUtility(mode, input, directory, signal));
  }

  async render(
    raw: unknown,
    options: {
      expectedRenderRevision?: number;
      signal?: AbortSignal;
      sources?: readonly GraphSourceRef[];
    } = {},
  ): Promise<GraphView> {
    options.signal?.throwIfAborted();
    const input = graphRenderInputSchema.parse(raw);
    const prior = this.options.store.getGraphDocument(input.taskId);
    if (
      options.expectedRenderRevision !== undefined &&
      (prior?.renderRevision ?? 0) !== options.expectedRenderRevision
    )
      throw new Error('Graph version changed; read the current document before proposing again');
    return this.generate(input, prior, true, options.signal, options.sources);
  }

  private async generate(
    raw: GraphRenderInput,
    priorDocument: GraphDocument | null,
    save: boolean,
    signal?: AbortSignal,
    sources: readonly GraphSourceRef[] = [],
  ): Promise<GraphView> {
    if (this.closed) throw new Error('Graph renderer is closed');
    const taskId = raw.taskId;
    if (this.running.has(taskId) || this.running.size >= 2)
      throw new Error('Graph renderer is busy');
    if (!this.documents.has(taskId) && this.documents.size >= 32) {
      const expired = [...this.documents].find(([, record]) => !record.live);
      if (expired) this.documents.delete(expired[0]);
    }
    if (!this.documents.has(taskId) && this.documents.size >= 32)
      throw new Error('Graph session capacity reached');
    const controller = new AbortController();
    let settled!: () => void;
    const operation: RunningGraph = {
      controller,
      done: new Promise<void>((resolve) => {
        settled = resolve;
      }),
    };
    this.running.set(taskId, operation);
    const onAbort = () => {
      if (this.running.get(taskId) !== operation) return;
      try {
        this.cancel(taskId, operation.generationId);
      } catch {
        controller.abort();
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    let stage: NonNullable<GraphGeneration['failureStage']> = 'input';
    let directory: string | undefined;
    try {
      if (save) {
        const title = z
          .object({ title: z.string().min(1).max(160) })
          .safeParse(raw.diagram['meta']);
        const generation = this.options.store.beginGraphGeneration(
          taskId,
          title.success ? title.data.title : null,
          priorDocument?.renderRevision ?? 0,
        );
        operation.generationId = generation.id;
        this.notifyGeneration(generation);
      }
      controller.signal.throwIfAborted();
      const input = prepareGraphInput(raw);
      const document = save
        ? nextGraphDocument(taskId, input.diagram, priorDocument, sources)
        : priorDocument;
      if (!document) throw new Error('Graph document is unavailable');
      stage = 'engine';
      await this.verifyVendor();
      stage = 'render';
      await mkdir(this.options.workRoot, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(this.options.workRoot, 'render-'));
      await writeFile(join(directory, 'input.json'), JSON.stringify(input.diagram), {
        mode: 0o600,
        flag: 'wx',
      });
      await this.run('render', input, directory, controller.signal);
      stage = 'check';
      const checker = await this.run('check', input, directory, controller.signal);
      const report = z
        .object({
          ok: z.literal(true),
          checks: z
            .array(z.object({ ok: z.literal(true) }).passthrough())
            .min(9)
            .max(32),
        })
        .passthrough()
        .parse(JSON.parse(checker));
      if (!report.ok) throw new Error('Graph output was rejected');
      const path = join(directory, 'diagram.html');
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size > 4 * 1024 * 1024
      )
        throw new Error('Graph output is unsafe');
      const rawHtml = await readFile(path, 'utf8');
      controller.signal.throwIfAborted();
      const prior = this.documents.get(input.taskId);
      const instanceId = randomUUID();
      const view: GraphView = {
        id: document.id,
        taskId: input.taskId,
        revision: document.semanticRevision,
        renderRevision: document.renderRevision,
        title: input.title,
        kind: input.kind,
        digest: document.semanticDigest,
        instanceId,
        viewRevision: (prior?.view.viewRevision ?? 0) + 1,
        artifactUrl: `app://graph/${instanceId}?theme=dark`,
        nodeIds: [...input.nodeIds],
        edgeIds: [...input.edgeIds],
      };
      const finalized = view;
      const response = prepareGraphHtml(rawHtml, this.scripts!, {
        graphId: view.id,
        revision: view.revision,
        instanceId: view.instanceId,
        parentOrigin: this.options.parentOrigin,
      });
      // Only a successfully rendered, independently checked and sanitized document
      // enters history. A failed replacement leaves the last valid version intact.
      stage = 'publish';
      if (save)
        this.options.store.saveGraphDocument(
          document,
          document.renderRevision - 1,
          operation.generationId,
        );
      else if (
        this.options.store.getGraphDocument(input.taskId)?.renderRevision !==
        document.renderRevision
      )
        throw new Error('Graph changed while restoring its viewer');
      this.documents.set(input.taskId, {
        document,
        view: finalized,
        rawHtml,
        response,
        live: true,
      });
      if (save) this.notifyGeneration(this.options.store.getGraphGeneration(taskId)!);
      return finalized;
    } catch (error) {
      if (operation.generationId) {
        const current = this.options.store.getGraphGeneration(taskId);
        if (current?.id === operation.generationId && graphGenerationActive(current)) {
          const canceled = controller.signal.aborted || current.state === 'canceling';
          this.notifyGeneration(
            this.options.store.finishGraphGeneration(
              taskId,
              current.id,
              canceled ? 'canceled' : 'failed',
              canceled ? null : stage,
            ),
          );
        }
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (directory !== undefined) {
        try {
          await rm(directory, { recursive: true, force: true });
        } catch {
          secureLogger.warn('Graph temporary files could not be removed', {
            category: 'graph_cleanup',
          });
        }
      }
      this.running.delete(taskId);
      settled();
    }
  }

  async get(taskId: string): Promise<GraphView | null> {
    if (this.closed) throw new Error('Graph renderer is closed');
    const document = this.options.store.getGraphDocument(taskId);
    if (!document) return null;
    let record = this.documents.get(taskId);
    if (record?.document.renderRevision !== document.renderRevision) {
      let pending = this.restoring.get(taskId);
      if (!pending) {
        pending = this.generate({ taskId, diagram: document.diagram }, document, false);
        this.restoring.set(taskId, pending);
      }
      try {
        await pending;
      } finally {
        if (this.restoring.get(taskId) === pending) this.restoring.delete(taskId);
      }
      record = this.documents.get(taskId);
      if (record?.document.renderRevision !== document.renderRevision) return this.get(taskId);
    }
    const instanceId = randomUUID();
    const view = {
      ...record.view,
      instanceId,
      viewRevision: record.view.viewRevision + 1,
      artifactUrl: `app://graph/${instanceId}?theme=dark`,
    };
    record.view = view;
    record.response = prepareGraphHtml(record.rawHtml, this.scripts!, {
      graphId: view.id,
      revision: view.revision,
      instanceId,
      parentOrigin: this.options.parentOrigin,
    });
    record.live = true;
    return view;
  }
  release(taskId: string, instanceId: string): void {
    const record = this.documents.get(taskId);
    if (record?.view.instanceId === instanceId) record.live = false;
  }
  history(raw: unknown): GraphHistory {
    const input = graphHistoryInputSchema.parse(raw);
    const documents = this.options.store.listGraphDocumentVersions(
      input.taskId,
      26,
      input.beforeRenderRevision,
    );
    return graphHistorySchema.parse({
      versions: documents.slice(0, 25).map(graphVersionSummary),
      nextBeforeRenderRevision: documents.length > 25 ? documents[24]!.renderRevision : null,
    });
  }
  compare(raw: unknown): GraphDiff {
    const input = graphCompareInputSchema.parse(raw);
    const before = this.options.store.getGraphDocumentVersion(
      input.taskId,
      input.beforeRenderRevision,
    );
    const after = this.options.store.getGraphDocumentVersion(
      input.taskId,
      input.afterRenderRevision,
    );
    if (!before || !after) throw new Error('Graph version not found');
    return compareGraphDocuments(before, after);
  }
  cancel(taskId: string, expectedGenerationId?: string): void {
    const operation = this.running.get(taskId);
    if (!operation) return;
    if (expectedGenerationId !== undefined && operation.generationId !== expectedGenerationId)
      throw new Error('Graph generation changed before cancellation');
    try {
      if (operation.generationId) {
        const previous = this.options.store.getGraphGeneration(taskId);
        if (!previous || previous.id !== operation.generationId)
          throw new Error('Graph generation changed');
        if (previous.state === 'running')
          this.notifyGeneration(
            this.options.store.cancelGraphGeneration(taskId, operation.generationId),
          );
      }
    } finally {
      operation.controller.abort();
    }
  }
  async dispose(): Promise<void> {
    this.closed = true;
    const pending = [...this.running.values()].map((operation) => operation.done);
    for (const taskId of this.running.keys()) {
      try {
        this.cancel(taskId);
      } catch {
        secureLogger.warn('Graph shutdown status could not be saved', {
          category: 'graph_shutdown',
        });
      }
    }
    await Promise.all(pending);
    this.documents.clear();
    this.generationListeners.clear();
  }

  generation(taskId: string): GraphGeneration | null {
    return this.options.store.getGraphGeneration(taskId);
  }
  document(taskId: string, renderRevision?: number): GraphDocument | null {
    return renderRevision === undefined
      ? this.options.store.getGraphDocument(taskId)
      : this.options.store.getGraphDocumentVersion(taskId, renderRevision);
  }
  subscribeGeneration(listener: (value: GraphGeneration) => void): () => void {
    this.generationListeners.add(listener);
    return () => this.generationListeners.delete(listener);
  }
  private notifyGeneration(value: GraphGeneration): void {
    for (const listener of this.generationListeners) {
      try {
        listener(value);
      } catch {
        secureLogger.warn('Graph status notification failed', { category: 'graph_status' });
      }
    }
  }

  response(url: URL): Response {
    if (
      url.host !== 'graph' ||
      url.search !== '?theme=dark' ||
      url.username ||
      url.password ||
      !/^\/[a-f0-9-]{36}$/u.test(url.pathname)
    )
      return new Response('Not found', { status: 404 });
    const record = [...this.documents.values()].find(
      ({ view }) => view.instanceId === url.pathname.slice(1),
    );
    if (!record?.live) return new Response('Not found', { status: 404 });
    return new Response(record.response.html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': record.response.csp,
        'Cache-Control': 'no-store',
      },
    });
  }

  private async verifyVendor(): Promise<void> {
    if (this.scripts !== null) return;
    const bytes = await readFile(join(this.options.vendorRoot, 'manifest.json'));
    if (createHash('sha256').update(bytes).digest('hex') !== ARCHIFY_MANIFEST_SHA256)
      throw new Error('Archify manifest mismatch');
    const manifest = z
      .object({
        files: z.record(
          z.string().regex(/^[a-zA-Z0-9_./-]+$/u),
          z.string().regex(/^[a-f0-9]{64}$/u),
        ),
      })
      .passthrough()
      .parse(JSON.parse(bytes.toString('utf8')));
    for (const [name, expected] of Object.entries(manifest.files)) {
      if (name.split('/').some((part) => part === '..' || part === '.'))
        throw new Error('Unsafe Archify manifest path');
      if (
        createHash('sha256')
          .update(await readFile(join(this.options.vendorRoot, name)))
          .digest('hex') !== expected
      )
        throw new Error('Archify resource mismatch');
    }
    this.scripts = trustedArchifyScripts(
      await readFile(join(this.options.vendorRoot, 'assets', 'template.html'), 'utf8'),
    );
  }

  private runUtility(
    mode: 'render' | 'check',
    input: PreparedGraphInput,
    directory: string,
    signal: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const child: UtilityProcess = utilityProcess.fork(
        this.options.workerPath,
        [mode, input.kind, this.options.vendorRoot, directory],
        {
          serviceName: `Sprint Coder Graph ${mode}`,
          stdio: 'pipe',
          cwd: directory,
          env: {
            ARCHIFY_UPDATE_CHECK_DISABLED: '1',
            LANG: 'en_US.UTF-8',
            TMPDIR: directory,
            TEMP: directory,
            TMP: directory,
          },
        },
      );
      let output = '';
      let bytes = 0;
      let rejected = false;
      const fail = () => {
        rejected = true;
        child.kill();
      };
      const timer = setTimeout(fail, 15_000);
      const onAbort = () => fail();
      signal.addEventListener('abort', onAbort, { once: true });
      child.stdout?.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > 256 * 1024) fail();
        else output += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > 256 * 1024) fail();
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (rejected || signal.aborted || code !== 0) reject(new Error(`Archify ${mode} failed`));
        else resolve(output);
      });
    });
  }
}

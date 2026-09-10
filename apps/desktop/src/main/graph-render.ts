import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { utilityProcess, type UtilityProcess } from 'electron';
import { z } from 'zod';
import type { GraphView } from '@sprint-coder/contracts';
import { ARCHIFY_MANIFEST_SHA256, prepareGraphInput, type PreparedGraphInput } from './graph-input';
import { prepareGraphHtml, trustedArchifyScripts } from './graph-html';

type StoredGraph = {
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

export class GraphRenderService {
  private readonly documents = new Map<string, StoredGraph>();
  private readonly running = new Map<string, AbortController>();
  private scripts: readonly string[] | null = null;
  private readonly run: Run;

  constructor(
    private readonly options: {
      vendorRoot: string;
      workRoot: string;
      workerPath: string;
      parentOrigin: string;
      run?: Run;
    },
  ) {
    this.run =
      options.run ??
      ((mode, input, directory, signal) => this.runUtility(mode, input, directory, signal));
  }

  async render(raw: unknown): Promise<GraphView> {
    const input = prepareGraphInput(raw);
    if (this.running.has(input.taskId) || this.running.size >= 2)
      throw new Error('Graph renderer is busy');
    if (!this.documents.has(input.taskId) && this.documents.size >= 32)
      throw new Error('Graph session capacity reached');
    const controller = new AbortController();
    this.running.set(input.taskId, controller);
    let directory: string | undefined;
    try {
      await this.verifyVendor();
      await mkdir(this.options.workRoot, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(this.options.workRoot, 'render-'));
      await writeFile(join(directory, 'input.json'), JSON.stringify(input.diagram), {
        mode: 0o600,
        flag: 'wx',
      });
      await this.run('render', input, directory, controller.signal);
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
        id: prior?.view.id ?? randomUUID(),
        taskId: input.taskId,
        revision: (prior?.view.revision ?? 0) + 1,
        title: input.title,
        kind: input.kind,
        digest: createHash('sha256').update(JSON.stringify(input.diagram)).digest('hex'),
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
      this.documents.set(input.taskId, { view: finalized, rawHtml, response, live: true });
      return finalized;
    } finally {
      this.running.delete(input.taskId);
      if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    }
  }

  get(taskId: string): GraphView | null {
    const record = this.documents.get(taskId);
    if (!record) return null;
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
  cancel(taskId: string): void {
    this.running.get(taskId)?.abort();
  }
  dispose(): void {
    for (const controller of this.running.values()) controller.abort();
    this.documents.clear();
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

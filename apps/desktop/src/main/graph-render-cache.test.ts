import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { GraphDocument, GraphGeneration, GraphView } from '@sprint-coder/contracts';
import { GraphRenderService } from './graph-render';
import { validateGraphDocumentWrite, type GraphDocumentStore } from './graph-document';
import {
  beginGraphGeneration,
  cancelGraphGeneration,
  finishGraphGeneration,
} from './graph-generation';

// Issue #1162: a graph whose generation finished while its Task was not selected was cached as
// "on screen" although no panel ever showed it, so 32 of them filled the session cache and every
// later generation or restore failed with `Graph session capacity reached`. These specs drive the
// real service through the same calls the renderer makes: a panel's mount is `get`, its unmount is
// `release`, and a finished generation for a Task nobody is looking at gets neither.

const execute = promisify(execFile);
const vendorRoot = resolve('vendor/archify');
const archifyEnv = { ARCHIFY_UPDATE_CHECK_DISABLED: '1' };
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const task = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const diagram = {
  schema_version: 1,
  diagram_type: 'architecture',
  meta: { title: 'Cache fixture' },
  cards: [],
  components: ['client', 'api'].map((id, i) => ({
    id,
    type: 'backend',
    label: id,
    pos: [40 + i * 220, 40],
  })),
  connections: [{ id: 'request', from: 'client', to: 'api' }],
};

function memoryStore(): GraphDocumentStore {
  const documents = new Map<string, GraphDocument>();
  const history = new Map<string, GraphDocument[]>();
  const generations = new Map<string, GraphGeneration>();
  const current = (id: string, generationId: string) => {
    const value = generations.get(id)!;
    if (value.id !== generationId) throw new Error('Stale generation');
    return value;
  };
  return {
    getGraphGeneration: (id) => generations.get(id) ?? null,
    beginGraphGeneration: (id, title, base) => {
      const value = beginGraphGeneration(id, title, base, generations.get(id) ?? null);
      generations.set(id, value);
      return value;
    },
    cancelGraphGeneration: (id, generationId) => {
      const value = cancelGraphGeneration(current(id, generationId));
      generations.set(id, value);
      return value;
    },
    finishGraphGeneration: (id, generationId, state, stage) => {
      const value = finishGraphGeneration(current(id, generationId), state, stage);
      generations.set(id, value);
      return value;
    },
    getGraphDocument: (id) => structuredClone(documents.get(id) ?? null),
    getGraphDocumentVersion: (id, revision) =>
      structuredClone(history.get(id)?.find((doc) => doc.renderRevision === revision) ?? null),
    listGraphDocumentVersions: (id) => structuredClone([...(history.get(id) ?? [])].reverse()),
    saveGraphDocument: (document, expected, generationId) => {
      const saved = validateGraphDocumentWrite(
        document,
        documents.get(document.taskId) ?? null,
        expected,
      );
      documents.set(document.taskId, saved);
      history.set(document.taskId, [...(history.get(document.taskId) ?? []), saved]);
      if (generationId)
        generations.set(
          document.taskId,
          finishGraphGeneration(
            current(document.taskId, generationId),
            'succeeded',
            null,
            saved.renderRevision,
          ),
        );
      return saved;
    },
  };
}

/**
 * The pinned Archify renderer and checker run for real once; later runs replay that output, since
 * every Task here draws the same diagram. `renders` counts renderer runs so a spec can tell a cache
 * hit from a rebuild out of the saved document, and `hold` keeps one Task's next render open.
 *
 * A hold names its Task and reports when that render has really reached the renderer. Renders of
 * different Tasks run concurrently and race through their file setup, so a hold that the first
 * arriving render took (or a spec that only waited for the generation to be marked running) could
 * stop the wrong Task — the spec then awaited a render that waits for the spec, and timed out.
 */
async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'sc-graph-cache-test-'));
  roots.push(root);
  const replay: { html?: string; check?: string } = {};
  type Hold = { taskId: string; arrive: () => void; released: Promise<void> };
  const state = { renders: 0, hold: null as Hold | null };
  const hold = (index: number) => {
    let arrive!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.hold = { taskId: task(index), arrive, released };
    return { reached, release };
  };
  const service = new GraphRenderService({
    store: memoryStore(),
    vendorRoot,
    workRoot: root,
    workerPath: '/unused',
    parentOrigin: 'app://bundle',
    run: async (mode, input, directory) => {
      if (mode === 'render') {
        state.renders += 1;
        const held = state.hold;
        if (held?.taskId === input.taskId) {
          state.hold = null;
          held.arrive();
          await held.released;
        }
        if (replay.html === undefined) {
          await execute(
            process.execPath,
            [
              join(vendorRoot, 'renderers', input.kind, `render-${input.kind}.mjs`),
              join(directory, 'input.json'),
              join(directory, 'diagram.html'),
            ],
            { env: archifyEnv },
          );
          replay.html = await readFile(join(directory, 'diagram.html'), 'utf8');
        } else await writeFile(join(directory, 'diagram.html'), replay.html);
        return '';
      }
      replay.check ??= (
        await execute(
          process.execPath,
          [join(vendorRoot, 'scripts', 'check-render-output.mjs'), join(directory, 'diagram.html')],
          { env: archifyEnv },
        )
      ).stdout;
      return replay.check;
    },
  });
  const render = (index: number) => service.render({ taskId: task(index), diagram });
  /** Whether the artifact URL a panel would load for this view answers. */
  const served = (view: GraphView) => service.response(new URL(view.artifactUrl)).status === 200;
  return { service, state, hold, render, served };
}

describe('Graph session cache (issue #1162)', () => {
  it('evicts finished graphs no panel ever showed, so generation and restore keep working', async () => {
    const { service, state, render, served } = await harness();
    // Each Task finishes its graph while another Task is selected: the push only records the
    // version (App.tsx), no panel mounts, so neither `get` nor `release` is ever called.
    const unseen: GraphView[] = [];
    for (let index = 1; index <= 32; index++) unseen.push(await render(index));
    expect(unseen.map(served)).toEqual(Array.from({ length: 32 }, () => false));

    // The 33rd Task's generation used to fail here with `Graph session capacity reached`.
    const next = await render(33);
    expect(next.taskId).toBe(task(33));

    // Opening a saved graph that is no longer cached rebuilds it from the saved document.
    const rendersBefore = state.renders;
    const reopened = (await service.get(task(1)))!;
    expect(state.renders).toBe(rendersBefore + 1);
    expect(reopened).toMatchObject({ id: unseen[0]!.id, revision: unseen[0]!.revision });
    expect(served(reopened)).toBe(true);
    expect(service.liveDocument(task(1), reopened.instanceId, reopened.renderRevision).id).toBe(
      unseen[0]!.id,
    );
    await service.dispose();
  });

  it('never evicts the graph a panel is showing', async () => {
    const { service, state, render, served } = await harness();
    await render(1);
    const shown = (await service.get(task(1)))!;
    for (let index = 2; index <= 40; index++) await render(index);
    expect(served(shown)).toBe(true);
    expect(service.liveDocument(task(1), shown.instanceId, shown.renderRevision).id).toBe(shown.id);
    // Still a cache hit: reopening it does not render it again.
    const rendersBefore = state.renders;
    service.release(task(1), shown.instanceId);
    const again = (await service.get(task(1)))!;
    expect(state.renders).toBe(rendersBefore);
    expect(served(again)).toBe(true);
    await service.dispose();
  });

  it('keeps a regenerated graph on screen for the panel that showed the previous version', async () => {
    const { service, render, served } = await harness();
    await render(1);
    const before = (await service.get(task(1)))!;
    // The open panel adopts the pushed view without calling `get` (GraphPanel.tsx).
    const pushed = await render(1);
    expect(pushed.viewRevision).toBeGreaterThan(before.viewRevision);
    expect(served(pushed)).toBe(true);
    expect(service.liveDocument(task(1), pushed.instanceId, pushed.renderRevision).id).toBe(
      pushed.id,
    );
    // The panel releases whichever view it holds when it unmounts; either ends the display.
    service.release(task(1), pushed.instanceId);
    expect(served(pushed)).toBe(false);

    const shownAgain = (await service.get(task(1)))!;
    const pushedAgain = await render(1);
    // Unmounted before the push reached it: it still holds (and releases) the older id.
    service.release(task(1), shownAgain.instanceId);
    expect(served(pushedAgain)).toBe(false);
    await service.dispose();
  });

  it('does not keep a regenerated graph on screen when its panel closed during the generation', async () => {
    const { service, hold, render, served } = await harness();
    await render(1);
    const shown = (await service.get(task(1)))!;
    const held = hold(1);
    const regenerating = render(1);
    await held.reached;
    expect(service.generation(task(1))?.state).toBe('running');
    service.release(task(1), shown.instanceId);
    held.release();
    expect(served(await regenerating)).toBe(false);
    await service.dispose();
  });

  it('keeps a panel that reopened at once live when the closed panel releases late', async () => {
    const { service, render, served } = await harness();
    await render(1);
    const closed = (await service.get(task(1)))!;
    const reopened = (await service.get(task(1)))!;
    // `release` waits behind the install gate in ipc.ts, so it can arrive after the next `get`.
    service.release(task(1), closed.instanceId);
    expect(served(reopened)).toBe(true);
    expect(served(closed)).toBe(false);
    await service.dispose();
  });

  it('does not evict a cached graph whose next version is being generated', async () => {
    const { service, hold, render } = await harness();
    // Task 1 is the oldest cache entry, so it would be the first one evicted.
    const first = await render(1);
    for (let index = 2; index <= 32; index++) await render(index);
    const held = hold(1);
    const regenerating = render(1);
    // Task 33 arrives while Task 1's next version is inside the renderer.
    await held.reached;
    expect(service.generation(task(1))?.state).toBe('running');
    await render(33);
    held.release();
    // Its cache entry survived, so the new view continues the panel ordering instead of restarting.
    expect((await regenerating).viewRevision).toBe(first.viewRevision + 1);
    await service.dispose();
  });

  it('still refuses a new graph when 32 graphs are really on screen', async () => {
    const { service, render } = await harness();
    for (let index = 1; index <= 32; index++) {
      await render(index);
      await service.get(task(index));
    }
    await expect(render(33)).rejects.toThrow('Graph session capacity reached');
    await service.dispose();
  });
});

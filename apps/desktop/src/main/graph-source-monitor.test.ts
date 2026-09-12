import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EffectiveWorkspaceSet,
  GraphSourceStatus,
  GraphSourceRef,
} from '@sprint-coder/contracts';
import { GraphSourceMonitor } from './graph-source-monitor';
import { workspaceMutationBinding } from './path-guard';
import { nextGraphDocument } from './graph-document';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
  vi.useRealTimers();
});
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'sc-graph-monitor-'));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  const text = 'source snapshot';
  await writeFile(join(path, 'code.ts'), text);
  const root = await workspaceMutationBinding(path);
  const source = {
    id: randomUUID(),
    rootId: 'root',
    rootIdentityDigest: root.rootIdentityDigest,
    path: 'code.ts',
    elementKind: 'node' as const,
    elementId: 'api',
    lineStart: 1,
    lineEnd: 1,
    contentHash: createHash('sha256').update(text).digest('hex'),
    excerptHash: createHash('sha256').update(text).digest('hex'),
    excerpt: text,
    observedAt: new Date().toISOString(),
  };
  const document = nextGraphDocument(
    'task-a',
    {
      schema_version: 1,
      diagram_type: 'architecture',
      meta: { title: 'Plan' },
      components: [{ id: 'api', type: 'backend', label: 'API', pos: [40, 40] }],
    },
    null,
    [source],
  );
  const workspace: EffectiveWorkspaceSet = {
    source: 'task',
    projectId: null,
    primaryRootId: 'root',
    digest: 'a'.repeat(64),
    roots: [{ rootId: 'root', path, label: 'Code', role: 'primary', status: 'available' }],
  };
  const input = {
    taskId: document.taskId,
    renderRevision: document.renderRevision,
    instanceId: randomUUID(),
  };
  return { document, workspace, input, path, source };
}

describe('visible graph source monitor', () => {
  it('rechecks guarded bytes on matching hints, excludes raw source data and releases the watch', async () => {
    const f = await fixture();
    let changed!: (path: string | null) => void;
    const stop = vi.fn();
    const publish = vi.fn<(status: GraphSourceStatus) => void>();
    const monitor = new GraphSourceMonitor({
      document: () => f.document,
      binding: () => ({ workspace: f.workspace, policyEpoch: 1 }),
      publish,
      watch: (_path, onChanged) => {
        changed = onChanged;
        return stop;
      },
    });
    cleanup.push(() => monitor.dispose());
    const initial = await monitor.check(f.input);
    expect(initial).toMatchObject({
      phase: 'checked',
      monitoring: true,
      sources: [{ sourceId: f.source.id, status: 'current' }],
    });
    expect(JSON.stringify(initial)).not.toMatch(/source snapshot|excerpt|contentHash|code\.ts/u);
    publish.mockClear();
    changed('unrelated.ts');
    expect(publish).not.toHaveBeenCalled();
    await writeFile(join(f.path, 'code.ts'), 'updated');
    changed('code.ts');
    expect(publish.mock.lastCall?.[0]).toMatchObject({
      phase: 'checking',
      checkedAt: null,
      sources: [],
    });
    await vi.waitFor(() =>
      expect(publish.mock.lastCall?.[0]).toMatchObject({
        phase: 'checked',
        sources: [{ status: 'changed' }],
      }),
    );
    monitor.release(f.input.taskId, randomUUID());
    expect(stop).not.toHaveBeenCalled();
    monitor.release(f.input.taskId, f.input.instanceId);
    expect(stop).toHaveBeenCalledTimes(1);
    publish.mockClear();
    changed('code.ts');
    expect(publish).not.toHaveBeenCalled();
  });

  it('drops an invalidated in-flight match and coalesces calls before checking again', async () => {
    const f = await fixture();
    vi.useFakeTimers();
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const publish = vi.fn<(status: GraphSourceStatus) => void>();
    let reads = 0;
    const monitor = new GraphSourceMonitor({
      document: () => f.document,
      binding: () => ({ workspace: f.workspace, policyEpoch: 1 }),
      publish,
      watch: () => () => {},
      inspect: async (source) => {
        if (++reads === 1) await wait;
        return {
          source,
          status: reads === 1 ? 'current' : 'changed',
          currentExcerpt: 'not published',
          truncated: false,
        };
      },
    });
    cleanup.push(() => monitor.dispose());
    const pending = monitor.check(f.input);
    expect(monitor.check(f.input)).toBe(pending);
    monitor.invalidate(f.input.taskId);
    finish();
    expect((await pending).phase).toBe('checking');
    expect(
      publish.mock.calls.some(([value]) =>
        value.sources.some((source) => source.status === 'current'),
      ),
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(150);
    expect(publish.mock.lastCall?.[0]).toMatchObject({
      phase: 'checked',
      sources: [{ status: 'changed' }],
    });
    expect(reads).toBe(2);
  });

  it('rechecks changed permission bindings and never publishes a released view result', async () => {
    const f = await fixture();
    vi.useFakeTimers();
    let epoch = 1;
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const publish = vi.fn<(status: GraphSourceStatus) => void>();
    const inspect = vi.fn(async (source: GraphSourceRef) => {
      await wait;
      return { source, status: 'current' as const, currentExcerpt: null, truncated: false };
    });
    const monitor = new GraphSourceMonitor({
      document: () => f.document,
      binding: () => ({ workspace: f.workspace, policyEpoch: epoch }),
      publish,
      watch: () => {
        throw new Error('unsupported');
      },
      inspect,
    });
    cleanup.push(() => monitor.dispose());
    const pending = monitor.check(f.input);
    epoch++;
    finish();
    expect((await pending).phase).toBe('checking');
    await vi.advanceTimersByTimeAsync(150);
    expect(publish.mock.lastCall?.[0]).toMatchObject({ phase: 'checked', monitoring: false });
    expect(inspect).toHaveBeenCalledTimes(2);
    const final = monitor.check(f.input);
    monitor.release(f.input.taskId, f.input.instanceId);
    publish.mockClear();
    await final;
    expect(publish).not.toHaveBeenCalled();
    monitor.dispose();
    await expect(monitor.check(f.input)).rejects.toThrow('closed');
  });
});

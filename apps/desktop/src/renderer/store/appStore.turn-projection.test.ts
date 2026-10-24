import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnEvent, TurnSnapshot } from '../types/sprint-coder';
import { useAppStore } from './appStore';

const createdAt = '2026-10-20T01:02:03.000Z';
const startedAt = Date.parse(createdAt);
function snapshot(lastSeq: number, turnId = 'turn-a', text = 'saved'): TurnSnapshot {
  return {
    lastSeq,
    activeTurn: {
      turnId,
      stage: 'executing',
      startedAtEpochMs: startedAt,
      messageId: 'reply',
      streamedText: text,
    },
    queued: [{ ordinal: 1, text: `queue-${lastSeq}` }],
    contextUsage: { usedTokens: 0, hardCapTokens: 100, projectTokens: 0, fragments: [] },
    pendingApprovals: [],
    activatedSkills: [],
    latestTurnDiff: null,
    interruptedTurnIds: [],
    autoDecisions: [],
    autoDecisionCounts: [],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function harness(snapshots: Promise<TurnSnapshot>[]) {
  const reads = vi.fn<() => Promise<TurnSnapshot>>();
  for (const next of snapshots) reads.mockReturnValueOnce(next);
  const subscriptions: {
    taskId: string;
    listener: (event: TurnEvent) => void;
    afterSeq: number | undefined;
    unsubscribe: ReturnType<typeof vi.fn>;
  }[] = [];
  const subscribe = vi.fn(
    (taskId: string, listener: (event: TurnEvent) => void, options?: { afterSeq: number }) => {
      const unsubscribe = vi.fn();
      subscriptions.push({ taskId, listener, afterSeq: options?.afterSeq, unsubscribe });
      return unsubscribe;
    },
  );
  const cancel = vi.fn<() => Promise<void>>();
  vi.stubGlobal('window', {
    sprintCoder: {
      tasks: { messages: vi.fn().mockResolvedValue([]) },
      turns: { snapshot: reads, subscribe, cancel },
    },
  });
  return { reads, subscriptions, cancel };
}
function delta(seq: number, text: string, taskId = 'task-a', turnId = 'turn-a'): TurnEvent {
  return { type: 'message.delta', taskId, turnId, seq, messageId: 'reply', delta: text };
}

describe('Task Turn subscription projection boundary', () => {
  beforeEach(() =>
    useAppStore.setState({
      selectedTaskId: null,
      turnByTask: {},
      queuedByTask: {},
      lastSeqByTask: {},
      messagesByTask: {},
      pendingOptimisticIdByTask: {},
      draftAttachmentsByTask: {},
      sendingByTask: {},
      error: null,
    }),
  );
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses the persisted acceptance time even when delivery arrives much later', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(startedAt + 60_000);
    const initial = { ...snapshot(0), activeTurn: null, queued: [] };
    const liveSnapshot = {
      ...snapshot(1),
      activeTurn: {
        ...snapshot(1).activeTurn!,
        stage: 'understanding' as const,
        messageId: null,
        streamedText: '',
      },
      queued: [],
    };
    const h = harness([Promise.resolve(initial), Promise.resolve(liveSnapshot)]);
    await useAppStore.getState().selectTask('task-a');
    h.subscriptions[0]!.listener({
      type: 'turn.accepted',
      taskId: 'task-a',
      turnId: 'turn-a',
      seq: 1,
      userMessage: {
        id: 'user',
        taskId: 'task-a',
        turnId: 'turn-a',
        author: 'user',
        content: 'synthetic',
        attachments: [],
        createdAt,
      },
    });
    expect(useAppStore.getState().turnByTask['task-a']?.startedAt).toBe(startedAt);
    expect(useAppStore.getState().turnByTask['task-a']?.runtimeStarting).toBe(true);
    await useAppStore.getState().selectTask('task-a');
    expect(useAppStore.getState().turnByTask['task-a']).toMatchObject({
      startedAt,
      runtimeStarting: false,
    });
  });

  it('deduplicates through the actual listener and recovers a gap before applying any suffix', async () => {
    const recovered = deferred<TurnSnapshot>();
    const h = harness([Promise.resolve(snapshot(4)), recovered.promise]);
    await useAppStore.getState().selectTask('task-a');
    const first = h.subscriptions[0]!;
    expect(first.afterSeq).toBe(4);
    first.listener(delta(5, '+five'));
    const once = useAppStore.getState().turnByTask['task-a'];
    first.listener(delta(5, '+duplicate'));
    first.listener({ type: 'queue.changed', taskId: 'task-a', seq: 4, queued: [] });
    expect(useAppStore.getState().turnByTask['task-a']).toBe(once);
    expect(useAppStore.getState().queuedByTask['task-a']).toEqual(snapshot(4).queued);
    first.listener(delta(7, '+gap-must-not-append'));
    expect(useAppStore.getState().lastSeqByTask['task-a']).toBe(5);
    expect(first.unsubscribe).toHaveBeenCalledOnce();
    recovered.resolve(snapshot(7, 'turn-a', 'canonical-seven'));
    await vi.waitFor(() => expect(h.subscriptions).toHaveLength(2));
    expect(h.subscriptions[1]!.afterSeq).toBe(7);
    h.subscriptions[1]!.listener(delta(8, '+eight'));
    expect(useAppStore.getState().turnByTask['task-a']?.streamingContent).toBe(
      'canonical-seven+eight',
    );
    expect(useAppStore.getState().queuedByTask['task-a']).toEqual(snapshot(7).queued);
  });

  it('ignores a previous Task listener after switching and keeps each Task projection separate', async () => {
    const h = harness([Promise.resolve(snapshot(2)), Promise.resolve(snapshot(20, 'turn-b', 'B'))]);
    await useAppStore.getState().selectTask('task-a');
    const previous = h.subscriptions[0]!;
    await useAppStore.getState().selectTask('task-b');
    previous.listener(delta(3, '+stale'));
    h.subscriptions[1]!.listener(delta(21, '+live', 'task-b', 'turn-b'));
    expect(previous.unsubscribe).toHaveBeenCalledOnce();
    expect(useAppStore.getState().turnByTask['task-a']?.streamingContent).toBe('saved');
    expect(useAppStore.getState().turnByTask['task-b']?.streamingContent).toBe('B+live');
    expect(useAppStore.getState().lastSeqByTask).toEqual({ 'task-a': 2, 'task-b': 21 });
  });

  it.each([false, true])(
    'rejects older snapshot/queue/lastSeq when reselection crosses B=%s',
    async (viaB) => {
      const older = deferred<TurnSnapshot>();
      const h = harness([
        older.promise,
        ...(viaB ? [Promise.resolve(snapshot(20, 'turn-b'))] : []),
        Promise.resolve(snapshot(10, 'new-a', 'new')),
      ]);
      const pending = useAppStore.getState().selectTask('task-a');
      if (viaB) await useAppStore.getState().selectTask('task-b');
      await useAppStore.getState().selectTask('task-a');
      h.subscriptions.at(-1)!.listener(delta(11, '+live', 'task-a', 'new-a'));
      const current = useAppStore.getState().turnByTask['task-a'];
      older.resolve(snapshot(3, 'old-a', 'obsolete'));
      await pending;
      expect(useAppStore.getState().turnByTask['task-a']).toBe(current);
      expect(current?.streamingContent).toBe('new+live');
      expect(useAppStore.getState().queuedByTask['task-a']).toEqual(snapshot(10).queued);
      expect(useAppStore.getState().lastSeqByTask['task-a']).toBe(11);
      expect(h.subscriptions).toHaveLength(viaB ? 2 : 1);
    },
  );

  it('restores cancel failure from the current streamed object, never the pre-request snapshot', async () => {
    const h = harness([Promise.resolve(snapshot(2))]);
    await useAppStore.getState().selectTask('task-a');
    const failed = deferred<void>();
    h.cancel.mockReturnValueOnce(failed.promise);
    const request = useAppStore.getState().cancelActiveTurn('task-a');
    h.subscriptions[0]!.listener(delta(3, '+during-cancel'));
    failed.reject(new Error('synthetic cancellation failure'));
    await request;
    expect(useAppStore.getState().turnByTask['task-a']).toMatchObject({
      status: 'running',
      streamingContent: 'saved+during-cancel',
    });
  });
});

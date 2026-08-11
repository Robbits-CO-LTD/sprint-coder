import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from './appStore';

const taskId = 'task-draft-persistence';
const originalDraft = '送信に失敗しても残す指示';

type SendKind = 'startTurn' | 'queueMessage' | 'steerMessage' | 'stopAndSend';

function deferredFailure() {
  let reject!: (reason: Error) => void;
  const promise = new Promise<never>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
}

function invokeSend(kind: SendKind) {
  const store = useAppStore.getState();
  switch (kind) {
    case 'startTurn':
      return store.startTurn(taskId, originalDraft);
    case 'queueMessage':
      return store.queueMessage(taskId, originalDraft);
    case 'steerMessage':
      return store.steerMessage(taskId, originalDraft, 'turn-active');
    case 'stopAndSend':
      return store.stopAndSend(taskId, originalDraft);
  }
}

describe.each<SendKind>(['startTurn', 'queueMessage', 'steerMessage', 'stopAndSend'])(
  '%s draft recovery',
  (kind) => {
    let rejectRequest: (reason: Error) => void;
    let request: ReturnType<typeof vi.fn>;
    let setDraft: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      vi.useFakeTimers();
      const failure = deferredFailure();
      rejectRequest = failure.reject;
      setDraft = vi.fn().mockResolvedValue(undefined);
      request = vi.fn().mockReturnValue(failure.promise);
      vi.stubGlobal('window', {
        sprintCoder: {
          tasks: { setDraft },
          turns: {
            start: request,
            queue: request,
            steer: request,
            stopAndSend: request,
          },
        },
      });
      useAppStore.setState({
        draftByTask: {},
        skillSelectionByTask: {},
        messagesByTask: {},
        pendingOptimisticIdByTask: {},
        sendingByTask: {},
        turnByTask: {},
        error: null,
      });
      useAppStore.getState().setDraft(taskId, originalDraft);
      await vi.advanceTimersByTimeAsync(400);
      setDraft.mockClear();
    });

    afterEach(async () => {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('persists the restored draft after the IPC request fails', async () => {
      const send = invokeSend(kind);

      expect(useAppStore.getState().draftByTask[taskId]).toBe('');
      rejectRequest(new Error('IPC unavailable'));
      await send;

      expect(useAppStore.getState().draftByTask[taskId]).toBe(originalDraft);
      await vi.advanceTimersByTimeAsync(400);
      expect(setDraft).toHaveBeenLastCalledWith(taskId, originalDraft);
    });

    it('does not replace a newer draft when an older request fails', async () => {
      const send = invokeSend(kind);
      const newerDraft = kind === 'stopAndSend' ? originalDraft : '送信中に書き始めた新しい指示';
      useAppStore.getState().setDraft(taskId, newerDraft);

      rejectRequest(new Error('IPC unavailable'));
      const result = await send;

      expect(useAppStore.getState().draftByTask[taskId]).toBe(newerDraft);
      if (kind === 'stopAndSend') {
        expect(result).toEqual({ completed: false, draftRestored: false });
      }
      await vi.advanceTimersByTimeAsync(400);
      expect(setDraft).toHaveBeenLastCalledWith(taskId, newerDraft);
    });

    it('keeps the persisted draft empty after a successful send', async () => {
      request.mockResolvedValueOnce(undefined);

      await invokeSend(kind);
      await vi.advanceTimersByTimeAsync(400);

      expect(useAppStore.getState().draftByTask[taskId]).toBe('');
      expect(setDraft).toHaveBeenLastCalledWith(taskId, '');
    });
  },
);

describe.each(['queueMessage', 'stopAndSend'] as const)('%s skill recovery', (kind) => {
  it('restores the selected Skill when the request fails', async () => {
    const failure = deferredFailure();
    const request = vi.fn().mockReturnValue(failure.promise);
    const selection = {
      kind: 'chat' as const,
      ref: {
        source: 'builtin' as const,
        skillId: 'review',
        digest: 'a'.repeat(64),
      },
    };
    vi.stubGlobal('window', {
      sprintCoder: {
        tasks: { setDraft: vi.fn().mockResolvedValue(undefined) },
        skills: { setDraftSelection: vi.fn().mockResolvedValue(undefined) },
        turns: { queue: request, stopAndSend: request },
      },
    });
    useAppStore.setState({
      draftByTask: { [taskId]: originalDraft },
      skillSelectionByTask: { [taskId]: [selection] },
      error: null,
    });

    const send = useAppStore.getState()[kind](taskId, originalDraft);
    expect(useAppStore.getState().skillSelectionByTask[taskId]).toEqual([]);
    failure.reject(new Error('IPC unavailable'));
    await send;

    expect(useAppStore.getState().skillSelectionByTask[taskId]).toEqual([selection]);
    vi.unstubAllGlobals();
  });

  it('does not replace a newer Skill selection when the older request fails', async () => {
    const failure = deferredFailure();
    const request = vi.fn().mockReturnValue(failure.promise);
    const originalSelection = {
      kind: 'chat' as const,
      ref: { source: 'builtin' as const, skillId: 'review', digest: 'a'.repeat(64) },
    };
    const newerSelection = {
      kind: 'chat' as const,
      ref: { source: 'builtin' as const, skillId: 'security', digest: 'b'.repeat(64) },
    };
    const persistSelection = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', {
      sprintCoder: {
        tasks: { setDraft: vi.fn().mockResolvedValue(undefined) },
        skills: { setDraftSelection: persistSelection },
        turns: { queue: request, stopAndSend: request },
      },
    });
    useAppStore.setState({
      draftByTask: { [taskId]: originalDraft },
      skillSelectionByTask: { [taskId]: [originalSelection] },
      error: null,
    });

    const send = useAppStore.getState()[kind](taskId, originalDraft);
    await useAppStore.getState().setSkillSelection(taskId, [newerSelection]);
    failure.reject(new Error('late IPC failure'));
    const result = await send;
    expect(typeof result === 'boolean' ? result : result.completed).toBe(false);

    expect(useAppStore.getState().skillSelectionByTask[taskId]).toEqual([newerSelection]);
    expect(persistSelection).not.toHaveBeenCalledWith(taskId, [originalSelection]);
    vi.unstubAllGlobals();
  });

  it('does not restore an old Skill after a newer selection is deliberately cleared', async () => {
    const failure = deferredFailure();
    const request = vi.fn().mockReturnValue(failure.promise);
    const originalSelection = {
      kind: 'chat' as const,
      ref: { source: 'builtin' as const, skillId: 'review', digest: 'a'.repeat(64) },
    };
    const newerSelection = {
      kind: 'chat' as const,
      ref: { source: 'builtin' as const, skillId: 'security', digest: 'b'.repeat(64) },
    };
    const persistSelection = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', {
      sprintCoder: {
        tasks: { setDraft: vi.fn().mockResolvedValue(undefined) },
        skills: { setDraftSelection: persistSelection },
        turns: { queue: request, stopAndSend: request },
      },
    });
    useAppStore.setState({
      draftByTask: { [taskId]: originalDraft },
      skillSelectionByTask: { [taskId]: [originalSelection] },
      skillSelectionRevisionByTask: { [taskId]: 0 },
      error: null,
    });

    const send = useAppStore.getState()[kind](taskId, originalDraft);
    await useAppStore.getState().setSkillSelection(taskId, [newerSelection]);
    await useAppStore.getState().setSkillSelection(taskId, []);
    failure.reject(new Error('late IPC failure'));
    await send;

    expect(useAppStore.getState().skillSelectionByTask[taskId]).toEqual([]);
    expect(persistSelection).not.toHaveBeenCalledWith(taskId, [originalSelection]);
    vi.unstubAllGlobals();
  });

  it('keeps send recovery coherent when the preceding Skill persistence fails late', async () => {
    const selectionFailure = deferredFailure();
    const sendFailure = deferredFailure();
    const selection = {
      kind: 'chat' as const,
      ref: { source: 'builtin' as const, skillId: 'security', digest: 'b'.repeat(64) },
    };
    vi.stubGlobal('window', {
      sprintCoder: {
        tasks: { setDraft: vi.fn().mockResolvedValue(undefined) },
        skills: { setDraftSelection: vi.fn().mockReturnValue(selectionFailure.promise) },
        turns: {
          queue: vi.fn().mockReturnValue(sendFailure.promise),
          stopAndSend: vi.fn().mockReturnValue(sendFailure.promise),
        },
      },
    });
    useAppStore.setState({
      draftByTask: { [taskId]: originalDraft },
      skillSelectionByTask: { [taskId]: [] },
      skillSelectionRevisionByTask: { [taskId]: 0 },
      error: null,
    });

    const selectionWrite = useAppStore.getState().setSkillSelection(taskId, [selection]);
    const send = useAppStore.getState()[kind](taskId, originalDraft);
    selectionFailure.reject(new Error('late Skill persistence failure'));
    await selectionWrite;
    sendFailure.reject(new Error('late send failure'));
    await send;

    expect(useAppStore.getState().skillSelectionByTask[taskId]).toEqual([selection]);
    vi.unstubAllGlobals();
  });
});

it('does not let an older Skill persistence failure replace a newer successful selection', async () => {
  const olderFailure = deferredFailure();
  const persistSelection = vi
    .fn()
    .mockReturnValueOnce(olderFailure.promise)
    .mockResolvedValueOnce(undefined);
  const olderSelection = {
    kind: 'chat' as const,
    ref: { source: 'builtin' as const, skillId: 'review', digest: 'a'.repeat(64) },
  };
  const newerSelection = {
    kind: 'chat' as const,
    ref: { source: 'builtin' as const, skillId: 'security', digest: 'b'.repeat(64) },
  };
  vi.stubGlobal('window', { sprintCoder: { skills: { setDraftSelection: persistSelection } } });
  useAppStore.setState({
    skillSelectionByTask: { [taskId]: [] },
    skillSelectionRevisionByTask: { [taskId]: 0 },
    error: null,
  });

  const olderWrite = useAppStore.getState().setSkillSelection(taskId, [olderSelection]);
  await useAppStore.getState().setSkillSelection(taskId, [newerSelection]);
  olderFailure.reject(new Error('older persistence failed'));
  await olderWrite;

  expect(useAppStore.getState().skillSelectionByTask[taskId]).toEqual([newerSelection]);
  vi.unstubAllGlobals();
});

describe.each(['queueMessage', 'stopAndSend'] as const)('%s draft ABA recovery', (kind) => {
  it('does not restore an old draft after a newer draft is typed and deliberately cleared', async () => {
    vi.useFakeTimers();
    const failure = deferredFailure();
    vi.stubGlobal('window', {
      sprintCoder: {
        tasks: { setDraft: vi.fn().mockResolvedValue(undefined) },
        turns: {
          queue: vi.fn().mockReturnValue(failure.promise),
          stopAndSend: vi.fn().mockReturnValue(failure.promise),
        },
      },
    });
    useAppStore.setState({
      draftByTask: { [taskId]: originalDraft },
      draftRevisionByTask: { [taskId]: 0 },
      skillSelectionByTask: { [taskId]: [] },
      skillSelectionRevisionByTask: { [taskId]: 0 },
      error: null,
    });

    const send = useAppStore.getState()[kind](taskId, originalDraft);
    useAppStore.getState().setDraft(taskId, '新しい下書き');
    useAppStore.getState().setDraft(taskId, '');
    failure.reject(new Error('late IPC failure'));
    const result = await send;

    expect(useAppStore.getState().draftByTask[taskId]).toBe('');
    if (kind === 'stopAndSend') {
      expect(result).toEqual({ completed: false, draftRestored: false });
    }
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});

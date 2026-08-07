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
      useAppStore.getState().setDraft(taskId, '送信中に書き始めた新しい指示');

      rejectRequest(new Error('IPC unavailable'));
      await send;

      expect(useAppStore.getState().draftByTask[taskId]).toBe('送信中に書き始めた新しい指示');
      await vi.advanceTimersByTimeAsync(400);
      expect(setDraft).toHaveBeenLastCalledWith(taskId, '送信中に書き始めた新しい指示');
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

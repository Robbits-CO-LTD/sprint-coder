import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from './appStore';

const taskId = 'task-cancel-recovery';

function activeTurn(turnId = 'turn-1') {
  return {
    turnId,
    stage: 'executing' as const,
    reachedStageIndex: 2,
    status: 'running' as const,
    startedAt: 1,
    streamingMessageId: null,
    streamingContent: 'partial answer',
    runtimeStarting: false,
  };
}

describe('cancelActiveTurn recovery', () => {
  let cancel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    cancel = vi.fn();
    vi.stubGlobal('window', { sprintCoder: { turns: { cancel } } });
    useAppStore.setState({ turnByTask: { [taskId]: activeTurn() }, error: null });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('marks the turn canceling once and restores running when cancel fails', async () => {
    cancel.mockRejectedValueOnce(new Error('cancel IPC failed'));

    const first = useAppStore.getState().cancelActiveTurn(taskId);
    const second = useAppStore.getState().cancelActiveTurn(taskId);

    expect(useAppStore.getState().turnByTask[taskId]?.status).toBe('canceling');
    await Promise.all([first, second]);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith({ taskId, turnId: 'turn-1' });
    expect(useAppStore.getState().turnByTask[taskId]?.status).toBe('running');
    expect(useAppStore.getState().error).toBe('cancel IPC failed');
  });

  it('does not overwrite a newer turn when an older cancel request fails', async () => {
    let rejectCancel!: (error: Error) => void;
    cancel.mockReturnValueOnce(
      new Promise<never>((_resolve, reject) => {
        rejectCancel = reject;
      }),
    );

    const request = useAppStore.getState().cancelActiveTurn(taskId);
    useAppStore.setState({ turnByTask: { [taskId]: activeTurn('turn-2') } });
    rejectCancel(new Error('late cancel failure'));
    await request;

    expect(useAppStore.getState().turnByTask[taskId]).toMatchObject({
      turnId: 'turn-2',
      status: 'running',
    });
  });
});

describe('stopAndSend shared cancellation state', () => {
  it('blocks the RunCard cancel path and restores running after replacement failure', async () => {
    let rejectReplace!: (error: Error) => void;
    const stopAndSend = vi.fn().mockReturnValue(
      new Promise<never>((_resolve, reject) => {
        rejectReplace = reject;
      }),
    );
    const cancel = vi.fn();
    vi.stubGlobal('window', {
      sprintCoder: {
        tasks: { setDraft: vi.fn().mockResolvedValue(undefined) },
        skills: { setDraftSelection: vi.fn().mockResolvedValue(undefined) },
        turns: { stopAndSend, cancel },
      },
    });
    useAppStore.setState({
      turnByTask: { [taskId]: activeTurn() },
      draftByTask: { [taskId]: '割り込み' },
      skillSelectionByTask: {},
      error: null,
    });

    const replace = useAppStore.getState().stopAndSend(taskId, '割り込み');
    expect(useAppStore.getState().turnByTask[taskId]?.status).toBe('canceling');
    expect(await useAppStore.getState().cancelActiveTurn(taskId)).toBe(false);
    expect(cancel).not.toHaveBeenCalled();

    rejectReplace(new Error('stop-and-send failed'));
    expect(await replace).toEqual({ completed: false, draftRestored: true });
    expect(useAppStore.getState().turnByTask[taskId]?.status).toBe('running');
    vi.unstubAllGlobals();
  });
});

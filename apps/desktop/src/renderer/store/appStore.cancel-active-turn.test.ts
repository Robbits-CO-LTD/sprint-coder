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

describe('stopAllTeamWorkers leader cancellation', () => {
  beforeEach(() => {
    useAppStore.setState({
      turnByTask: { [taskId]: activeTurn() },
      teamByTask: {},
      teamBusy: false,
      error: null,
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('stops the Leader Turn before stopping Team workers', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const detail = { team: { id: 'team-1' } };
    const stopAll = vi.fn().mockResolvedValue(detail);
    vi.stubGlobal('window', {
      sprintCoder: { turns: { cancel }, teams: { stopAll } },
    });

    await useAppStore.getState().stopAllTeamWorkers(taskId);

    expect(cancel).toHaveBeenCalledWith({
      taskId,
      turnId: 'turn-1',
      startNextQueued: false,
    });
    expect(stopAll).toHaveBeenCalledWith(taskId);
    expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(stopAll.mock.invocationCallOrder[0]!);
    expect(useAppStore.getState().teamByTask[taskId]).toBe(detail);
    expect(useAppStore.getState().teamBusy).toBe(false);
  });

  it('does not stop workers when the Leader runtime cannot be stopped', async () => {
    const cancel = vi.fn().mockRejectedValue(new Error('leader cancel failed'));
    const stopAll = vi.fn();
    vi.stubGlobal('window', {
      sprintCoder: { turns: { cancel }, teams: { stopAll } },
    });

    await useAppStore.getState().stopAllTeamWorkers(taskId);

    expect(stopAll).not.toHaveBeenCalled();
    expect(useAppStore.getState().turnByTask[taskId]?.status).toBe('running');
    expect(useAppStore.getState().error).toBe('leader cancel failed');
    expect(useAppStore.getState().teamBusy).toBe(false);
  });

  // issue #962: a Team whose Leader has not hired anyone yet is stopped through the same path.
  describe('with no Workers hired yet', () => {
    const queued = [{ ordinal: 1, text: 'next request' }];

    beforeEach(() => {
      useAppStore.setState({
        selectedTaskId: taskId,
        teamByTask: {
          [taskId]: { team: { id: 'team-1', state: 'active' }, workers: [] } as never,
        },
        teamBusyByTask: {},
        queuedByTask: { [taskId]: queued },
      });
    });

    it('waits for the Leader cancel before stopping workers and leaves the queue alone', async () => {
      let resolveCancel!: () => void;
      const cancel = vi.fn().mockReturnValue(
        new Promise<void>((resolve) => {
          resolveCancel = resolve;
        }),
      );
      const stopAll = vi.fn().mockResolvedValue({ team: { id: 'team-1' }, workers: [] });
      vi.stubGlobal('window', {
        sprintCoder: { turns: { cancel }, teams: { stopAll } },
      });

      const first = useAppStore.getState().stopAllTeamWorkers(taskId);
      const second = useAppStore.getState().stopAllTeamWorkers(taskId);
      expect(useAppStore.getState().teamBusy).toBe(true);
      expect(useAppStore.getState().turnByTask[taskId]?.status).toBe('canceling');
      await Promise.resolve();
      expect(stopAll).not.toHaveBeenCalled();

      resolveCancel();
      await Promise.all([first, second]);

      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledWith({ taskId, turnId: 'turn-1', startNextQueued: false });
      expect(stopAll).toHaveBeenCalledTimes(1);
      expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(stopAll.mock.invocationCallOrder[0]!);
      expect(useAppStore.getState().queuedByTask[taskId]).toBe(queued);
      expect(useAppStore.getState().error).toBeNull();
      expect(useAppStore.getState().teamBusy).toBe(false);
    });

    it('keeps the Leader running and reports the failure when its cancel fails', async () => {
      const cancel = vi.fn().mockRejectedValue(new Error('leader cancel failed'));
      const stopAll = vi.fn();
      vi.stubGlobal('window', {
        sprintCoder: { turns: { cancel }, teams: { stopAll } },
      });

      await useAppStore.getState().stopAllTeamWorkers(taskId);

      expect(cancel).toHaveBeenCalledWith({ taskId, turnId: 'turn-1', startNextQueued: false });
      expect(stopAll).not.toHaveBeenCalled();
      expect(useAppStore.getState().turnByTask[taskId]?.status).toBe('running');
      expect(useAppStore.getState().error).toBe('leader cancel failed');
      expect(useAppStore.getState().queuedByTask[taskId]).toBe(queued);
      expect(useAppStore.getState().teamBusy).toBe(false);
    });
  });
});

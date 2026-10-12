import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamDetail, TeamEvent } from '@sprint-coder/contracts';
import { useAppStore } from './appStore';

const taskId = 'task-team-subscription';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('Team state subscription boundary', () => {
  beforeEach(() => {
    useAppStore.setState({
      selectedTaskId: null,
      loadingMessages: false,
      teamByTask: {},
      teamLoadFailedByTask: {},
      teamBusy: false,
      teamBusyByTask: {},
      teamViewOpen: false,
      error: null,
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('starts the Team subscription without waiting for a separate snapshot read', async () => {
    const teamRead = deferred<null>();
    const subscribe = vi.fn().mockReturnValue(vi.fn());
    vi.stubGlobal('window', {
      sprintCoder: {
        tasks: { messages: vi.fn().mockResolvedValue([]) },
        turns: {
          snapshot: vi.fn().mockResolvedValue(null),
          subscribe: vi.fn().mockReturnValue(vi.fn()),
        },
        teams: {
          get: vi.fn().mockReturnValue(teamRead.promise),
          subscribe,
        },
      },
    });

    const selection = useAppStore.getState().selectTask(taskId);

    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
    teamRead.resolve(null);
    await selection;
  });

  it('converges to the final update delivered after the subscription snapshot', async () => {
    let listener!: (event: TeamEvent) => void;
    const subscribe = vi.fn((_selectedTaskId: string, nextListener: (event: TeamEvent) => void) => {
      listener = nextListener;
      return vi.fn();
    });
    vi.stubGlobal('window', {
      sprintCoder: {
        tasks: { messages: vi.fn().mockResolvedValue([]) },
        turns: {
          snapshot: vi.fn().mockResolvedValue(null),
          subscribe: vi.fn().mockReturnValue(vi.fn()),
        },
        teams: { get: vi.fn(), subscribe },
      },
    });
    const snapshotDetail = { team: { id: 'snapshot' } } as unknown as TeamDetail;
    const finalDetail = { team: { id: 'final' } } as unknown as TeamDetail;

    await useAppStore.getState().selectTask(taskId);
    listener({ type: 'snapshot', seq: 0, detail: snapshotDetail });
    listener({ type: 'updated', seq: 1, detail: finalDetail });

    expect(useAppStore.getState().teamByTask[taskId]).toBe(finalDetail);
  });

  it('resyncs when an updated event skips the snapshot baseline sequence', async () => {
    let listener!: (event: TeamEvent) => void;
    const freshDetail = { team: { id: 'fresh' } } as unknown as TeamDetail;
    const getTeam = vi.fn().mockResolvedValue(freshDetail);
    vi.stubGlobal('window', {
      sprintCoder: {
        tasks: { messages: vi.fn().mockResolvedValue([]) },
        turns: {
          snapshot: vi.fn().mockResolvedValue(null),
          subscribe: vi.fn().mockReturnValue(vi.fn()),
        },
        teams: {
          get: getTeam,
          subscribe: vi.fn((_selectedTaskId: string, nextListener: (event: TeamEvent) => void) => {
            listener = nextListener;
            return vi.fn();
          }),
        },
      },
    });

    await useAppStore.getState().selectTask(taskId);
    listener({ type: 'snapshot', seq: 2, detail: null });
    listener({
      type: 'updated',
      seq: 4,
      detail: { team: { id: 'skipped' } } as unknown as TeamDetail,
    });
    await vi.waitFor(() => expect(useAppStore.getState().teamByTask[taskId]).toBe(freshDetail));

    expect(getTeam).toHaveBeenCalledWith(taskId);
  });

  it('does not reopen Team mode after a pending toggle finishes on an old Task', async () => {
    const read = deferred<TeamDetail>();
    vi.stubGlobal('window', {
      sprintCoder: {
        tasks: { messages: vi.fn().mockResolvedValue([]) },
        turns: {
          snapshot: vi.fn().mockResolvedValue(null),
          subscribe: vi.fn().mockReturnValue(vi.fn()),
        },
        teams: {
          get: vi.fn().mockReturnValue(read.promise),
          subscribe: vi.fn().mockReturnValue(vi.fn()),
        },
      },
    });
    useAppStore.setState({ selectedTaskId: taskId });
    const toggle = useAppStore.getState().toggleTeamView(taskId);
    await useAppStore.getState().selectTask('new-task');
    read.resolve({ team: { id: 'old-team' } } as unknown as TeamDetail);
    await toggle;
    expect(useAppStore.getState().teamViewOpen).toBe(false);
    expect(useAppStore.getState().teamByTask[taskId]).toBeUndefined();
  });

  it('does not apply an old subscription after leaving and reselecting the same Task', async () => {
    const listeners: Array<(event: TeamEvent) => void> = [];
    vi.stubGlobal('window', {
      sprintCoder: {
        tasks: { messages: vi.fn().mockResolvedValue([]) },
        turns: {
          snapshot: vi.fn().mockResolvedValue(null),
          subscribe: vi.fn().mockReturnValue(vi.fn()),
        },
        teams: {
          get: vi.fn(),
          subscribe: vi.fn((_id, listener: (event: TeamEvent) => void) => {
            listeners.push(listener);
            return vi.fn();
          }),
        },
      },
    });
    await useAppStore.getState().selectTask(taskId);
    await useAppStore.getState().selectTask('other');
    await useAppStore.getState().selectTask(taskId);
    const current = { team: { id: 'current' } } as unknown as TeamDetail;
    listeners[2]!({ type: 'snapshot', seq: 0, detail: current });
    listeners[0]!({
      type: 'snapshot',
      seq: 9,
      detail: { team: { id: 'old' } } as unknown as TeamDetail,
    });
    expect(useAppStore.getState().teamByTask[taskId]).toBe(current);
  });

  it('does not overwrite a newer event with a delayed sequence-gap read', async () => {
    const read = deferred<TeamDetail>();
    let listener!: (event: TeamEvent) => void;
    vi.stubGlobal('window', {
      sprintCoder: {
        tasks: { messages: vi.fn().mockResolvedValue([]) },
        turns: {
          snapshot: vi.fn().mockResolvedValue(null),
          subscribe: vi.fn().mockReturnValue(vi.fn()),
        },
        teams: {
          get: vi.fn().mockReturnValue(read.promise),
          subscribe: vi.fn((_id, next: (event: TeamEvent) => void) => {
            listener = next;
            return vi.fn();
          }),
        },
      },
    });
    await useAppStore.getState().selectTask(taskId);
    listener({ type: 'snapshot', seq: 0, detail: null });
    listener({ type: 'updated', seq: 2, detail: { team: { id: 'gap' } } as unknown as TeamDetail });
    const current = { team: { id: 'current' } } as unknown as TeamDetail;
    listener({ type: 'updated', seq: 3, detail: current });
    read.resolve({ team: { id: 'stale' } } as unknown as TeamDetail);
    await read.promise;
    expect(useAppStore.getState().teamByTask[taskId]).toBe(current);
  });

  it('reports a subscription failure only for its current selection and clears it on recovery', async () => {
    const listeners: Array<(event: TeamEvent) => void> = [];
    const failures: Array<() => void> = [];
    vi.stubGlobal('window', {
      sprintCoder: {
        tasks: { messages: vi.fn().mockResolvedValue([]) },
        turns: {
          snapshot: vi.fn().mockResolvedValue(null),
          subscribe: vi.fn().mockReturnValue(vi.fn()),
        },
        teams: {
          subscribe: vi.fn((_id, listener, onError) => {
            listeners.push(listener);
            failures.push(onError);
            return vi.fn();
          }),
        },
      },
    });
    await useAppStore.getState().selectTask(taskId);
    await useAppStore.getState().selectTask('other');
    await useAppStore.getState().selectTask(taskId);
    failures[0]!();
    expect(useAppStore.getState().teamLoadFailedByTask[taskId]).toBe(false);
    failures[2]!();
    expect(useAppStore.getState().teamLoadFailedByTask[taskId]).toBe(true);
    expect(useAppStore.getState().teamByTask[taskId]).toBeUndefined();
    listeners[2]!({ type: 'snapshot', seq: 0, detail: null });
    expect(useAppStore.getState().teamLoadFailedByTask[taskId]).toBe(false);
    expect(useAppStore.getState().teamByTask[taskId]).toBeNull();
  });

  it('keeps a failed fallback read distinct from a successful null snapshot', async () => {
    vi.stubGlobal('window', {
      sprintCoder: {
        tasks: { messages: vi.fn().mockResolvedValue([]) },
        turns: {
          snapshot: vi.fn().mockResolvedValue(null),
          subscribe: vi.fn().mockReturnValue(vi.fn()),
        },
        teams: { get: vi.fn().mockRejectedValue(new Error('read failed')) },
      },
    });
    await useAppStore.getState().selectTask(taskId);
    expect(useAppStore.getState().teamLoadFailedByTask[taskId]).toBe(true);
    expect(useAppStore.getState().teamByTask[taskId]).toBeUndefined();
  });

  it('stays in Chat if promotion still returns no Team', async () => {
    const promote = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', {
      sprintCoder: {
        teams: {
          get: vi.fn().mockResolvedValue(null),
          promote,
        },
      },
    });
    useAppStore.setState({ selectedTaskId: taskId });
    await useAppStore.getState().toggleTeamView(taskId);
    expect(promote).toHaveBeenCalledExactlyOnceWith(taskId);
    expect(useAppStore.getState().teamViewOpen).toBe(false);
    expect(useAppStore.getState().teamBusy).toBe(false);
    expect(useAppStore.getState().error).toContain('Teamを取得できませんでした');
  });

  it('keeps an unfinished stop busy when returning to its Task and rejects a duplicate stop', async () => {
    const stopping = deferred<TeamDetail>();
    const stopAll = vi.fn().mockReturnValue(stopping.promise);
    vi.stubGlobal('window', {
      sprintCoder: {
        tasks: { messages: vi.fn().mockResolvedValue([]) },
        turns: {
          snapshot: vi.fn().mockResolvedValue(null),
          subscribe: vi.fn().mockReturnValue(vi.fn()),
        },
        teams: { stopAll, subscribe: vi.fn().mockReturnValue(vi.fn()) },
      },
    });
    useAppStore.setState({ selectedTaskId: taskId, turnByTask: {} });
    const stop = useAppStore.getState().stopAllTeamWorkers(taskId);
    await useAppStore.getState().selectTask('other');
    expect(useAppStore.getState().teamBusy).toBe(false);
    await useAppStore.getState().selectTask(taskId);
    const busyOnReturn = useAppStore.getState().teamBusy;
    const duplicate = useAppStore.getState().stopAllTeamWorkers(taskId);
    stopping.resolve({ team: { id: 'stopped' } } as unknown as TeamDetail);
    await Promise.all([stop, duplicate]);
    expect(busyOnReturn).toBe(true);
    expect(stopAll).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().teamBusy).toBe(false);
  });

  it('does not clear another Task toggle busy when an older stop finishes', async () => {
    const stopping = deferred<TeamDetail>();
    const reading = deferred<TeamDetail>();
    vi.stubGlobal('window', {
      sprintCoder: {
        tasks: { messages: vi.fn().mockResolvedValue([]) },
        turns: {
          snapshot: vi.fn().mockResolvedValue(null),
          subscribe: vi.fn().mockReturnValue(vi.fn()),
        },
        teams: {
          stopAll: vi.fn().mockReturnValue(stopping.promise),
          get: vi.fn().mockReturnValue(reading.promise),
          subscribe: vi.fn().mockReturnValue(vi.fn()),
        },
      },
    });
    useAppStore.setState({ selectedTaskId: taskId, turnByTask: {} });
    const stop = useAppStore.getState().stopAllTeamWorkers(taskId);
    await useAppStore.getState().selectTask('other');
    const toggle = useAppStore.getState().toggleTeamView('other');
    stopping.resolve({ team: { id: 'stopped' } } as unknown as TeamDetail);
    await stop;
    const busyWhileReading = useAppStore.getState().teamBusy;
    reading.resolve({ team: { id: 'new-team' } } as unknown as TeamDetail);
    await toggle;
    expect(busyWhileReading).toBe(true);
    expect(useAppStore.getState().teamBusy).toBe(false);
    expect(useAppStore.getState().teamViewOpen).toBe(true);
  });
});

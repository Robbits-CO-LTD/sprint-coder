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
});

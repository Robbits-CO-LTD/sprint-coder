import { IPC_CHANNELS } from '@sprint-coder/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_CONTROL_ACTIVITY_GRACE_MS,
  DesktopControlActivity,
  sendDesktopControlActivity,
} from './desktop-control-activity';

afterEach(() => {
  vi.useRealTimers();
});

describe('desktop-control activity', () => {
  it('is raised by the first run at once and lowered a grace period after the last one ends', () => {
    vi.useFakeTimers();
    const activity = new DesktopControlActivity();
    const seen: boolean[] = [];
    activity.subscribe((active) => seen.push(active));

    const endLeader = activity.begin();
    // Told before `begin` returns, so before the caller spawns anything.
    expect(seen).toEqual([true]);
    expect(activity.active).toBe(true);
    const endWorker = activity.begin();
    expect(seen).toEqual([true]);

    endLeader();
    vi.advanceTimersByTime(DESKTOP_CONTROL_ACTIVITY_GRACE_MS * 3);
    // The Worker's run still goes on.
    expect(seen).toEqual([true]);
    expect(activity.active).toBe(true);

    endWorker();
    // Ending a run twice counts once.
    endWorker();
    endLeader();
    vi.advanceTimersByTime(DESKTOP_CONTROL_ACTIVITY_GRACE_MS - 1);
    expect(activity.active).toBe(true);
    expect(seen).toEqual([true]);
    vi.advanceTimersByTime(1);
    expect(activity.active).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it('stays raised when another run begins within the grace period', () => {
    vi.useFakeTimers();
    const activity = new DesktopControlActivity(1_000);
    const seen: boolean[] = [];
    activity.subscribe((active) => seen.push(active));
    activity.begin()();
    vi.advanceTimersByTime(500);
    const end = activity.begin();
    vi.advanceTimersByTime(5_000);
    expect(seen).toEqual([true]);
    end();
    vi.advanceTimersByTime(1_000);
    expect(seen).toEqual([true, false]);
    // And it is raised again by the next run.
    activity.begin();
    expect(seen).toEqual([true, false, true]);
  });

  it('never lets a failing listener stop a run or the other listeners', () => {
    vi.useFakeTimers();
    const activity = new DesktopControlActivity(0);
    const seen: boolean[] = [];
    activity.subscribe(() => {
      throw new Error('window gone');
    });
    const unsubscribe = activity.subscribe((active) => seen.push(active));
    const end = activity.begin();
    end();
    vi.advanceTimersByTime(0);
    expect(seen).toEqual([true, false]);
    unsubscribe();
    activity.begin();
    expect(seen).toEqual([true, false]);
  });

  it('sends the state on its channel to every window that is still there', () => {
    const sent: unknown[][] = [];
    const live = { isDestroyed: () => false, send: (...args: unknown[]) => void sent.push(args) };
    const closed = {
      isDestroyed: () => true,
      send: () => {
        throw new Error('sent to a destroyed window');
      },
    };
    const closing = {
      isDestroyed: () => false,
      send: () => {
        throw new Error('Object has been destroyed');
      },
    };
    sendDesktopControlActivity([closed, closing, live], true);
    sendDesktopControlActivity([live], false);
    expect(sent).toEqual([
      [IPC_CHANNELS.desktopControlActivityEvent, { active: true }],
      [IPC_CHANNELS.desktopControlActivityEvent, { active: false }],
    ]);
  });
});

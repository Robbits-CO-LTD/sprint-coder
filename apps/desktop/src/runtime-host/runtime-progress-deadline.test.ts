import { describe, expect, it, vi } from 'vitest';
import { RuntimeProgressDeadline } from './runtime-progress-deadline';

describe('RuntimeProgressDeadline', () => {
  it('ends a Turn whose CLI never emits its first event', async () => {
    vi.useFakeTimers();
    try {
      const phases: string[] = [];
      const deadline = new RuntimeProgressDeadline(
        { firstEventMs: 45_000, idleMs: 90_000, totalMs: 3_600_000 },
        (phase) => phases.push(phase),
      );

      deadline.start();
      await vi.advanceTimersByTimeAsync(44_999);
      expect(phases).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(phases).toEqual(['first_event']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets an idle deadline whenever the CLI makes progress', async () => {
    vi.useFakeTimers();
    try {
      const phases: string[] = [];
      const deadline = new RuntimeProgressDeadline(
        { firstEventMs: 45_000, idleMs: 90_000, totalMs: 3_600_000 },
        (phase) => phases.push(phase),
      );

      deadline.start();
      deadline.progress();
      await vi.advanceTimersByTimeAsync(89_999);
      deadline.progress();
      await vi.advanceTimersByTimeAsync(89_999);
      expect(phases).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(phases).toEqual(['idle']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains the Team Turn total limit even while events keep arriving', async () => {
    vi.useFakeTimers();
    try {
      const phases: string[] = [];
      const deadline = new RuntimeProgressDeadline(
        { firstEventMs: 45_000, idleMs: 90_000, totalMs: 180_000 },
        (phase) => phases.push(phase),
      );

      deadline.start();
      for (let elapsed = 30_000; elapsed < 180_000; elapsed += 30_000) {
        await vi.advanceTimersByTimeAsync(30_000);
        deadline.progress();
      }
      expect(phases).toEqual([]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(phases).toEqual(['total']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves no timer after a completed Turn stops the deadline', () => {
    vi.useFakeTimers();
    try {
      const deadline = new RuntimeProgressDeadline(
        { firstEventMs: 45_000, idleMs: 90_000, totalMs: 3_600_000 },
        () => undefined,
      );
      deadline.start();
      deadline.progress();
      deadline.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

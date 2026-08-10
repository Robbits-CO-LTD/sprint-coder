import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeStartAcceptanceDeadline } from './runtime-start-acceptance-deadline';

describe('RuntimeStartAcceptanceDeadline', () => {
  afterEach(() => vi.useRealTimers());

  it('fails a Runtime start that is never acknowledged', () => {
    vi.useFakeTimers();
    const timedOut = vi.fn();
    const deadline = new RuntimeStartAcceptanceDeadline(10_000, timedOut);

    deadline.start();
    vi.advanceTimersByTime(9_999);
    expect(timedOut).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(timedOut).toHaveBeenCalledOnce();
  });

  it('does not fail after the Runtime acknowledges the start', () => {
    vi.useFakeTimers();
    const timedOut = vi.fn();
    const deadline = new RuntimeStartAcceptanceDeadline(10_000, timedOut);

    deadline.start();
    deadline.accept();
    vi.advanceTimersByTime(10_000);
    expect(timedOut).not.toHaveBeenCalled();
  });
});

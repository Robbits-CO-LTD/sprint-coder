import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnStreamingResources } from './turn-streaming-resources';

describe('TurnStreamingResources', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('owns active Turns independently and drops raw carry while flushing each safe tail once', () => {
    const emit = vi.fn();
    const resources = new TurnStreamingResources(emit);
    const a = resources.begin('task-a', 'turn-a')!;
    const b = resources.begin('task-b', 'turn-b')!;
    expect(resources.begin('task-a', 'turn-a')).toBe(a);
    expect(() => resources.begin('foreign', 'turn-a')).toThrow('identity mismatch');
    expect(resources.get('foreign', 'turn-a')).toBeUndefined();
    const stop = vi.fn(() => resources.release('turn-a'));
    a.replaceWatchers(() => [{ stop }]);
    a.pushReasoning('safe tail\npassword=unflushed-secret');
    b.pushReasoning('other tail\n');
    expect(vi.getTimerCount()).toBe(2);
    resources.release('turn-a');
    resources.release('turn-a');
    expect(resources.size).toBe(1);
    expect(resources.get('task-b', 'turn-b')).toBe(b);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledExactlyOnceWith('task-a', 'turn-a', {
      text: 'safe tail\n',
      truncated: false,
    });
    a.pushReasoning('late\n');
    const create = vi.fn(() => []);
    a.replaceWatchers(create);
    expect(create).not.toHaveBeenCalled();
    resources.release('turn-b');
    expect(emit).toHaveBeenLastCalledWith('task-b', 'turn-b', {
      text: 'other tail\n',
      truncated: false,
    });
    expect(JSON.stringify(emit.mock.calls)).not.toContain('unflushed-secret');
    expect(resources.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('invalidates replaced and released watcher groups before callbacks can read', () => {
    const resources = new TurnStreamingResources(vi.fn());
    const lease = resources.begin('task', 'turn')!;
    const read = vi.fn();
    let oldCallback = () => {};
    const stop = vi.fn();
    lease.replaceWatchers((isCurrent) => {
      oldCallback = () => {
        if (isCurrent()) read();
      };
      return [{ stop }];
    });
    oldCallback();
    expect(read).toHaveBeenCalledTimes(1);
    lease.replaceWatchers(() => []);
    oldCallback();
    expect(read).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    resources.release('turn');
    const next = resources.begin('task', 'turn')!;
    expect(next).not.toBe(lease);
    oldCallback();
    expect(read).toHaveBeenCalledTimes(1);
    resources.dispose();
    expect(resources.size).toBe(0);
  });

  it.each(['release', 'dispose'] as const)(
    'stops returned handles if a factory reenters %s',
    (end) => {
      const resources = new TurnStreamingResources(vi.fn());
      const lease = resources.begin('task', 'turn')!;
      const stop = vi.fn();
      let valid = () => true;
      lease.replaceWatchers((isCurrent) => {
        valid = isCurrent;
        if (end === 'release') resources.release('turn');
        else resources.dispose();
        return [{ stop }];
      });
      expect(valid()).toBe(false);
      expect(stop).toHaveBeenCalledTimes(1);
      resources.dispose();
      expect(stop).toHaveBeenCalledTimes(1);
    },
  );

  it('retains the newer group when a factory replaces itself before returning handles', () => {
    const resources = new TurnStreamingResources(vi.fn());
    const lease = resources.begin('task', 'turn')!;
    const outerStop = vi.fn();
    const innerStop = vi.fn();
    let outerCurrent = () => true;
    let innerCurrent = () => false;
    lease.replaceWatchers((isCurrent) => {
      outerCurrent = isCurrent;
      lease.replaceWatchers((current) => {
        innerCurrent = current;
        return [{ stop: innerStop }];
      });
      return [{ stop: outerStop }];
    });
    expect(outerCurrent()).toBe(false);
    expect(innerCurrent()).toBe(true);
    expect(outerStop).toHaveBeenCalledTimes(1);
    expect(innerStop).not.toHaveBeenCalled();
    resources.release('turn');
    expect(innerStop).toHaveBeenCalledTimes(1);
    expect(innerCurrent()).toBe(false);
  });

  it('does not overwrite a reentrant replacement started by the old watcher stop', () => {
    const resources = new TurnStreamingResources(vi.fn());
    const lease = resources.begin('task', 'turn')!;
    const innerStop = vi.fn();
    const oldStop = vi.fn(() => lease.replaceWatchers(() => [{ stop: innerStop }]));
    lease.replaceWatchers(() => [{ stop: oldStop }]);
    const supersededFactory = vi.fn(() => []);
    lease.replaceWatchers(supersededFactory);
    expect(supersededFactory).not.toHaveBeenCalled();
    expect(oldStop).toHaveBeenCalledTimes(1);
    resources.release('turn');
    expect(innerStop).toHaveBeenCalledTimes(1);
  });

  it('invalidates captured input on every lease before the first dispose flush can reenter', () => {
    const read = vi.fn();
    let callback = () => {};
    const emit = vi.fn((taskId: string) => {
      expect(resources.size).toBe(0);
      expect(resources.begin('new-task', 'new-turn')).toBeUndefined();
      expect(resources.get('task-b', 'turn-b')).toBeUndefined();
      if (taskId === 'task-a') {
        b.pushReasoning('late after disposal\n');
        callback();
        resources.dispose();
      }
    });
    const resources = new TurnStreamingResources(emit);
    const a = resources.begin('task-a', 'turn-a')!;
    const b = resources.begin('task-b', 'turn-b')!;
    const stopA = vi.fn();
    const stopB = vi.fn();
    a.replaceWatchers(() => [{ stop: stopA }]);
    b.replaceWatchers((isCurrent) => {
      callback = () => {
        if (isCurrent()) read();
      };
      return [{ stop: stopB }];
    });
    a.pushReasoning('A\n');
    b.pushReasoning('B\n');
    resources.dispose();
    resources.dispose();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith('task-b', 'turn-b', { text: 'B\n', truncated: false });
    expect(read).not.toHaveBeenCalled();
    expect(stopA).toHaveBeenCalledTimes(1);
    expect(stopB).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('detaches resources before a throwing final sink and still closes the other live leases', () => {
    const failure = new Error('sink unavailable');
    const resources = new TurnStreamingResources((taskId) => {
      expect(resources.size).toBe(0);
      resources.release('a');
      if (taskId === 'a') throw failure;
    });
    const stopA = vi.fn();
    const stopB = vi.fn();
    for (const [id, stop] of [
      ['a', stopA],
      ['b', stopB],
    ] as const) {
      const lease = resources.begin(id, id)!;
      lease.replaceWatchers(() => [{ stop }]);
      lease.pushReasoning('tail\n');
    }
    expect(() => resources.dispose()).toThrow(failure);
    expect(() => resources.dispose()).not.toThrow();
    expect(stopA).toHaveBeenCalledTimes(1);
    expect(stopB).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains no completed Turn entries or timers across many lifetimes', () => {
    const resources = new TurnStreamingResources(vi.fn());
    for (let i = 0; i < 200; i++) {
      const id = `turn-${i}`;
      const lease = resources.begin('task', id)!;
      lease.pushReasoning('safe\n');
      expect(resources.size).toBe(1);
      resources.release(id);
      lease.pushReasoning('late\n');
      expect(resources.get('task', id)).toBeUndefined();
      expect(resources.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchPixelRatio } from './pixel-ratio';

afterEach(() => {
  vi.unstubAllGlobals();
});

type Listener = () => void;

/** `matchMedia` for a screen whose pixel ratio can be changed. */
function screen(initial: number) {
  let ratio = initial;
  const asked: string[] = [];
  const live = new Map<string, Set<Listener>>();
  vi.stubGlobal('devicePixelRatio', ratio);
  vi.stubGlobal('matchMedia', (query: string) => {
    asked.push(query);
    const listeners = live.get(query) ?? new Set<Listener>();
    live.set(query, listeners);
    return {
      media: query,
      addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
    };
  });
  return {
    asked,
    listening: () => [...live.values()].reduce((sum, set) => sum + set.size, 0),
    change(next: number) {
      const stale = [...(live.get(`(resolution: ${ratio}dppx)`) ?? [])];
      ratio = next;
      vi.stubGlobal('devicePixelRatio', ratio);
      for (const listener of stale) listener();
    },
  };
}

describe('watchPixelRatio', () => {
  it('tells of every change, watching the ratio of the moment each time', () => {
    const display = screen(1);
    const onChange = vi.fn();
    const stop = watchPixelRatio(onChange);
    expect(display.asked).toEqual(['(resolution: 1dppx)']);
    expect(onChange).not.toHaveBeenCalled();
    display.change(1.5);
    expect(onChange).toHaveBeenCalledTimes(1);
    display.change(2);
    display.change(1);
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(display.asked).toEqual([
      '(resolution: 1dppx)',
      '(resolution: 1.5dppx)',
      '(resolution: 2dppx)',
      '(resolution: 1dppx)',
    ]);
    // Only the query for the ratio of the moment is listened to.
    expect(display.listening()).toBe(1);
    stop();
    expect(display.listening()).toBe(0);
    display.change(3);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('a "change" with the ratio as it was is nothing: no call, and it keeps watching', () => {
    // A stand-in that tells every listener of every change (as some tests' do), walking its live
    // set: a listener that took itself out and put itself back would be told without end.
    const listeners = new Set<Listener>();
    vi.stubGlobal('devicePixelRatio', 1);
    vi.stubGlobal('matchMedia', (query: string) => ({
      media: query,
      addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
    }));
    const onChange = vi.fn();
    const stop = watchPixelRatio(onChange);
    for (const listener of listeners) listener();
    expect(onChange).not.toHaveBeenCalled();
    expect(listeners.size).toBe(1);
    vi.stubGlobal('devicePixelRatio', 2);
    for (const listener of [...listeners]) listener();
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
    expect(listeners.size).toBe(0);
  });

  it('is quiet where media queries are missing or cannot be listened to', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(() => watchPixelRatio(() => {})()).not.toThrow();
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(() => watchPixelRatio(() => {})()).not.toThrow();
    vi.stubGlobal('matchMedia', () => {
      throw new Error('no such query');
    });
    expect(() => watchPixelRatio(() => {})()).not.toThrow();
  });
});

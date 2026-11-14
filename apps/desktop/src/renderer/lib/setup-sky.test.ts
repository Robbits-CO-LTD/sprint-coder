// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetupSky } from './setup-sky';

function fakeContext(): CanvasRenderingContext2D {
  return new Proxy({} as Record<string | symbol, unknown>, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'createRadialGradient') return () => ({ addColorStop() {} });
      return () => undefined;
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A screen whose pixel ratio can be changed: `matchMedia` answers for the ratio of the moment and
 * tells its listeners when a query stops matching, as a browser does. */
function stubPixelRatio(initial: number) {
  let ratio = initial;
  const queries: { at: number; listeners: Set<() => void> }[] = [];
  vi.stubGlobal('devicePixelRatio', ratio);
  vi.stubGlobal('matchMedia', (query: string) => {
    const entry = { at: Number(/([\d.]+)dppx/.exec(query)?.[1]), listeners: new Set<() => void>() };
    queries.push(entry);
    return {
      media: query,
      get matches() {
        return entry.at === ratio;
      },
      addEventListener: (_type: string, listener: () => void) => entry.listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) =>
        entry.listeners.delete(listener),
    };
  });
  return {
    change(next: number) {
      const before = ratio;
      ratio = next;
      vi.stubGlobal('devicePixelRatio', ratio);
      // (A listener asks for a new query: only those there before the change are told.)
      for (const entry of [...queries]) {
        if ((entry.at === before) !== (entry.at === next)) {
          for (const listener of [...entry.listeners]) listener();
        }
      }
    },
    listening: () => queries.reduce((sum, entry) => sum + entry.listeners.size, 0),
  };
}

describe('SetupSky', () => {
  it('thins its lists as it goes: cursors that left, and a celebration that is over, are gone', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    const ctx = fakeContext();
    const drawImage = vi.fn();
    (ctx as unknown as Record<string, unknown>).drawImage = drawImage;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx);
    const parent = document.createElement('div');
    const canvas = document.createElement('canvas');
    parent.append(canvas);
    vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue({
      width: 800,
      height: 600,
    } as DOMRect);
    const sky = new SetupSky(canvas, { animate: true });
    sky.setDensity(20);
    const perFrame = () => {
      drawImage.mockClear();
      vi.advanceTimersByTime(16.7);
      return drawImage.mock.calls.length;
    };
    vi.advanceTimersByTime(200);
    // Twenty specks, one glow each.
    expect(perFrame()).toBe(20);
    sky.setTeam('proactive');
    sky.celebrate();
    sky.ripple(400, 300);
    vi.advanceTimersByTime(500);
    // Five cursors (a halo and a light each) and 140 sparks are drawn as well.
    expect(perFrame()).toBe(20 + 5 * 2 + 140);
    sky.setTeam(null);
    vi.advanceTimersByTime(6000);
    // The cursors have faded out and the celebration has ended: only the specks are left.
    expect(sky.activeTeam()).toEqual([]);
    expect(perFrame()).toBe(20);
    sky.destroy();
  });

  it('runs one frame loop with motion, and stops it and its listeners for good on destroy', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext());
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    const docAdded = vi.spyOn(document, 'addEventListener');
    const docRemoved = vi.spyOn(document, 'removeEventListener');
    const sky = new SetupSky(document.createElement('canvas'), { animate: true });
    expect(sky.isRunning).toBe(true);
    sky.setTeam('proactive', 0.9);
    sky.ripple(10, 10);
    sky.warp(1);
    sky.celebrate();
    vi.advanceTimersByTime(3000);
    sky.setTeam('explicit');
    sky.implode();
    vi.advanceTimersByTime(1000);
    expect(vi.getTimerCount()).toBe(1); // exactly the next frame
    sky.destroy();
    expect(sky.isRunning).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    for (const [type, listener] of added.mock.calls.filter(([t]) => t === 'resize'))
      expect(removed).toHaveBeenCalledWith(type, listener);
    for (const [type, listener] of docAdded.mock.calls.filter(([t]) => t === 'visibilitychange'))
      expect(docRemoved).toHaveBeenCalledWith(type, listener);
  });

  it('pauses while the page is hidden', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext());
    const sky = new SetupSky(document.createElement('canvas'), { animate: true });
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sky.isRunning).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sky.isRunning).toBe(true);
    sky.destroy();
  });

  it('without motion draws a still picture and never schedules a frame', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext());
    const sky = new SetupSky(document.createElement('canvas'), { animate: false });
    sky.setTeam('auto');
    sky.ripple(1, 1);
    sky.celebrate();
    expect(sky.isRunning).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    sky.destroy();
  });

  it('does nothing harmful where there is no 2D context', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const sky = new SetupSky(document.createElement('canvas'), { animate: true });
    expect(sky.isRunning).toBe(false);
    sky.setTeam('proactive');
    sky.destroy();
  });

  describe('Team cursors follow the chosen way of working', () => {
    const roles = (sky: SetupSky) =>
      sky
        .activeTeam()
        .map((c) => `${c.label}${c.lane}${c.helper ? 'h' : ''}`)
        .sort();
    const make = () => {
      vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext());
      return new SetupSky(document.createElement('canvas'), { animate: true });
    };

    it('おまかせ -> 積極的に: four teammates who stay, none of them only for the big job', () => {
      const sky = make();
      sky.setTeam('auto');
      vi.advanceTimersByTime(500);
      sky.setTeam('proactive');
      expect(roles(sky)).toEqual(['AI0', '仲間-1', '仲間-2', '仲間1', '仲間2']);
      sky.destroy();
    });

    it('積極的に -> おまかせ: two teammates who come only with the big job', () => {
      const sky = make();
      sky.setTeam('proactive');
      vi.advanceTimersByTime(500);
      sky.setTeam('auto');
      expect(roles(sky)).toEqual(['AI0', '仲間-1h', '仲間1h']);
      sky.destroy();
    });

    it.each(['proactive', 'auto'] as const)(
      '%s: every teammate settles into the formation, and none runs backwards when the leader wraps round',
      (mode) => {
        vi.useFakeTimers({
          toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'],
        });
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext());
        const width = 1280;
        const parent = document.createElement('div');
        const canvas = document.createElement('canvas');
        parent.append(canvas);
        vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue({
          width,
          height: 820,
          top: 0,
          left: 0,
          right: width,
          bottom: 820,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect);
        const sky = new SetupSky(canvas, { animate: true });
        sky.setTeam(mode, 0.86, 0.045);
        const xs = new Map<string, number[]>();
        const arrivals = new Map<string, Set<number>>();
        const settledAt = new Map<string, number>();
        // 16 seconds: the leader crosses the window about four times (one crossing ≈ 3.7 s).
        for (let frame = 0; frame < 960; frame += 1) {
          vi.advanceTimersByTime(16.7);
          for (const cursor of sky.activeTeam()) {
            const key = `${cursor.label}${cursor.lane}`;
            if (!xs.has(key)) {
              xs.set(key, []);
              arrivals.set(key, new Set());
            }
            const series = xs.get(key)!;
            if (cursor.catching && settledAt.has(key)) arrivals.get(key)!.add(series.length);
            series.push(cursor.x);
            if (!cursor.catching && !settledAt.has(key)) settledAt.set(key, frame);
            if (cursor.catching) settledAt.delete(key);
          }
        }
        const lane = (key: string) => Number(key.replace('仲間', ''));
        // The first frame at which the cursor stepped backwards on screen, or -1. Not counted: a
        // wrap round (it lands before the left edge), and a helper arriving again with the next
        // big job (it starts over from the edge, having faded out meanwhile).
        const backwardsOnScreen = (key: string, from = 0) =>
          xs
            .get(key)!
            .findIndex(
              (x, at) =>
                at > from &&
                x < xs.get(key)![at - 1]! - 0.001 &&
                x >= 0 &&
                !arrivals.get(key)!.has(at),
            );
        const workers = [...xs.keys()].filter((key) => key !== 'AI0');
        expect(workers.length).toBe(mode === 'proactive' ? 4 : 2);
        for (const key of workers) {
          // Each settles within the run (a helper settles again after each arrival).
          expect(settledAt.get(key), key).toBeDefined();
          // One arriving from the left never runs backwards on screen, before or after the
          // leader wraps round. (One from the right dives in leftwards, until it has its place.)
          if (lane(key) < 0) expect(backwardsOnScreen(key), key).toBe(-1);
        }
        if (mode === 'proactive') {
          // Settled: everyone keeps the leader's pace, a fixed distance behind it, wrap after wrap.
          const span = width + 160;
          const lead = xs.get('AI0')!.slice(-600);
          for (const key of workers) {
            const series = xs.get(key)!.slice(-600);
            expect(backwardsOnScreen(key, xs.get(key)!.length - 600), key).toBe(-1);
            for (let at = 0; at < series.length; at += 1) {
              const gap = (((lead[at]! - series[at]!) % span) + span) % span;
              expect(gap, `${key} at ${at}`).toBeCloseTo(50 + Math.abs(lane(key)) * 64, 0);
            }
          }
        }
        sky.destroy();
      },
    );

    it('a quick back-and-forth does not lose the teammates', () => {
      const sky = make();
      sky.setTeam('auto');
      sky.setTeam('proactive');
      sky.setTeam('auto');
      expect(roles(sky)).toEqual(['AI0', '仲間-1h', '仲間1h']);
      sky.setTeam('explicit');
      expect(roles(sky)).toEqual(['AI0']);
      sky.setTeam('proactive');
      sky.setTeam('explicit');
      sky.setTeam('proactive');
      expect(roles(sky)).toEqual(['AI0', '仲間-1', '仲間-2', '仲間1', '仲間2']);
      sky.destroy();
    });
  });

  describe('the drawing surface', () => {
    const boxed = (width: number, height: number) => {
      const parent = document.createElement('div');
      const canvas = document.createElement('canvas');
      parent.append(canvas);
      vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue({
        width,
        height,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);
      return canvas;
    };

    it('caps the pixels behind a huge window by lowering the resolution', () => {
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext());
      const sky = new SetupSky(boxed(7680, 4320), { animate: false });
      const { width, height } = sky.backingSize;
      expect(width * height).toBeLessThanOrEqual(4_300_000);
      expect(width / height).toBeCloseTo(7680 / 4320, 1);
      sky.destroy();
    });

    it('draws nothing while its box has no size (a dialog not open yet)', () => {
      const ctx = fakeContext();
      const drawImage = vi.fn();
      (ctx as unknown as Record<string, unknown>).drawImage = drawImage;
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx);
      const sky = new SetupSky(boxed(0, 0), { animate: false });
      sky.setTeam('proactive');
      expect(drawImage).not.toHaveBeenCalled();
      sky.destroy();
    });

    it('follows the pixel ratio of the screen when that alone changes (the box keeps its size)', () => {
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext());
      const ratio = stubPixelRatio(1);
      const sky = new SetupSky(boxed(800, 600), { animate: false });
      expect(sky.backingSize).toEqual({ width: 800, height: 600 });
      // The window moves to a denser screen: same box, twice the pixels.
      ratio.change(2);
      expect(sky.backingSize).toEqual({ width: 1600, height: 1200 });
      // And on to another: each change is followed, not only the first.
      ratio.change(1.5);
      expect(sky.backingSize).toEqual({ width: 1200, height: 900 });
      sky.destroy();
      expect(ratio.listening()).toBe(0);
      ratio.change(1);
      expect(sky.backingSize).toEqual({ width: 1200, height: 900 });
    });

    it('while its loop runs, it follows the pixel ratio with the next frame, told or not', () => {
      // Chromium does not always report the change (seen under device emulation: no event until
      // the viewport's size changes too), so the running loop looks for itself.
      vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext());
      vi.stubGlobal('devicePixelRatio', 1);
      const canvas = boxed(800, 600);
      const measured = vi.mocked(canvas.parentElement!.getBoundingClientRect);
      const sky = new SetupSky(canvas, { animate: true });
      expect(sky.backingSize).toEqual({ width: 800, height: 600 });
      vi.advanceTimersByTime(100);
      // No look at the box while nothing changes.
      const looks = measured.mock.calls.length;
      vi.advanceTimersByTime(500);
      expect(measured.mock.calls.length).toBe(looks);
      vi.stubGlobal('devicePixelRatio', 2);
      vi.advanceTimersByTime(17);
      expect(sky.backingSize).toEqual({ width: 1600, height: 1200 });
      // Sized once for the change, not again on every frame after it.
      vi.advanceTimersByTime(500);
      expect(measured.mock.calls.length).toBe(looks + 1);
      sky.destroy();
    });

    it('without motion, the same look set again leaves the still picture as it is', () => {
      const ctx = fakeContext();
      const clearRect = vi.fn();
      (ctx as unknown as Record<string, unknown>).clearRect = clearRect;
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx);
      const random = vi.spyOn(Math, 'random');
      const sky = new SetupSky(boxed(800, 600), { animate: false });
      const look = { colors: ['#45befc', '#c679fd'], speed: 0.7 } as const;
      sky.setTheme(look);
      sky.setDensity(80);
      sky.setTeam(null);
      const drawn = clearRect.mock.calls.length;
      const rolled = random.mock.calls.length;
      // What the Setup does for every letter typed into the call name: the same look once more.
      for (let letter = 0; letter < 5; letter += 1) {
        sky.setTheme({ ...look });
        sky.setDensity(80);
        sky.setTeam(null);
      }
      expect(clearRect.mock.calls.length).toBe(drawn);
      expect(random.mock.calls.length).toBe(rolled);
      // A look that does differ is drawn.
      sky.setTheme({ ...look, speed: 1.9 });
      expect(clearRect.mock.calls.length).toBe(drawn + 1);
      sky.setDensity(160);
      expect(clearRect.mock.calls.length).toBe(drawn + 2);
      sky.destroy();
    });

    it('a drawing error stops the loop instead of leaving it half running', () => {
      vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
      const ctx = fakeContext();
      (ctx as unknown as Record<string, unknown>).clearRect = () => {
        throw new Error('lost');
      };
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx);
      const sky = new SetupSky(boxed(800, 600), { animate: true });
      vi.advanceTimersByTime(100);
      expect(sky.isRunning).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      sky.destroy();
    });
  });
});

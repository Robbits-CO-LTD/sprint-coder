// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetupSky } from './setup-sky';

function fakeContext(): CanvasRenderingContext2D {
  return new Proxy({} as Record<string | symbol, unknown>, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'measureText') return () => ({ width: 10 });
      if (key === 'getImageData')
        return (_x: number, _y: number, w: number, h: number) => {
          // A filled block in the middle, so the opening has points to gather on.
          const data = new Uint8ClampedArray(w * h * 4);
          for (let y = Math.floor(h * 0.4); y < h * 0.45; y += 1)
            for (let x = Math.floor(w * 0.4); x < w * 0.6; x += 1) data[(y * w + x) * 4 + 3] = 255;
          return { data };
        };
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
});

describe('SetupSky', () => {
  it('runs one frame loop with motion, and stops it and its listeners for good on destroy', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext());
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    const docAdded = vi.spyOn(document, 'addEventListener');
    const docRemoved = vi.spyOn(document, 'removeEventListener');
    const sky = new SetupSky(document.createElement('canvas'), { animate: true });
    expect(sky.isRunning).toBe(true);
    sky.playIntro('SPRINT CODER');
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
    sky.playIntro('SPRINT CODER');
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

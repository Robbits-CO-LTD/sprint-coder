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
});

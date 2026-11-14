// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetupTeamField } from './setup-team-field';

function fakeContext(calls: string[] = []): CanvasRenderingContext2D {
  return new Proxy({} as Record<string | symbol, unknown>, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'createRadialGradient' || key === 'createLinearGradient')
        return () => ({ addColorStop() {} });
      return () => {
        calls.push(String(key));
      };
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

/** A canvas inside a stage of a real size (jsdom lays nothing out). */
function stagedCanvas(width = 600, height = 400): HTMLCanvasElement {
  const stage = document.createElement('div');
  stage.getBoundingClientRect = () => ({ width, height }) as DOMRect;
  const canvas = document.createElement('canvas');
  stage.append(canvas);
  return canvas;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SetupTeamField', () => {
  it('follows the pixel ratio of the screen when that alone changes (issue #1242)', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext());
    vi.stubGlobal('devicePixelRatio', 1);
    // With motion: the running loop sees it, with the next frame.
    const canvas = stagedCanvas(600, 400);
    const field = new SetupTeamField(canvas, { animate: true, mode: 'proactive' });
    expect([canvas.width, canvas.height]).toEqual([600, 400]);
    vi.stubGlobal('devicePixelRatio', 2);
    vi.advanceTimersByTime(17);
    expect([canvas.width, canvas.height]).toEqual([1200, 800]);
    field.destroy();

    // Without motion there is no loop: it is told by the media query for the ratio it was sized for.
    const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', (query: string) => ({
      media: query,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    }));
    const stillCanvas = stagedCanvas(600, 400);
    const still = new SetupTeamField(stillCanvas, { animate: false, mode: 'proactive' });
    expect([stillCanvas.width, stillCanvas.height]).toEqual([1200, 800]);
    vi.stubGlobal('devicePixelRatio', 1);
    for (const listener of [...listeners]) listener();
    expect([stillCanvas.width, stillCanvas.height]).toEqual([600, 400]);
    still.destroy();
    expect(listeners.size).toBe(0);
  });

  it('is sized for its stage as laid out, not as drawn while the scene is still coming in', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext());
    vi.stubGlobal('devicePixelRatio', 1);
    // The scene comes in at 97% of its size: that is what the drawn box says at this moment.
    const canvas = stagedCanvas(620.8, 700.34);
    const stage = canvas.parentElement!;
    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 640 });
    Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 722 });
    const field = new SetupTeamField(canvas, { animate: false, mode: 'proactive' });
    expect([canvas.width, canvas.height]).toEqual([640, 722]);
    field.destroy();
  });

  it('shows one light, one light and its helpers, or the whole field', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext());
    const field = new SetupTeamField(stagedCanvas(), { animate: true, mode: 'explicit' });
    expect(field.fullCount).toBe(1);
    field.setMode('auto');
    expect(field.fullCount).toBe(9);
    field.setMode('proactive');
    expect(field.fullCount).toBe(72);
    field.destroy();
  });

  it('runs one frame loop with motion, and stops it and its listeners for good on destroy', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    const calls: string[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() =>
      fakeContext(calls),
    );
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    const docAdded = vi.spyOn(document, 'addEventListener');
    const docRemoved = vi.spyOn(document, 'removeEventListener');
    const field = new SetupTeamField(stagedCanvas(), { animate: true, mode: 'proactive' });
    expect(field.isRunning).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(calls.filter((name) => name === 'drawImage').length).toBeGreaterThan(72);
    field.setMode('auto');
    vi.advanceTimersByTime(6000);
    expect(vi.getTimerCount()).toBe(1); // exactly the next frame
    field.destroy();
    expect(field.isRunning).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    for (const [type, listener] of added.mock.calls.filter(([t]) => t === 'resize'))
      expect(removed).toHaveBeenCalledWith(type, listener);
    for (const [type, listener] of docAdded.mock.calls.filter(([t]) => t === 'visibilitychange'))
      expect(docRemoved).toHaveBeenCalledWith(type, listener);
    // Nothing starts it again afterwards.
    document.dispatchEvent(new Event('visibilitychange'));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pauses while the page is hidden', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext());
    const field = new SetupTeamField(stagedCanvas(), { animate: true, mode: 'auto' });
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(field.isRunning).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(field.isRunning).toBe(true);
    field.destroy();
  });

  it('without motion draws a still picture, again on a change of mode, and never schedules a frame', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    const calls: string[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() =>
      fakeContext(calls),
    );
    const field = new SetupTeamField(stagedCanvas(), { animate: false, mode: 'explicit' });
    expect(field.isRunning).toBe(false);
    // The one light: its streak and its glow.
    const one = calls.filter((name) => name === 'drawImage').length;
    expect(one).toBe(2);
    calls.length = 0;
    field.setMode('proactive');
    expect(calls.filter((name) => name === 'drawImage').length).toBe(72 * 2);
    expect(vi.getTimerCount()).toBe(0);
    field.destroy();
  });

  it('does nothing, without failing, where there is no canvas or no room', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
    const none = new SetupTeamField(stagedCanvas(), { animate: true, mode: 'auto' });
    expect(none.isRunning).toBe(false);
    none.setMode('proactive');
    none.destroy();
    vi.restoreAllMocks();
    const calls: string[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() =>
      fakeContext(calls),
    );
    const flat = new SetupTeamField(stagedCanvas(0, 0), { animate: false, mode: 'proactive' });
    expect(calls.filter((name) => name === 'drawImage')).toEqual([]);
    flat.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOGO_INTRO_SEEN_KEY,
  readLogoIntroSeen,
  SetupLogoIntro,
  writeLogoIntroSeen,
} from './setup-logo-intro';
import type { LogoIntroSound } from './setup-logo-sound';
import {
  LOGO_SKIP_MS,
  logoHandoffAt,
  logoIntroDuration,
  type LogoIntroVariant,
} from './setup-logo-timeline';

/** A stand-in drawing surface: every call is accepted; the icon it "reads" is all logo colour. */
function fakeContext(calls?: string[]): CanvasRenderingContext2D {
  return new Proxy({} as Record<string | symbol, unknown>, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'measureText') return (text: string) => ({ width: 10 * text.length });
      if (key === 'getImageData')
        return (_x: number, _y: number, w: number, h: number) => {
          const data = new Uint8ClampedArray(w * h * 4);
          for (let p = 0; p < data.length; p += 4) {
            data[p] = 69;
            data[p + 1] = 190;
            data[p + 2] = 252;
            data[p + 3] = 255;
          }
          return { data };
        };
      if (key === 'createRadialGradient' || key === 'createLinearGradient')
        return () => ({ addColorStop() {} });
      return (...args: unknown[]) => {
        if (calls && typeof key === 'string') calls.push(args.length > 0 ? key : `${key}()`);
        return undefined;
      };
    },
    set(target, key, value) {
      target[key] = value;
      if (calls && typeof key === 'string') calls.push(`set ${key}`);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

const FRAME = 16;

function stage(size: { width: number; height: number } | null = { width: 960, height: 640 }) {
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  parent.appendChild(canvas);
  if (size)
    vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue({
      ...size,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: size.width,
      bottom: size.height,
      toJSON: () => ({}),
    });
  return canvas;
}

function film(
  variant: LogoIntroVariant,
  options: {
    canvas?: HTMLCanvasElement;
    loadImage?: (url: string) => Promise<CanvasImageSource>;
    sound?: LogoIntroSound;
  } = {},
) {
  const events: string[] = [];
  const instance = new SetupLogoIntro(options.canvas ?? stage(), {
    variant,
    iconUrl: 'icon.png',
    onHandoff: () => events.push(`handoff@${Math.round(performance.now())}`),
    onDone: () => events.push(`done@${Math.round(performance.now())}`),
    ...(options.sound ? { sound: options.sound } : {}),
    loadImage: options.loadImage ?? (() => Promise.resolve({} as CanvasImageSource)),
  });
  return { instance, events };
}

/** Lets the logo "load" (promises settle) without moving the clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

const timeOf = (event: string | undefined): number => Number(event?.split('@')[1]);

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'performance',
    ],
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext());
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SetupLogoIntro (the film on its canvas)', () => {
  it('plays the full film to its end: hands over at the last scene, is done at ten seconds, and leaves nothing running', async () => {
    const { instance, events } = film('full');
    expect(instance.isRunning).toBe(true);
    await settle();
    vi.advanceTimersByTime(logoHandoffAt('full') - 100);
    expect(events).toEqual([]);
    expect(vi.getTimerCount()).toBe(1); // exactly the next frame
    vi.advanceTimersByTime(100 + FRAME);
    expect(events).toHaveLength(1);
    expect(timeOf(events[0])).toBeGreaterThanOrEqual(logoHandoffAt('full'));
    expect(timeOf(events[0])).toBeLessThanOrEqual(logoHandoffAt('full') + 2 * FRAME);
    vi.advanceTimersByTime(logoIntroDuration('full') - logoHandoffAt('full') + FRAME);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatch(/^done@/);
    expect(timeOf(events[1])).toBeGreaterThanOrEqual(logoIntroDuration('full'));
    expect(timeOf(events[1])).toBeLessThanOrEqual(logoIntroDuration('full') + 2 * FRAME);
    expect(instance.isRunning).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    // Nothing more, however long one waits.
    vi.advanceTimersByTime(5000);
    expect(events).toHaveLength(2);
    instance.destroy();
  });

  it('draws every scene of every version without a failure (a failure would end the film early)', async () => {
    for (const variant of ['full', 'short', 'still'] as const) {
      const calls: string[] = [];
      vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(() =>
        fakeContext(calls),
      );
      const started = performance.now();
      const { instance, events } = film(variant);
      await settle();
      vi.advanceTimersByTime(logoIntroDuration(variant) + 2 * FRAME);
      expect(events.map((event) => event.split('@')[0])).toEqual(['handoff', 'done']);
      // Done at the film's length, not before: no scene threw.
      expect(timeOf(events[1]) - started).toBeGreaterThanOrEqual(logoIntroDuration(variant));
      expect(calls).toContain('drawImage');
      expect(calls).toContain('fillRect');
      expect(calls).toContain('set globalAlpha');
      // No canvas filter or shadow is ever used (they are what makes a canvas slow).
      expect(calls).not.toContain('set filter');
      expect(calls).not.toContain('set shadowBlur');
      instance.destroy();
    }
  });

  it('a skip lets the Setup in at once and ends the film after a short fade', async () => {
    const { instance, events } = film('full');
    await settle();
    vi.advanceTimersByTime(3000);
    expect(events).toEqual([]);
    instance.skip();
    vi.advanceTimersByTime(FRAME);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatch(/^handoff@/);
    const asked = timeOf(events[0]);
    vi.advanceTimersByTime(LOGO_SKIP_MS - 3 * FRAME);
    expect(events).toHaveLength(1);
    expect(Number(instance['canvas'].style.opacity)).toBeLessThan(0.5);
    vi.advanceTimersByTime(4 * FRAME);
    expect(events).toHaveLength(2);
    expect(timeOf(events[1]) - asked).toBeLessThanOrEqual(LOGO_SKIP_MS + 3 * FRAME);
    expect(vi.getTimerCount()).toBe(0);
    // Skipping again, or after the end, does nothing.
    instance.skip();
    vi.advanceTimersByTime(1000);
    expect(events).toHaveLength(2);
    instance.destroy();
  });

  it('a skip before the logo is ready goes straight to the Setup', () => {
    const { instance, events } = film('full', { loadImage: () => new Promise(() => undefined) });
    vi.advanceTimersByTime(200);
    instance.skip();
    expect(events.map((event) => event.split('@')[0])).toEqual(['handoff', 'done']);
    expect(instance.isRunning).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    instance.destroy();
  });

  it('waits at the end of the first scene until the logo is ready, then goes on', async () => {
    let ready: (image: CanvasImageSource) => void = () => undefined;
    const { instance, events } = film('full', {
      loadImage: () => new Promise((resolve) => (ready = resolve)),
    });
    vi.advanceTimersByTime(2000);
    // The cursor keeps waiting: the film has not gone past its first scene.
    expect(instance.elapsed).toBe(1150);
    ready({} as CanvasImageSource);
    await settle();
    vi.advanceTimersByTime(1000);
    expect(instance.elapsed).toBeGreaterThan(2100);
    expect(events).toEqual([]);
    instance.destroy();
  });

  it('never holds the Setup back: a logo that does not load, or cannot be read, ends the film', async () => {
    // Never loads: gives up after a moment.
    const stuck = film('full', { loadImage: () => new Promise(() => undefined) });
    vi.advanceTimersByTime(2500);
    expect(stuck.events).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(stuck.events.map((event) => event.split('@')[0])).toEqual(['handoff', 'done']);
    expect(vi.getTimerCount()).toBe(0);
    // Fails to load.
    const failed = film('short', { loadImage: () => Promise.reject(new Error('no file')) });
    await settle();
    expect(failed.events.map((event) => event.split('@')[0])).toEqual(['handoff', 'done']);
    // Loads, but has no logo in it (nothing but transparent pixels).
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(
      () =>
        new Proxy(fakeContext(), {
          get(target, key, receiver) {
            if (key === 'getImageData')
              return (_x: number, _y: number, w: number, h: number) => ({
                data: new Uint8ClampedArray(w * h * 4),
              });
            return Reflect.get(target, key, receiver);
          },
        }),
    );
    const empty = film('short');
    await settle();
    expect(empty.events.map((event) => event.split('@')[0])).toEqual(['handoff', 'done']);
    expect(vi.getTimerCount()).toBe(0);
    for (const each of [stuck, failed, empty]) each.instance.destroy();
  });

  it('with no drawing surface there is no film: straight to the Setup, nothing scheduled', async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    const added = vi.spyOn(document, 'addEventListener');
    const { instance, events } = film('full');
    expect(instance.isRunning).toBe(false);
    expect(events).toEqual([]);
    await settle();
    expect(events.map((event) => event.split('@')[0])).toEqual(['handoff', 'done']);
    expect(vi.getTimerCount()).toBe(0);
    expect(added.mock.calls.filter(([type]) => type === 'visibilitychange')).toHaveLength(0);
    instance.destroy();
  });

  it('a drawing failure ends the film instead of leaving a stuck picture', async () => {
    const { instance, events } = film('full');
    await settle();
    vi.advanceTimersByTime(500);
    vi.spyOn(instance as unknown as { draw: () => void }, 'draw').mockImplementation(() => {
      throw new Error('lost context');
    });
    vi.advanceTimersByTime(FRAME);
    expect(events.map((event) => event.split('@')[0])).toEqual(['handoff', 'done']);
    expect(instance.isRunning).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    instance.destroy();
  });

  it('stops its clock while the window is hidden, and picks up where it was', async () => {
    const { instance, events } = film('full');
    await settle();
    vi.advanceTimersByTime(3000);
    const before = instance.elapsed;
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(instance.isRunning).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(instance.elapsed).toBe(before);
    expect(events).toEqual([]);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(instance.isRunning).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(instance.elapsed).toBeGreaterThan(before + 900);
    expect(instance.elapsed).toBeLessThan(before + 1100);
    instance.destroy();
  });

  it('a film created while the window is hidden starts only when it is shown', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const { instance } = film('short');
    await settle();
    expect(instance.isRunning).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(instance.elapsed).toBe(0);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(instance.isRunning).toBe(true);
    instance.destroy();
  });

  it('a long stall moves the film on by at most a tenth of a second', async () => {
    const { instance } = film('full');
    await settle();
    vi.advanceTimersByTime(2000);
    const before = instance.elapsed;
    // The page freezes for three seconds: one frame arrives after it.
    vi.setSystemTime(Date.now() + 3000);
    vi.advanceTimersToNextTimer();
    expect(instance.elapsed - before).toBeLessThanOrEqual(100 + FRAME);
    instance.destroy();
  });

  it('destroy cancels the frame, the timers and every listener it added, whenever it is called', async () => {
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    const docAdded = vi.spyOn(document, 'addEventListener');
    const docRemoved = vi.spyOn(document, 'removeEventListener');
    // Before the logo has loaded, mid-film, and during a skip's fade.
    const early = film('full', { loadImage: () => new Promise(() => undefined) });
    const mid = film('full');
    const skipping = film('short');
    await settle();
    vi.advanceTimersByTime(1200);
    skipping.instance.skip();
    vi.advanceTimersByTime(FRAME * 2);
    for (const each of [early, mid, skipping]) each.instance.destroy();
    expect(vi.getTimerCount()).toBe(0);
    for (const each of [early, mid, skipping]) expect(each.instance.isRunning).toBe(false);
    const listened = added.mock.calls.filter(([type]) => type === 'resize');
    expect(listened).toHaveLength(3);
    for (const [type, listener] of listened) expect(removed).toHaveBeenCalledWith(type, listener);
    const watched = docAdded.mock.calls.filter(([type]) => type === 'visibilitychange');
    expect(watched).toHaveLength(3);
    for (const [type, listener] of watched) expect(docRemoved).toHaveBeenCalledWith(type, listener);
    // Destroyed films report nothing later, and can be skipped or destroyed again safely.
    vi.advanceTimersByTime(20_000);
    expect(early.events).toEqual([]);
    expect(mid.events).toEqual([]);
    expect(skipping.events.map((event) => event.split('@')[0])).toEqual(['handoff']);
    mid.instance.skip();
    mid.instance.destroy();
    // Showing the window again does not start a destroyed film.
    document.dispatchEvent(new Event('visibilitychange'));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('follows the size of its box: a resize part-way keeps playing, with the pixels capped', async () => {
    const resizers: (() => void)[] = [];
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resizers.push(callback);
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    vi.stubGlobal('devicePixelRatio', 2);
    const canvas = stage({ width: 800, height: 500 });
    const { instance, events } = film('full', { canvas });
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(1000);
    await settle();
    vi.advanceTimersByTime(6000);
    // A very large window: fewer pixels per point rather than a huge canvas.
    vi.mocked(canvas.parentElement!.getBoundingClientRect).mockReturnValue({
      width: 3200,
      height: 2000,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 3200,
      bottom: 2000,
      toJSON: () => ({}),
    });
    for (const resize of resizers) resize();
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(4_300_000);
    expect(canvas.width / canvas.height).toBeCloseTo(1.6, 2);
    vi.advanceTimersByTime(4100);
    expect(events.map((event) => event.split('@')[0])).toEqual(['handoff', 'done']);
    // A box with no size yet (not laid out): nothing is drawn, nothing fails.
    const unsized = film('short', { canvas: stage(null) });
    await settle();
    vi.advanceTimersByTime(logoIntroDuration('short') + 2 * FRAME);
    expect(unsized.events.map((event) => event.split('@')[0])).toEqual(['handoff', 'done']);
    instance.destroy();
    unsized.instance.destroy();
    expect(disconnect).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('follows the pixel ratio of the screen when that alone changes, and plays on (issue #1242)', async () => {
    vi.stubGlobal('devicePixelRatio', 1);
    const canvas = stage({ width: 960, height: 640 });
    const { instance, events } = film('full', { canvas });
    await settle();
    vi.advanceTimersByTime(2000);
    expect([canvas.width, canvas.height]).toEqual([960, 640]);
    // The window moves to a denser screen part-way: same box, twice the pixels, from the next frame.
    vi.stubGlobal('devicePixelRatio', 2);
    vi.advanceTimersByTime(FRAME);
    expect([canvas.width, canvas.height]).toEqual([1920, 1280]);
    vi.advanceTimersByTime(logoIntroDuration('full'));
    expect(events.map((event) => event.split('@')[0])).toEqual(['handoff', 'done']);
    instance.destroy();
  });

  it('the still card (reduced motion) is up for under two seconds and fades out', async () => {
    const canvas = stage();
    const { instance, events } = film('still', { canvas });
    await settle();
    vi.advanceTimersByTime(logoHandoffAt('still') - 50);
    expect(events).toEqual([]);
    expect(canvas.style.transform).toBe('');
    vi.advanceTimersByTime(50 + FRAME);
    expect(events).toHaveLength(1);
    vi.advanceTimersByTime(200);
    expect(Number(canvas.style.opacity)).toBeLessThan(1);
    vi.advanceTimersByTime(300);
    expect(events).toHaveLength(2);
    expect(logoIntroDuration('still')).toBeLessThan(2000);
    instance.destroy();
  });
});

describe('the film and its sound', () => {
  function recorder() {
    const calls: string[] = [];
    const sound: LogoIntroSound = {
      sync: (ms) => calls.push(`sync ${Math.round(ms)}`),
      pause: () => calls.push('pause'),
      fade: (ms) => calls.push(`fade ${ms}`),
      stop: () => calls.push('stop'),
    };
    const others = () => calls.filter((call) => !call.startsWith('sync'));
    const syncs = () =>
      calls.filter((call) => call.startsWith('sync')).map((call) => Number(call.slice(5)));
    return { sound, calls, others, syncs };
  }

  it('gives the sound the film’s time every frame, and stops it when the film ends', async () => {
    const { sound, others, syncs } = recorder();
    const { instance, events } = film('short', { sound });
    await settle();
    vi.advanceTimersByTime(1000);
    const times = syncs();
    expect(times.length).toBeGreaterThan(40);
    for (let k = 1; k < times.length; k += 1)
      expect(times[k]!).toBeGreaterThanOrEqual(times[k - 1]!);
    expect(times.at(-1)!).toBeGreaterThan(900);
    expect(times.at(-1)!).toBe(Math.round(instance.elapsed));
    expect(others()).toEqual([]);
    vi.advanceTimersByTime(logoIntroDuration('short'));
    expect(events).toHaveLength(2);
    // Stopped once the film is done (after the frame loop's own pause).
    expect(others().at(-1)).toBe('stop');
    expect(others().filter((call) => call === 'stop')).toHaveLength(1);
    instance.destroy();
  });

  it('while the film waits for its logo, the sound is given the same time again (so it is held)', () => {
    const { sound, syncs } = recorder();
    const { instance } = film('full', { sound, loadImage: () => new Promise(() => undefined) });
    vi.advanceTimersByTime(2000);
    expect(syncs().at(-1)).toBe(1150);
    expect(syncs().filter((ms) => ms === 1150).length).toBeGreaterThan(20);
    instance.destroy();
  });

  it('a skip fades the sound over the skip’s length; the end of the fade stops it', async () => {
    const { sound, others } = recorder();
    const { instance } = film('full', { sound });
    await settle();
    vi.advanceTimersByTime(3000);
    instance.skip();
    instance.skip();
    expect(others()).toEqual([`fade ${LOGO_SKIP_MS}`]);
    vi.advanceTimersByTime(LOGO_SKIP_MS + 2 * FRAME);
    expect(others()).toEqual([`fade ${LOGO_SKIP_MS}`, 'pause', 'stop']);
    instance.destroy();
    expect(others().filter((call) => call === 'stop').length).toBeGreaterThanOrEqual(1);
  });

  it('pauses the sound while the window is hidden; goes on with the next frame', async () => {
    const { sound, calls, others } = recorder();
    const { instance } = film('full', { sound });
    await settle();
    vi.advanceTimersByTime(2000);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(others()).toEqual(['pause']);
    const count = calls.length;
    vi.advanceTimersByTime(5000);
    expect(calls.length).toBe(count);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(100);
    expect(calls.length).toBeGreaterThan(count);
    expect(calls.at(-1)).toMatch(/^sync 2\d\d\d$/);
    instance.destroy();
  });

  it('stops the sound when the film is taken away, or could not play at all', async () => {
    const mid = recorder();
    const gone = film('full', { sound: mid.sound });
    await settle();
    vi.advanceTimersByTime(4000);
    gone.instance.destroy();
    expect(mid.others().at(-1)).toBe('stop');
    // No drawing surface: no film — and the sound is never started, only released.
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    const none = recorder();
    const silent = film('full', { sound: none.sound });
    await settle();
    expect(none.calls).toEqual(['stop']);
    // A skip before the logo is ready goes straight to the Setup: stopped, no fade.
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(() => fakeContext());
    const early = recorder();
    const quick = film('full', {
      sound: early.sound,
      loadImage: () => new Promise(() => undefined),
    });
    vi.advanceTimersByTime(100);
    quick.instance.skip();
    expect(early.others()).toEqual(['pause', 'stop']);
    for (const each of [silent, quick]) each.instance.destroy();
  });
});

describe('remembering that the full film was seen', () => {
  it('reads and writes one mark; storage that fails counts as not seen', () => {
    expect(readLogoIntroSeen()).toBe(false);
    writeLogoIntroSeen();
    expect(localStorage.getItem(LOGO_INTRO_SEEN_KEY)).toBe('1');
    expect(readLogoIntroSeen()).toBe(true);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readLogoIntroSeen()).toBe(false);
    expect(() => writeLogoIntroSeen()).not.toThrow();
  });
});

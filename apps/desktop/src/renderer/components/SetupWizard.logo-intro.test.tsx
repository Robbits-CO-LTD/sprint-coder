// @vitest-environment jsdom
// The logo film inside the Setup: which version plays when, that the Setup waits under it and
// comes in when it hands over, and that nothing is left running. (The film itself is tested in
// lib/setup-logo-intro.test.ts and lib/setup-logo-timeline.test.ts.)
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ASSISTANT_PREFERENCES } from '@sprint-coder/contracts';
import { useAppStore } from '../store/appStore';
import { LOGO_INTRO_SEEN_KEY } from '../lib/setup-logo-intro';
import { LOGO_SKIP_MS, logoHandoffAt, logoIntroDuration } from '../lib/setup-logo-timeline';
import type * as UiSound from '../lib/ui-sound';

vi.mock('../lib/ui-sound', async (importOriginal) => ({
  ...(await importOriginal<typeof UiSound>()),
  playInterfaceCue: vi.fn(),
}));
import { SetupWizard } from './SetupWizard';

/** A stand-in drawing surface whose "icon" is all logo colour, so the film has a logo to show. */
function fakeContext(): CanvasRenderingContext2D {
  return new Proxy({} as Record<string | symbol, unknown>, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'measureText') return (text: string) => ({ width: 10 * text.length });
      if (key === 'getImageData')
        return (_x: number, _y: number, w: number, h: number) => {
          const data = new Uint8ClampedArray(Math.max(1, w * h * 4));
          for (let p = 0; p < data.length; p += 4) {
            data[p] = 97;
            data[p + 1] = 142;
            data[p + 2] = 248;
            data[p + 3] = 255;
          }
          return { data };
        };
      if (key === 'createRadialGradient' || key === 'createLinearGradient')
        return () => ({ addColorStop() {} });
      return () => undefined;
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function stubMedia(reduced: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: reduced && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

let container: HTMLDivElement;
let root: Root;
const createTask = vi.fn();

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'performance',
    ],
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext());
  // The app icon "loads" at once.
  vi.stubGlobal(
    'Image',
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      decoding = '';
      set src(_: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  localStorage.clear();
  stubMedia(false);
  createTask.mockReset().mockResolvedValue({ id: 'task-1' });
  useAppStore.setState({
    createTask,
    createProject: vi.fn(),
    pickProjectFolders: vi.fn().mockResolvedValue({ canceled: true, folders: [] }),
  } as unknown as Partial<ReturnType<typeof useAppStore.getState>>);
  Object.defineProperty(window, 'sprintCoder', {
    configurable: true,
    value: {
      settings: {
        getAssistantPreferences: vi
          .fn()
          .mockResolvedValue({ configured: false, preferences: DEFAULT_ASSISTANT_PREFERENCES }),
        setAssistantPreferences: vi.fn(async (preferences: unknown) => ({
          configured: true,
          preferences,
        })),
        getTeamUsageMode: vi.fn().mockResolvedValue({ mode: 'explicit' }),
        setTeamUsageMode: vi.fn(async (input: unknown) => input),
      },
    },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'sprintCoder');
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

async function render(props: Partial<Parameters<typeof SetupWizard>[0]> = {}) {
  await act(async () => {
    root.render(<SetupWizard onOpenSettings={() => {}} {...props} />);
  });
  await flush();
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flush();
}

const wizard = () => container.querySelector<HTMLElement>('[data-testid="setup-wizard"]')!;
const film = () => container.querySelector<HTMLElement>('[data-testid="setup-logo-intro"]');

function key(name: string) {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
  return event;
}

describe('the logo film in the Setup', () => {
  it('the very first Setup plays the full film; the Setup waits under it and comes in at the hand-over', async () => {
    await render();
    expect(film()?.dataset.variant).toBe('full');
    expect(wizard().dataset.intro).toBe('playing');
    expect(wizard().dataset.step).toBe('welcome');
    expect(localStorage.getItem(LOGO_INTRO_SEEN_KEY)).toBeNull();
    await advance(logoHandoffAt('full') - 200);
    expect(wizard().dataset.intro).toBe('playing');
    await advance(240);
    // The last scene runs over the Setup as it arrives; the film no longer takes clicks.
    expect(wizard().dataset.intro).toBe('arrive');
    expect(film()?.dataset.handoff).toBe('true');
    expect(localStorage.getItem(LOGO_INTRO_SEEN_KEY)).toBe('1');
    expect(document.activeElement?.id).toBe('setup-title');
    await advance(logoIntroDuration('full') - logoHandoffAt('full'));
    expect(wizard().dataset.intro).toBe('done');
    expect(film()).toBeNull();
    // The Setup is where it began, and does not move on by itself.
    await advance(8000);
    expect(wizard().dataset.step).toBe('welcome');
    expect(createTask).not.toHaveBeenCalled();
    expect(document.activeElement?.id).toBe('setup-title');
  });

  it('a first Setup shown again (the full film was seen) plays the short one', async () => {
    localStorage.setItem(LOGO_INTRO_SEEN_KEY, '1');
    await render();
    expect(film()?.dataset.variant).toBe('short');
    await advance(logoIntroDuration('short') + 40);
    expect(wizard().dataset.intro).toBe('done');
    expect(film()).toBeNull();
  });

  it('the Setup laid over the app at launch (someone who updated) plays the full film too, and counts as having seen it', async () => {
    const onClose = vi.fn();
    await render({ mode: 'replay', onClose });
    // Not seen yet: the full film, whatever form the Setup takes.
    expect(film()?.dataset.variant).toBe('full');
    expect(wizard().dataset.intro).toBe('playing');
    await advance(logoHandoffAt('full') + 40);
    expect(wizard().dataset.intro).toBe('arrive');
    expect(localStorage.getItem(LOGO_INTRO_SEEN_KEY)).toBe('1');
    await advance(logoIntroDuration('full') - logoHandoffAt('full'));
    expect(wizard().dataset.intro).toBe('done');
    expect(film()).toBeNull();
    // The Setup is at its first step, still open: the film closed nothing.
    expect(wizard().dataset.step).toBe('welcome');
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement?.id).toBe('setup-title');
  });

  it('Escape during the film only skips the film: the Setup over the app stays open (and is not passed unseen)', async () => {
    const onClose = vi.fn();
    await render({ mode: 'replay', onClose });
    await advance(2000);
    const escape = key('Escape');
    // Stopped before the dialog or the Setup can take it as "close".
    expect(escape.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    await advance(LOGO_SKIP_MS + 60);
    expect(wizard().dataset.intro).toBe('done');
    expect(wizard().dataset.step).toBe('welcome');
    expect(onClose).not.toHaveBeenCalled();
    // A skipped film counts as seen.
    expect(localStorage.getItem(LOGO_INTRO_SEEN_KEY)).toBe('1');
    // After it, Escape is the Setup's own again.
    key('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('once the film has been seen, a replay from Settings plays the short one', async () => {
    localStorage.setItem(LOGO_INTRO_SEEN_KEY, '1');
    const onClose = vi.fn();
    await render({ mode: 'replay', onClose });
    expect(film()?.dataset.variant).toBe('short');
    await advance(logoIntroDuration('short') + 40);
    expect(wizard().dataset.intro).toBe('done');
    expect(film()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('with reduced motion, the Setup over the app shows the still card once, like the first run’s', async () => {
    stubMedia(true);
    await render({ mode: 'replay', onClose: vi.fn() });
    expect(film()?.dataset.variant).toBe('still');
    await advance(logoIntroDuration('still') + 40);
    expect(wizard().dataset.intro).toBe('done');
    expect(localStorage.getItem(LOGO_INTRO_SEEN_KEY)).toBe('1');
  });

  it('with reduced motion the first Setup shows the still card for under two seconds; later ones show nothing', async () => {
    stubMedia(true);
    await render();
    expect(film()?.dataset.variant).toBe('still');
    expect(wizard().dataset.motion).toBe('reduced');
    expect(film()?.querySelector('.setup-logo-intro-skip')).toBeNull();
    await advance(logoIntroDuration('still') + 40);
    expect(logoIntroDuration('still')).toBeLessThan(2000);
    expect(wizard().dataset.intro).toBe('done');
    expect(film()).toBeNull();
    expect(localStorage.getItem(LOGO_INTRO_SEEN_KEY)).toBe('1');
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(film()).toBeNull();
    expect(wizard().dataset.intro).toBe('done');
  });

  it('Enter during the film skips it and does not start the Setup', async () => {
    await render();
    await advance(2500);
    const enter = key('Enter');
    expect(enter.defaultPrevented).toBe(true);
    await advance(40);
    expect(wizard().dataset.intro).toBe('arrive');
    expect(localStorage.getItem(LOGO_INTRO_SEEN_KEY)).toBe('1');
    await advance(LOGO_SKIP_MS + 40);
    expect(wizard().dataset.intro).toBe('done');
    expect(wizard().dataset.step).toBe('welcome');
    // Now Enter on the button is the Setup's.
    const start = container.querySelector<HTMLButtonElement>('[data-testid="setup-start"]')!;
    await act(async () => start.click());
    await flush();
    expect(wizard().dataset.step).not.toBe('welcome');
  });

  it('a click during the film skips it and presses nothing under it', async () => {
    await render();
    await advance(1500);
    const event = new Event('pointerdown', { bubbles: true, cancelable: true });
    act(() => {
      film()!.querySelector('canvas')!.dispatchEvent(event);
    });
    await advance(LOGO_SKIP_MS + 60);
    expect(wizard().dataset.intro).toBe('done');
    expect(wizard().dataset.step).toBe('welcome');
  });

  it('pressing the Setup’s button while the film’s last scene runs over it goes on at once', async () => {
    await render();
    await advance(logoHandoffAt('full') + 60);
    expect(wizard().dataset.intro).toBe('arrive');
    const start = container.querySelector<HTMLButtonElement>('[data-testid="setup-start"]')!;
    await act(async () => start.click());
    await flush();
    expect(wizard().dataset.intro).toBe('done');
    expect(film()).toBeNull();
    expect(wizard().dataset.step).not.toBe('welcome');
  });

  it('closed part-way through the film, it leaves no frame or timer behind', async () => {
    await render();
    await advance(4000);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await act(async () => root.unmount());
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
  });

  it('motion switched off part-way ends the film for good: switched on again on a later step, it does not come back', async () => {
    // A `prefers-reduced-motion` that can change while the Setup is up.
    let reduced = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        get matches() {
          return reduced && query.includes('prefers-reduced-motion');
        },
        media: query,
        addEventListener: (_: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
      })),
    );
    const turn = async (to: boolean) => {
      reduced = to;
      await act(async () => {
        for (const listener of [...listeners]) listener();
      });
      await flush();
    };

    await render();
    await advance(3000);
    expect(film()?.dataset.variant).toBe('full');
    expect(wizard().dataset.intro).toBe('playing');

    await turn(true);
    expect(film()).toBeNull();
    expect(wizard().dataset.intro).toBe('done');
    // On past the welcome, as someone would be by the time the setting is switched back.
    const start = container.querySelector<HTMLButtonElement>('[data-testid="setup-start"]');
    await act(async () => start?.click());
    await flush();
    expect(wizard().dataset.step).not.toBe('welcome');

    await turn(false);
    await advance(500);
    expect(film()).toBeNull();
    expect(wizard().dataset.intro).toBe('done');
    expect(wizard().dataset.step).not.toBe('welcome');
  });
});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FilmOptions = {
  variant: string;
  iconUrl: string;
  sound?: unknown;
  onHandoff: () => void;
  onDone: () => void;
};
const films = vi.hoisted(
  () => [] as { options: FilmOptions; skip: () => void; destroy: () => void; skips: number }[],
);
vi.mock('../lib/setup-logo-intro', () => ({
  SetupLogoIntro: class {
    skips = 0;
    destroyed = false;
    constructor(
      readonly canvas: HTMLCanvasElement,
      readonly options: FilmOptions,
    ) {
      films.push(this as never);
    }
    skip() {
      this.skips += 1;
    }
    destroy() {
      this.destroyed = true;
    }
  },
}));
// The film's sound: how loud (null = none) is set per test; each player made is kept to look at.
const sound = vi.hoisted(() => ({
  level: 0.5 as number | null,
  players: [] as { level: number; variant: string; muted: number; stopped: number }[],
}));
vi.mock('../lib/setup-logo-sound', () => ({
  logoSoundLevel: () => sound.level,
  LogoSoundPlayer: class {
    muted = 0;
    stopped = 0;
    level: number;
    variant: string;
    constructor(options: { level: number; variant: string }) {
      this.level = options.level;
      this.variant = options.variant;
      sound.players.push(this);
    }
    mute() {
      this.muted += 1;
    }
    stop() {
      this.stopped += 1;
    }
  },
}));
import { SetupLogoIntro } from './SetupLogoIntro';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  films.length = 0;
  sound.level = 0.5;
  sound.players.length = 0;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function show(
  variant: 'full' | 'short' | 'still' = 'full',
  onHandoff = vi.fn(),
  onDone = vi.fn(),
) {
  await act(async () => {
    root.render(<SetupLogoIntro variant={variant} onHandoff={onHandoff} onDone={onDone} />);
  });
  return {
    film: films.at(-1)! as (typeof films)[number] & { destroyed: boolean },
    onHandoff,
    onDone,
  };
}

/** Presses a key on the page; returns whether the page still got it (not stopped, not prevented). */
function pressKey(
  key: string,
  init: KeyboardEventInit = {},
): { reached: boolean; prevented: boolean } {
  let reached = false;
  const listener = () => {
    reached = true;
  };
  document.body.addEventListener('keydown', listener);
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    document.body.dispatchEvent(event);
  });
  document.body.removeEventListener('keydown', listener);
  return { reached, prevented: event.defaultPrevented };
}

const overlay = () => container.querySelector<HTMLElement>('[data-testid="setup-logo-intro"]')!;

describe('SetupLogoIntro (the film over the Setup)', () => {
  it('starts one film on its canvas with the app icon, hidden from assistive technology', async () => {
    const { film } = await show('full');
    expect(films).toHaveLength(1);
    expect(film.options.variant).toBe('full');
    expect(film.options.iconUrl).toMatch(/sprint-coder-icon-master-v1/);
    // The picture is decoration; the overlay itself is not hidden (it holds the mute button).
    expect(overlay().querySelector('canvas')?.getAttribute('aria-hidden')).toBe('true');
    expect(overlay().getAttribute('aria-hidden')).toBeNull();
    expect(overlay().dataset.variant).toBe('full');
    expect(overlay().dataset.handoff).toBe('false');
    expect(overlay().querySelector('canvas')).not.toBeNull();
  });

  it('says how to skip — except on the still card, which is over in a moment', async () => {
    await show('full');
    expect(overlay().querySelector('.setup-logo-intro-skip')?.textContent).toBe(
      'Enterまたはクリックで飛ばす',
    );
    await show('still');
    expect(overlay().querySelector('.setup-logo-intro-skip')).toBeNull();
    expect(overlay().querySelector('.setup-logo-intro-hints')).toBeNull();
  });

  describe('its sound', () => {
    const muteButton = () =>
      container.querySelector<HTMLButtonElement>('[data-testid="setup-logo-intro-mute"]');

    it('gives the film a sound at the level decided for it, and shows how to silence it', async () => {
      sound.level = 0.25;
      const { film } = await show('full');
      expect(sound.players).toHaveLength(1);
      expect(sound.players[0]).toMatchObject({ level: 0.25, variant: 'full' });
      expect(film.options.sound).toBe(sound.players[0]);
      const button = muteButton()!;
      expect(button.getAttribute('aria-label')).toBe('音を消す');
      expect(button.getAttribute('aria-pressed')).toBe('false');
      expect(button.textContent).toBe('M音を消す');
      expect(button.disabled).toBe(false);
    });

    it('no sound (switched off, or the still card): no player, no button, and M is an ordinary key', async () => {
      sound.level = null;
      const { film } = await show('full');
      expect(sound.players).toHaveLength(0);
      expect(film.options.sound).toBeUndefined();
      expect(muteButton()).toBeNull();
      expect(pressKey('m')).toEqual({ reached: true, prevented: false });
      // The skip hint is still there.
      expect(overlay().querySelector('.setup-logo-intro-skip')).not.toBeNull();
    });

    it('M silences the sound for the rest of the film, without skipping it', async () => {
      const { film } = await show('full');
      expect(pressKey('m')).toEqual({ reached: false, prevented: true });
      expect(sound.players[0]!.muted).toBe(1);
      expect(film.skips).toBe(0);
      const button = muteButton()!;
      expect(button.getAttribute('aria-pressed')).toBe('true');
      expect(button.getAttribute('aria-label')).toBe('音を消しました');
      expect(button.disabled).toBe(true);
      // Capital M too; with Ctrl it is somebody else's shortcut.
      pressKey('M');
      expect(sound.players[0]!.muted).toBe(2);
      expect(pressKey('m', { ctrlKey: true })).toEqual({ reached: true, prevented: false });
      expect(sound.players[0]!.muted).toBe(2);
    });

    it('a press on the button silences the sound and does not skip the film', async () => {
      const { film } = await show('full');
      const button = muteButton()!;
      const down = new Event('pointerdown', { bubbles: true, cancelable: true });
      act(() => {
        button.dispatchEvent(down);
      });
      expect(film.skips).toBe(0);
      await act(async () => button.click());
      expect(sound.players[0]!.muted).toBe(1);
      expect(film.skips).toBe(0);
      expect(muteButton()!.getAttribute('aria-pressed')).toBe('true');
    });

    it('once the Setup comes in, M is the Setup’s key again', async () => {
      const { film } = await show('full');
      await act(async () => film.options.onHandoff());
      expect(pressKey('m')).toEqual({ reached: true, prevented: false });
      expect(sound.players[0]!.muted).toBe(0);
    });

    it('taken away part-way, the sound is stopped with the film', async () => {
      const { film } = await show('short');
      await act(async () => root.unmount());
      expect(film.destroyed).toBe(true);
      expect(sound.players[0]!.stopped).toBeGreaterThanOrEqual(1);
      root = createRoot(container);
    });
  });

  it('Enter, Space and Escape skip the film and go no further', async () => {
    const { film } = await show();
    for (const [index, key] of ['Enter', ' ', 'Escape'].entries()) {
      const result = pressKey(key);
      expect(result).toEqual({ reached: false, prevented: true });
      expect(film.skips).toBe(index + 1);
    }
    // A key held down skips once, not on every repeat.
    pressKey('Enter', { repeat: true });
    expect(film.skips).toBe(3);
  });

  it('Tab is held back without skipping; other keys and shortcuts are left alone', async () => {
    const { film } = await show();
    expect(pressKey('Tab')).toEqual({ reached: false, prevented: true });
    expect(pressKey('a')).toEqual({ reached: true, prevented: false });
    expect(pressKey('F12')).toEqual({ reached: true, prevented: false });
    expect(pressKey('Shift')).toEqual({ reached: true, prevented: false });
    // Shortcuts: Ctrl+R, Alt+F4 and the like are never taken, even on a skip key.
    expect(pressKey('Enter', { ctrlKey: true })).toEqual({ reached: true, prevented: false });
    expect(pressKey('Escape', { altKey: true })).toEqual({ reached: true, prevented: false });
    expect(pressKey(' ', { metaKey: true })).toEqual({ reached: true, prevented: false });
    // While text is being composed (an input method), Enter belongs to the composition.
    expect(pressKey('Enter', { isComposing: true })).toEqual({ reached: true, prevented: false });
    expect(film.skips).toBe(0);
  });

  it('a click anywhere skips, and does not reach what is under the film', async () => {
    const { film } = await show();
    const under = vi.fn();
    document.body.addEventListener('pointerdown', under);
    const event = new Event('pointerdown', { bubbles: true, cancelable: true });
    act(() => {
      overlay().querySelector('canvas')!.dispatchEvent(event);
    });
    expect(film.skips).toBe(1);
    expect(event.defaultPrevented).toBe(true);
    expect(under).not.toHaveBeenCalled();
    document.body.removeEventListener('pointerdown', under);
  });

  it('once the Setup comes in, keys and clicks go to it and the film reports up', async () => {
    const { film, onHandoff, onDone } = await show();
    await act(async () => film.options.onHandoff());
    expect(onHandoff).toHaveBeenCalledTimes(1);
    expect(overlay().dataset.handoff).toBe('true');
    expect(pressKey('Enter')).toEqual({ reached: true, prevented: false });
    expect(pressKey('Tab')).toEqual({ reached: true, prevented: false });
    expect(pressKey('Escape')).toEqual({ reached: true, prevented: false });
    const event = new Event('pointerdown', { bubbles: true, cancelable: true });
    act(() => {
      overlay().dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(film.skips).toBe(0);
    await act(async () => film.options.onDone());
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('calls the latest callbacks without starting the film again', async () => {
    const first = await show('full');
    const onHandoff = vi.fn();
    const onDone = vi.fn();
    await show('full', onHandoff, onDone);
    expect(films).toHaveLength(1);
    await act(async () => first.film.options.onHandoff());
    await act(async () => first.film.options.onDone());
    expect(first.onHandoff).not.toHaveBeenCalled();
    expect(onHandoff).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('taken away part-way, it destroys the film and stops listening for keys', async () => {
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    const { film } = await show();
    await act(async () => root.unmount());
    expect(film.destroyed).toBe(true);
    const listened = added.mock.calls.filter(([type]) => type === 'keydown');
    expect(listened.length).toBeGreaterThan(0);
    for (const [type, listener, options] of listened)
      expect(removed).toHaveBeenCalledWith(type, listener, options);
    expect(pressKey('Enter')).toEqual({ reached: true, prevented: false });
    expect(film.skips).toBe(0);
    root = createRoot(container);
  });
});

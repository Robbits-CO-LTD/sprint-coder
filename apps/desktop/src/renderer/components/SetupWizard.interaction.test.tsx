// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ASSISTANT_PREFERENCES, type AssistantPreferences } from '@sprint-coder/contracts';
import { useAppStore } from '../store/appStore';
import { SETUP_COMPLETE_KEY } from '../lib/setup-preference';
import { SetupWizard } from './SetupWizard';

type Bridge = Record<string, unknown>;

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

function installBridge(settings: Bridge): void {
  Object.defineProperty(window, 'sprintCoder', { configurable: true, value: { settings } });
}

function fullBridge(initial?: Partial<AssistantPreferences>, mode = 'explicit') {
  const preferences = { ...DEFAULT_ASSISTANT_PREFERENCES, ...initial };
  const settings = {
    getAssistantPreferences: vi.fn().mockResolvedValue({ configured: !!initial, preferences }),
    setAssistantPreferences: vi.fn(async (input: AssistantPreferences) => ({
      configured: true,
      preferences: { ...input, callName: input.callName.replace(/[<>]/g, '') },
    })),
    getTeamUsageMode: vi.fn().mockResolvedValue({ mode }),
    setTeamUsageMode: vi.fn(async (input: { mode: string }) => input),
  };
  installBridge(settings);
  return settings;
}

let container: HTMLDivElement;
let root: Root;
const createTask = vi.fn();
const createProject = vi.fn();
const pickProjectFolders = vi.fn();

/** Enough of a 2D context for the background to run its loop in jsdom (which has none). */
function fakeContext(): CanvasRenderingContext2D {
  return new Proxy({} as Record<string | symbol, unknown>, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'measureText') return () => ({ width: 10 });
      if (key === 'getImageData')
        return (_x: number, _y: number, w: number, h: number) => ({
          data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
        });
      if (key === 'createRadialGradient') return () => ({ addColorStop() {} });
      return () => undefined;
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  localStorage.clear();
  stubMedia(false);
  createTask.mockReset().mockResolvedValue({ id: 'task-1' });
  createProject.mockReset().mockResolvedValue({ id: 'project-1' });
  pickProjectFolders.mockReset().mockResolvedValue({ canceled: true, folders: [] });
  useAppStore.setState({
    createTask,
    createProject,
    pickProjectFolders,
  } as unknown as Partial<ReturnType<typeof useAppStore.getState>>);
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

async function render(props: Partial<Parameters<typeof SetupWizard>[0]> = {}) {
  await act(async () => {
    root.render(<SetupWizard onOpenSettings={() => {}} {...props} />);
  });
  await flush();
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitForHandOff() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 650));
  });
}

const q = <T extends Element = HTMLElement>(selector: string) =>
  container.querySelector<T & HTMLElement>(selector);
const step = () => q('[data-testid="setup-wizard"]')?.dataset.step;

async function press(testId: string) {
  const button = q<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!button) throw new Error(`missing ${testId} on ${step()}`);
  await act(async () => button.click());
  await flush();
}

async function choose(testId: string) {
  const input = q<HTMLInputElement>(`[data-testid="${testId}"]`);
  if (!input) throw new Error(`missing ${testId}`);
  await act(async () => input.click());
}

describe('SetupWizard', () => {
  it('walks every step forward and back, and focuses each heading', async () => {
    fullBridge();
    await render();
    expect(step()).toBe('welcome');
    const order = ['ai', 'reply', 'team', 'details', 'workspace', 'done'];
    await press('setup-start');
    for (const expected of order) {
      expect(step()).toBe(expected);
      expect(document.activeElement?.id).toBe('setup-title');
      if (expected !== 'done') await press('setup-next');
    }
    for (const expected of [...order].reverse().slice(1)) {
      await press('setup-back');
      expect(step()).toBe(expected);
    }
    expect(q('[aria-label="セットアップ 2 / 7"]')).not.toBeNull();
  });

  it('saves the reply style on leaving its step, and the Team mode on leaving its step', async () => {
    const settings = fullBridge();
    await render();
    await press('setup-start');
    await press('setup-next'); // ai -> reply
    const before = q('[data-testid="setup-preview-reply"]')?.textContent;
    await choose('setup-tone-casual');
    await choose('setup-length-short');
    await choose('setup-depth-beginner');
    expect(settings.setAssistantPreferences).not.toHaveBeenCalled();
    // The whole sample (read by screen readers) changes immediately.
    expect(q('[data-testid="setup-preview-reply"] [aria-live]')?.textContent).not.toBe(before);
    await press('setup-next');
    expect(settings.setAssistantPreferences).toHaveBeenCalledExactlyOnceWith({
      ...DEFAULT_ASSISTANT_PREFERENCES,
      tone: 'casual',
      length: 'short',
      depth: 'beginner',
    });
    expect(step()).toBe('team');
    // Default is the stored value ("言った時だけ" when unset), with "おまかせ" marked as recommended.
    expect(q<HTMLInputElement>('[data-testid="setup-team-explicit"]')?.checked).toBe(true);
    expect(q('[data-testid="setup-team-cards"]')?.textContent).toContain('おすすめ');
    expect(container.textContent).toContain('Team のメンバーも、AI の利用枠を使います。');
    await choose('setup-team-proactive');
    await press('setup-next');
    expect(settings.setTeamUsageMode).toHaveBeenCalledExactlyOnceWith({ mode: 'proactive' });
  });

  it('stores nothing for a skipped step, and saves the details with sound and the safety default', async () => {
    const settings = fullBridge();
    await render();
    await press('setup-start');
    await press('setup-next'); // reply
    await choose('setup-tone-crisp');
    await press('setup-skip');
    expect(settings.setAssistantPreferences).not.toHaveBeenCalled();
    await press('setup-skip'); // team
    expect(settings.setTeamUsageMode).not.toHaveBeenCalled();
    expect(step()).toBe('details');
    const name = q<HTMLInputElement>('[data-testid="setup-call-name"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(name, '<ゆう>');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await choose('setup-emoji');
    await choose('setup-sound');
    await choose('setup-access-auto');
    await press('setup-next');
    // The skipped tone stays at what was stored, not the abandoned "きびきび".
    expect(settings.setAssistantPreferences).toHaveBeenCalledExactlyOnceWith({
      ...DEFAULT_ASSISTANT_PREFERENCES,
      callName: '<ゆう>',
      emoji: true,
    });
    expect(localStorage.getItem('sprint-coder:default-access-preset')).toBe('auto');
    expect(JSON.parse(localStorage.getItem('sprint-coder:sound-effects') ?? '{}').enabled).toBe(
      true,
    );
    await press('setup-next'); // workspace -> done
    const summary = q('[data-testid="setup-summary"]')?.textContent ?? '';
    expect(summary).toContain('おすすめのまま');
    expect(summary).toContain('呼び名「ゆう」'); // what Main kept
    expect(q('[data-testid="setup-save-warning"]')).toBeNull();
  });

  it('keeps going when saving fails, and says so at the end', async () => {
    const settings = fullBridge();
    settings.setTeamUsageMode.mockRejectedValue(new Error('disk'));
    await render();
    await press('setup-start');
    await press('setup-next');
    await press('setup-next'); // reply saved
    await press('setup-next'); // team fails
    expect(step()).toBe('details');
    await press('setup-next');
    await press('setup-next');
    expect(step()).toBe('done');
    expect(q('[data-testid="setup-save-warning"]')?.textContent).toBe(
      '保存できなかった設定があります。設定の画面から変えられます。',
    );
  });

  it('works without the new settings bridge: no reply or Team step, nothing reported', async () => {
    installBridge({});
    await render();
    await press('setup-start');
    const seen: (string | undefined)[] = [];
    while (step() !== 'done') {
      seen.push(step());
      await press('setup-next');
    }
    expect(seen).toEqual(['ai', 'details', 'workspace']);
    expect(q('[data-testid="setup-call-name"]')).toBeNull();
    expect(q('[data-testid="setup-save-warning"]')).toBeNull();
    await press('setup-finish');
    // The hand-off into the app plays first (about half a second), then the Task is made.
    expect(q('[data-testid="setup-wizard"]')?.classList.contains('is-leaving')).toBe(true);
    expect(createTask).not.toHaveBeenCalled();
    await waitForHandOff();
    expect(createTask).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(localStorage.getItem(SETUP_COMPLETE_KEY)).toBe('1');
  });

  it('creates the Project from a picked folder before the first Task', async () => {
    installBridge({});
    pickProjectFolders.mockResolvedValue({
      canceled: false,
      folders: [{ path: 'C:/work/app', label: 'app' }],
    });
    await render();
    await press('setup-start');
    await press('setup-next');
    await press('setup-next');
    expect(step()).toBe('workspace');
    await press('setup-folder');
    expect(q('[data-testid="setup-next"]')?.textContent).toContain('続ける');
    await press('setup-next');
    expect(createProject).toHaveBeenCalledExactlyOnceWith('app', [
      { path: 'C:/work/app', label: 'app', role: 'primary' },
    ]);
    await press('setup-finish');
    await waitForHandOff();
    expect(createTask).toHaveBeenCalledExactlyOnceWith('project-1');
  });

  it('replay: opens on the stored choices, has no Workspace or first Task, and closes', async () => {
    fullBridge({ tone: 'casual', length: 'detailed' }, 'auto');
    const onClose = vi.fn();
    await render({ mode: 'replay', onClose });
    await press('setup-start');
    await press('setup-next');
    expect(q<HTMLInputElement>('[data-testid="setup-tone-casual"]')?.checked).toBe(true);
    expect(q<HTMLInputElement>('[data-testid="setup-length-detailed"]')?.checked).toBe(true);
    expect(q('[data-testid="setup-skip"]')?.textContent).toContain('今のままにする');
    await press('setup-next');
    expect(q<HTMLInputElement>('[data-testid="setup-team-auto"]')?.checked).toBe(true);
    // Escape closes from anywhere.
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    await press('setup-next');
    await press('setup-next');
    expect(step()).toBe('done');
    expect(container.textContent).not.toContain('作業場所');
    expect(container.textContent).not.toContain('最初のTask');
    await press('setup-close');
    expect(onClose).toHaveBeenCalledTimes(2);
    await press('setup-finish');
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(createTask).not.toHaveBeenCalled();
    expect(localStorage.getItem(SETUP_COMPLETE_KEY)).toBeNull();
  });

  it('Enter on a choice goes forward', async () => {
    fullBridge();
    await render();
    await press('setup-start');
    await press('setup-next');
    const radio = q<HTMLInputElement>('[data-testid="setup-tone-polite"]')!;
    await act(async () => {
      radio.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();
    expect(step()).toBe('team');
  });

  it('reduced motion: marked still, no specks or confetti, text shown at once', async () => {
    stubMedia(true);
    fullBridge();
    await render();
    const wizard = q('[data-testid="setup-wizard"]')!;
    expect(wizard.dataset.motion).toBe('reduced');
    expect(wizard.classList.contains('is-still')).toBe(true);
    expect(wizard.dataset.intro).toBe('done');
    await press('setup-start');
    await press('setup-next');
    const reply = q('[data-testid="setup-preview-reply"]')!;
    expect(reply.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      reply.querySelector('[aria-live]')?.textContent,
    );
    for (let i = 0; i < 4; i += 1) await press('setup-next');
    expect(step()).toBe('done');
    expect(q('[data-testid="setup-confetti"]')).toBeNull();
  });

  it('full motion: shows specks and confetti, and leaves no timer or frame behind once closed', async () => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'requestAnimationFrame',
        'cancelAnimationFrame',
      ],
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeContext());
    fullBridge();
    await render();
    expect(q('[data-testid="setup-wizard"]')?.dataset.intro).toBe('playing');
    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(vi.getTimerCount()).toBeGreaterThan(0); // the welcome scene is playing
    await press('setup-start');
    await press('setup-next');
    await act(async () => {
      vi.advanceTimersByTime(3000); // the sample reply types out and stops
    });
    const reply = q('[data-testid="setup-preview-reply"]')!;
    expect(reply.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      reply.querySelector('[aria-live]')?.textContent,
    );
    for (let i = 0; i < 4; i += 1) await press('setup-next');
    expect(q('[data-testid="setup-confetti"]')).not.toBeNull();
    await act(async () => root.unmount());
    // React's own one-shot work may still be queued; anything that loops would schedule again.
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
  });
});

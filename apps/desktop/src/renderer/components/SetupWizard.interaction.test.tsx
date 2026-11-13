// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ASSISTANT_PREFERENCES, type AssistantPreferences } from '@sprint-coder/contracts';
import { useAppStore } from '../store/appStore';
import { SETUP_COMPLETE_KEY } from '../lib/setup-preference';
import { SetupSky } from '../lib/setup-sky';
import type * as UiSound from '../lib/ui-sound';

const playCue = vi.hoisted(() => vi.fn());
vi.mock('../lib/ui-sound', async (importOriginal) => ({
  ...(await importOriginal<typeof UiSound>()),
  playInterfaceCue: playCue,
}));
import { SetupReplayDialog, SetupWizard } from './SetupWizard';

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
    const before = q('[data-testid="setup-preview-live"]')?.textContent;
    await choose('setup-tone-casual');
    await choose('setup-length-short');
    await choose('setup-depth-beginner');
    expect(settings.setAssistantPreferences).not.toHaveBeenCalled();
    // The whole sample (read by screen readers) changes immediately.
    expect(q('[data-testid="setup-preview-live"]')?.textContent).not.toBe(before);
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
    // The summary says what is stored: the skipped reply style is the stored one, unchanged.
    expect(summary).toContain('返事の仕方ていねい・ふつう・理由も変更なし');
    expect(summary).toContain('呼び名「ゆう」'); // what Main kept
    expect(q('[data-testid="setup-save-warning"]')).toBeNull();
  });

  it('keeps going when saving fails, and says so at the end', async () => {
    const settings = fullBridge();
    settings.setTeamUsageMode.mockRejectedValue(new Error('disk'));
    await render();
    await press('setup-start');
    await press('setup-next');
    await choose('setup-tone-crisp');
    await press('setup-next'); // reply saved
    await choose('setup-team-auto');
    await press('setup-next'); // team fails
    expect(step()).toBe('details');
    await press('setup-next');
    await press('setup-next');
    expect(step()).toBe('done');
    expect(q('[data-testid="setup-save-warning"]')?.textContent).toBe(
      '保存できなかった設定があります。設定の画面から変えられます。',
    );
  });

  it('stores nothing when every step is passed through untouched, or changed and put back', async () => {
    const settings = fullBridge();
    await render();
    await press('setup-start');
    await press('setup-next'); // ai -> reply
    // Changed and put back: the screen shows what is stored, so there is nothing to store.
    await choose('setup-tone-casual');
    await choose('setup-tone-polite');
    await press('setup-next'); // reply
    await press('setup-next'); // team, untouched
    await press('setup-next'); // details, untouched
    await press('setup-next'); // workspace
    expect(step()).toBe('done');
    // Back through every step and forward again: still nothing.
    for (let i = 0; i < 5; i += 1) await press('setup-back');
    expect(step()).toBe('ai');
    for (let i = 0; i < 5; i += 1) await press('setup-next');
    expect(settings.setAssistantPreferences).not.toHaveBeenCalled();
    expect(settings.setTeamUsageMode).not.toHaveBeenCalled();
    expect(localStorage.getItem('sprint-coder:default-access-preset')).toBeNull();
    expect(localStorage.getItem('sprint-coder:sound-effects')).toBeNull();
    const summary = q('[data-testid="setup-summary"]')?.textContent ?? '';
    expect(summary).toContain('返事の仕方まだ決めていません（今までどおり）変更なし');
    expect(summary).toContain('Team言った時だけ変更なし');
  });

  it('a change on the app-only part of the details stores that part alone', async () => {
    const settings = fullBridge();
    await render();
    await press('setup-start');
    await press('setup-next');
    await press('setup-next');
    await press('setup-next');
    expect(step()).toBe('details');
    await choose('setup-access-ask');
    await press('setup-next');
    expect(localStorage.getItem('sprint-coder:default-access-preset')).toBe('ask');
    expect(settings.setAssistantPreferences).not.toHaveBeenCalled();
  });

  it('leaving by "戻る" stores a step only if it was changed', async () => {
    const settings = fullBridge();
    await render();
    await press('setup-start');
    await press('setup-next');
    await press('setup-next');
    expect(step()).toBe('team');
    await press('setup-back');
    expect(settings.setTeamUsageMode).not.toHaveBeenCalled();
    await press('setup-next');
    await choose('setup-team-proactive');
    await press('setup-back');
    expect(settings.setTeamUsageMode).toHaveBeenCalledExactlyOnceWith({ mode: 'proactive' });
  });

  it('closing the replay keeps only the steps already stored', async () => {
    const settings = fullBridge();
    const onClose = vi.fn();
    await render({ mode: 'replay', onClose });
    await press('setup-start');
    await press('setup-next');
    await choose('setup-tone-crisp');
    await press('setup-next'); // stored
    await choose('setup-team-proactive');
    await press('setup-close'); // the Team change is dropped
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(settings.setAssistantPreferences).toHaveBeenCalledTimes(1);
    expect(settings.setTeamUsageMode).not.toHaveBeenCalled();
  });

  it('after a save, a later change to the same item elsewhere is followed, not overwritten', async () => {
    const settings = fullBridge();
    let current = { ...DEFAULT_ASSISTANT_PREFERENCES };
    settings.getAssistantPreferences.mockImplementation(async () => ({
      configured: true,
      preferences: current,
    }));
    settings.setAssistantPreferences.mockImplementation(async (input: AssistantPreferences) => {
      current = { ...input };
      return { configured: true, preferences: current };
    });
    await render();
    await press('setup-start');
    await press('setup-next'); // reply
    await choose('setup-tone-crisp');
    await press('setup-next'); // saved: crisp
    // In Settings, the same item changes again; the window comes back to the front.
    current = { ...current, tone: 'casual' };
    await act(async () => window.dispatchEvent(new Event('focus')));
    await flush();
    await press('setup-back'); // team -> reply
    expect(q<HTMLInputElement>('[data-testid="setup-tone-casual"]')?.checked).toBe(true);
    await press('setup-next');
    await press('setup-next'); // details
    await choose('setup-emoji');
    await press('setup-next');
    expect(settings.setAssistantPreferences).toHaveBeenLastCalledWith({
      ...DEFAULT_ASSISTANT_PREFERENCES,
      tone: 'casual',
      emoji: true,
    });
  });

  it('a read that started before a save and answers after it is dropped', async () => {
    const settings = fullBridge();
    let current = { ...DEFAULT_ASSISTANT_PREFERENCES };
    let holdNextRead = false;
    let answerHeldRead: () => void = () => {};
    settings.getAssistantPreferences.mockImplementation(() => {
      const answer = { configured: true, preferences: { ...current } };
      if (!holdNextRead) return Promise.resolve(answer);
      holdNextRead = false;
      return new Promise((resolve) => (answerHeldRead = () => resolve(answer)));
    });
    let finishSave: () => void = () => {};
    settings.setAssistantPreferences.mockImplementation(
      (input: AssistantPreferences) =>
        new Promise((resolve) => {
          finishSave = () => {
            current = { ...input };
            resolve({ configured: true, preferences: current });
          };
        }),
    );
    await render();
    await press('setup-start');
    await press('setup-next'); // reply
    await choose('setup-tone-crisp');
    // A read starts (the window came to the front) and will answer with what was stored before.
    holdNextRead = true;
    await act(async () => window.dispatchEvent(new Event('focus')));
    // The save starts and finishes before that read answers.
    await act(async () => q<HTMLButtonElement>('[data-testid="setup-next"]')!.click());
    const readsDuringSave = settings.getAssistantPreferences.mock.calls.length;
    await act(async () => window.dispatchEvent(new Event('focus'))); // no read starts mid-save
    expect(settings.getAssistantPreferences.mock.calls.length).toBe(readsDuringSave);
    await act(async () => finishSave());
    await flush();
    await act(async () => answerHeldRead()); // the old answer arrives last
    await flush();
    expect(step()).toBe('team');
    await press('setup-back');
    expect(q<HTMLInputElement>('[data-testid="setup-tone-crisp"]')?.checked).toBe(true);
    for (let i = 0; i < 4; i += 1) await press('setup-next');
    expect(step()).toBe('done');
    expect(q('[data-testid="setup-summary"]')?.textContent).toContain('きびきび');
  });

  it('after a failed first Task, a different folder makes its own Project and the Task goes there (intended: the empty one stays, as no Project can be removed)', async () => {
    installBridge({});
    pickProjectFolders
      .mockResolvedValueOnce({ canceled: false, folders: [{ path: 'C:/work/a', label: 'a' }] })
      .mockResolvedValueOnce({ canceled: false, folders: [{ path: 'C:/work/b', label: 'b' }] });
    createProject
      .mockResolvedValueOnce({ id: 'project-a' })
      .mockResolvedValueOnce({ id: 'project-b' });
    createTask.mockResolvedValueOnce(null);
    await render();
    await press('setup-start');
    await press('setup-next');
    await press('setup-next');
    await press('setup-folder');
    await press('setup-next');
    await press('setup-finish');
    await waitForHandOff();
    expect(container.textContent).toContain('最初の Task を作れませんでした');
    await press('setup-back');
    await press('setup-folder');
    await press('setup-next');
    await press('setup-finish');
    await waitForHandOff();
    // The first, empty Project stays (there is no way to remove one); the Task is in the new one.
    expect(createProject).toHaveBeenCalledTimes(2);
    expect(createProject).toHaveBeenLastCalledWith('b', [
      { path: 'C:/work/b', label: 'b', role: 'primary' },
    ]);
    expect(createTask).toHaveBeenLastCalledWith('project-b');
  });

  it('a choice changed and put back is no change: Settings’ later value is followed and kept', async () => {
    const settings = fullBridge();
    let current = { ...DEFAULT_ASSISTANT_PREFERENCES };
    settings.getAssistantPreferences.mockImplementation(async () => ({
      configured: true,
      preferences: current,
    }));
    await render();
    await press('setup-start');
    await press('setup-next'); // reply
    await choose('setup-tone-casual');
    await choose('setup-tone-polite');
    // Settings stores another tone; the window comes back to the front.
    current = { ...current, tone: 'crisp' };
    await act(async () => window.dispatchEvent(new Event('focus')));
    await flush();
    expect(q<HTMLInputElement>('[data-testid="setup-tone-crisp"]')?.checked).toBe(true);
    await press('setup-next');
    expect(settings.setAssistantPreferences).not.toHaveBeenCalled();
    expect(step()).toBe('team');
  });

  it('the summary lists every detail changed and saved here', async () => {
    fullBridge();
    await render();
    await press('setup-start');
    await press('setup-next');
    await press('setup-next');
    await press('setup-next');
    expect(step()).toBe('details');
    await choose('setup-confirm-ask');
    await choose('setup-emoji');
    await choose('setup-plan-first');
    await choose('setup-sound');
    await choose('setup-access-ask');
    await press('setup-next');
    await press('setup-next');
    const summary = q('[data-testid="setup-summary"]')?.textContent ?? '';
    for (const text of [
      '進め方: 迷ったら聞く',
      '絵文字を使う: オン',
      '作業の前に進め方を見せる: オン',
      '効果音: オン',
      '新しいタスクの安全設定: 実行前に確認',
    ]) {
      expect(summary).toContain(text);
    }
    // Not changed here: shown with its stored value, without the mark.
    expect(summary).toContain('返事の言語: 相手に合わせる');
    // Every change on the row was saved: the row's one mark says so, not each item again.
    expect(summary).not.toContain('（変更しました）');
    const row = [...container.querySelectorAll('[data-testid="setup-summary"] li')].find((li) =>
      li.textContent?.startsWith('細かい好み'),
    );
    expect(row?.querySelector('.setup-summary-note')?.textContent).toBe('変更しました');
  });

  it('says what "前回選択した設定" means, on a first launch and after a choice', async () => {
    fullBridge();
    await render();
    await press('setup-start');
    await press('setup-next');
    await press('setup-next');
    await press('setup-next');
    expect(q('[data-testid="setup-access"]')?.textContent).toContain('はじめは「実行前に確認」');
    await act(async () => root.unmount());
    root = createRoot(container);
    localStorage.setItem('sprint-coder:last-access-preset', 'auto');
    await render();
    await press('setup-start');
    await press('setup-next');
    await press('setup-next');
    await press('setup-next');
    expect(q('[data-testid="setup-access"]')?.textContent).toContain(
      '今は「安全時は自動」を引き継ぐ',
    );
  });

  describe('what is stored, and only that', () => {
    const goTo = async (target: string) => {
      await press('setup-start');
      for (let i = 0; i < 8 && step() !== target; i += 1) await press('setup-next');
      expect(step()).toBe(target);
    };

    it('the Team step shows no choice until the stored mode is read, then the right one; "言った時だけ" is then really stored', async () => {
      const settings = fullBridge(undefined, 'proactive');
      settings.getTeamUsageMode
        .mockRejectedValueOnce(new Error('busy'))
        .mockRejectedValueOnce(new Error('busy'));
      await render();
      await goTo('team');
      expect(q('[data-testid="setup-reading-failed"]')?.textContent).toContain(
        '今の設定を読み込めませんでした',
      );
      expect(q('[data-testid="setup-team-explicit"]')).toBeNull();
      const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes('もう一度読み込む'),
      )!;
      await act(async () => retry.click());
      await flush();
      expect(q<HTMLInputElement>('[data-testid="setup-team-proactive"]')?.checked).toBe(true);
      await choose('setup-team-explicit');
      await press('setup-next');
      expect(settings.setTeamUsageMode).toHaveBeenCalledExactlyOnceWith({ mode: 'explicit' });
    });

    it('a read that a save overtook is made again after it', async () => {
      const settings = fullBridge();
      const current = { ...DEFAULT_ASSISTANT_PREFERENCES, tone: 'crisp' as const };
      const held: (() => void)[] = [];
      settings.getAssistantPreferences.mockImplementation(() => {
        const answer = { configured: true, preferences: { ...current } };
        if (held.length < 2) return new Promise((resolve) => held.push(() => resolve(answer)));
        return Promise.resolve(answer);
      });
      await render();
      await goTo('details');
      // Only this PC's part is offered while the reply settings are being read.
      expect(q('[data-testid="setup-reading"]')).not.toBeNull();
      await choose('setup-sound');
      await press('setup-next'); // a save: the two reads still waiting are now out of date
      for (const answer of held) await act(async () => answer());
      await flush();
      await flush();
      expect(settings.getAssistantPreferences.mock.calls.length).toBeGreaterThanOrEqual(3);
      await press('setup-next');
      expect(q('[data-testid="setup-summary"]')?.textContent).toContain('きびきび・ふつう・理由も');
    });

    it('"あとで決める" keeps what is stored, and the summary says so with the value', async () => {
      fullBridge(undefined, 'proactive');
      await render();
      await goTo('team');
      expect(q('[data-testid="setup-skip"]')?.textContent).toBe('あとで決める今の設定のまま進む');
      await choose('setup-team-explicit');
      await press('setup-skip');
      for (let i = 0; i < 3 && step() !== 'done'; i += 1) await press('setup-next');
      expect(q('[data-testid="setup-summary"]')?.textContent).toContain('Team積極的に変更なし');
    });

    it('when only the reply part of the details fails, this PC’s part is shown as stored, the failure only on its items', async () => {
      const settings = fullBridge();
      settings.setAssistantPreferences.mockRejectedValue(new Error('disk'));
      await render();
      await goTo('details');
      await choose('setup-emoji');
      await choose('setup-access-full');
      await press('setup-next');
      await press('setup-next');
      let summary = q('[data-testid="setup-summary"]')?.textContent ?? '';
      expect(summary).toContain('新しいタスクの安全設定: フルアクセス（変更しました）');
      expect(summary).toContain('返事の項目: まだ決めていません（今までどおり）');
      expect(summary).toContain('絵文字（保存できませんでした）');
      expect(q('[data-testid="setup-save-warning"]')).not.toBeNull();
      // Going back and skipping keeps both the record of the failure and the stored values.
      await press('setup-back');
      await press('setup-back');
      await press('setup-skip');
      await press('setup-next');
      summary = q('[data-testid="setup-summary"]')?.textContent ?? '';
      expect(summary).toContain('フルアクセス（変更しました）');
      expect(summary).toContain('絵文字（保存できませんでした）');
    });

    it('sound and the safety default changed in Settings meanwhile are followed, and not written back', async () => {
      fullBridge();
      await render();
      await press('setup-start');
      // In Settings: sound on, full access.
      localStorage.setItem(
        'sprint-coder:sound-effects',
        JSON.stringify({ enabled: true, volume: 0.2 }),
      );
      localStorage.setItem('sprint-coder:default-access-preset', 'full');
      await act(async () => window.dispatchEvent(new Event('focus')));
      await flush();
      for (let i = 0; i < 4 && step() !== 'details'; i += 1) await press('setup-next');
      expect(q<HTMLInputElement>('[data-testid="setup-sound"]')?.checked).toBe(true);
      expect(q<HTMLInputElement>('[data-testid="setup-access-full"]')?.checked).toBe(true);
      await choose('setup-access-ask');
      await press('setup-next');
      expect(JSON.parse(localStorage.getItem('sprint-coder:sound-effects') ?? '{}').enabled).toBe(
        true,
      );
      expect(localStorage.getItem('sprint-coder:default-access-preset')).toBe('ask');
    });

    it('while a save is waiting, × and Escape do nothing; afterwards they close', async () => {
      const settings = fullBridge();
      let finishSave: () => void = () => {};
      settings.setTeamUsageMode.mockImplementation(
        (input: { mode: string }) => new Promise((resolve) => (finishSave = () => resolve(input))),
      );
      const onClose = vi.fn();
      await render({ mode: 'replay', onClose });
      await goTo('team');
      await choose('setup-team-auto');
      await act(async () => q<HTMLButtonElement>('[data-testid="setup-next"]')!.click());
      expect(q<HTMLButtonElement>('[data-testid="setup-close"]')?.disabled).toBe(true);
      await act(async () => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
      expect(onClose).not.toHaveBeenCalled();
      await act(async () => finishSave());
      await flush();
      await press('setup-close');
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('if what is stored cannot be read again just before a save, nothing is written (Settings’ later changes are not put back)', async () => {
      const settings = fullBridge();
      let current = { ...DEFAULT_ASSISTANT_PREFERENCES };
      let readable = true;
      settings.getAssistantPreferences.mockImplementation(async () => {
        if (!readable) throw new Error('busy');
        return { configured: true, preferences: { ...current } };
      });
      await render();
      await goTo('details');
      // In Settings, the language changes; from now on reading fails.
      current = { ...current, language: 'en' };
      readable = false;
      await choose('setup-emoji');
      await press('setup-next');
      expect(settings.setAssistantPreferences).not.toHaveBeenCalled();
      expect(step()).toBe('workspace');
      await press('setup-next');
      const row = [...container.querySelectorAll('[data-testid="setup-summary"] li')].find((li) =>
        li.textContent?.startsWith('細かい好み'),
      );
      expect(row?.querySelector('.setup-summary-note')?.textContent).toBe('保存できませんでした');
      expect(q('[data-testid="setup-save-warning"]')).not.toBeNull();
      // The person's change is still on screen, and once reading works again it goes out laid
      // over what Settings stored meanwhile.
      await press('setup-back'); // done -> workspace
      await press('setup-back'); // workspace -> details
      expect(step()).toBe('details');
      expect(q<HTMLInputElement>('[data-testid="setup-emoji"]')?.checked).toBe(true);
      readable = true;
      await press('setup-next');
      expect(settings.setAssistantPreferences).toHaveBeenCalledTimes(1);
      expect(settings.setAssistantPreferences).toHaveBeenCalledWith(
        expect.objectContaining({ emoji: true, language: 'en' }),
      );
    });

    it('answers arriving out of order: an older read never undoes a newer one', async () => {
      const settings = fullBridge(undefined, 'auto');
      let answerFirst: () => void = () => {};
      settings.getTeamUsageMode.mockImplementationOnce(
        () => new Promise((resolve) => (answerFirst = () => resolve({ mode: 'explicit' }))),
      );
      await render(); // the first read of the Team mode is slow
      await act(async () => window.dispatchEvent(new Event('focus'))); // a later one answers first
      await flush();
      await goTo('team');
      expect(q<HTMLInputElement>('[data-testid="setup-team-auto"]')?.checked).toBe(true);
      await act(async () => answerFirst()); // the old answer arrives last
      await flush();
      expect(q<HTMLInputElement>('[data-testid="setup-team-auto"]')?.checked).toBe(true);
      expect(q('[data-testid="setup-wizard"]')?.dataset.team).toBe('auto');
    });

    it('a broken answer from Main counts as not read: nothing is shown or stored as the default', async () => {
      const settings = fullBridge();
      settings.getAssistantPreferences.mockResolvedValue({
        configured: true,
        preferences: { tone: 'casual' },
      });
      settings.getTeamUsageMode.mockResolvedValue({ mode: 'sometimes' });
      await render();
      await goTo('reply');
      expect(q('[data-testid="setup-reading-failed"]')).not.toBeNull();
      expect(q('[data-testid="setup-tone-polite"]')).toBeNull();
      await press('setup-next');
      expect(step()).toBe('team');
      expect(q('[data-testid="setup-reading-failed"]')).not.toBeNull();
      expect(q('[data-testid="setup-team-explicit"]')).toBeNull();
      for (let i = 0; i < 4 && step() !== 'done'; i += 1) await press('setup-next');
      const summary = q('[data-testid="setup-summary"]')?.textContent ?? '';
      expect(summary).toContain('返事の仕方今の設定を読み込めませんでした');
      expect(summary).toContain('Team今の設定を読み込めませんでした');
      expect(settings.setAssistantPreferences).not.toHaveBeenCalled();
      expect(settings.setTeamUsageMode).not.toHaveBeenCalled();
    });

    it('the replay dialog: while a step is being saved, its own Escape (cancel) does not close it, and the focus stays inside', async () => {
      const settings = fullBridge();
      let finishSave: () => void = () => {};
      settings.setTeamUsageMode.mockImplementation(
        (input: { mode: string }) => new Promise((resolve) => (finishSave = () => resolve(input))),
      );
      const onClose = vi.fn();
      await act(async () => {
        root.render(<SetupReplayDialog onClose={onClose} onOpenSettings={() => {}} />);
      });
      await flush();
      await goTo('team');
      await choose('setup-team-auto');
      const next = q<HTMLButtonElement>('[data-testid="setup-next"]')!;
      next.focus();
      await act(async () => next.click());
      // The button about to be disabled hands the focus to the heading, not to the page.
      expect(document.activeElement?.id).toBe('setup-title');
      const dialog = q<HTMLDialogElement>('[data-testid="setup-replay-dialog"]')!;
      const cancel = new Event('cancel', { cancelable: true });
      await act(async () => dialog.dispatchEvent(cancel));
      expect(cancel.defaultPrevented).toBe(true);
      expect(onClose).not.toHaveBeenCalled();
      await act(async () => finishSave());
      await flush();
      expect(step()).toBe('details');
      await act(async () => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('the replay dialog: when the browser closes it on its own, the app is told', async () => {
      fullBridge();
      const onClose = vi.fn();
      await act(async () => {
        root.render(<SetupReplayDialog onClose={onClose} onOpenSettings={() => {}} />);
      });
      await flush();
      // Chromium closes a dialog on a second Escape in a row whatever `cancel` did.
      const dialog = q<HTMLDialogElement>('[data-testid="setup-replay-dialog"]')!;
      await act(async () => dialog.dispatchEvent(new Event('close')));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('reply settings that cannot be read are never written over with defaults', async () => {
      const settings = fullBridge();
      settings.getAssistantPreferences.mockRejectedValue(new Error('busy'));
      await render();
      await goTo('reply');
      expect(q('[data-testid="setup-reading-failed"]')).not.toBeNull();
      expect(q('[data-testid="setup-tone-polite"]')).toBeNull();
      for (let i = 0; i < 6 && step() !== 'done'; i += 1) await press('setup-next');
      expect(settings.setAssistantPreferences).not.toHaveBeenCalled();
      expect(q('[data-testid="setup-summary"]')?.textContent).toContain(
        '返事の仕方今の設定を読み込めませんでした',
      );
    });
  });

  describe('motion, sound and the drawing surface', () => {
    it('switching motion off part-way gives the new still sky the current look and Team', async () => {
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
      const setTheme = vi.spyOn(SetupSky.prototype, 'setTheme');
      const setTeam = vi.spyOn(SetupSky.prototype, 'setTeam');
      fullBridge(undefined, 'proactive');
      await render();
      await press('setup-start');
      for (let i = 0; i < 4 && step() !== 'team'; i += 1) await press('setup-next');
      setTheme.mockClear();
      setTeam.mockClear();
      reduced = true;
      await act(async () => {
        for (const listener of listeners) listener();
      });
      expect(q('[data-testid="setup-wizard"]')?.dataset.motion).toBe('reduced');
      expect(q('[data-testid="setup-wizard"]')?.dataset.intro).toBe('done');
      expect(setTheme).toHaveBeenCalled();
      expect(setTeam).toHaveBeenLastCalledWith('proactive', 0.86, 0.045);
    });

    it('sounds follow the switch on screen: heard when switched on, silent when switched off', async () => {
      fullBridge();
      await render();
      await press('setup-start');
      for (let i = 0; i < 4 && step() !== 'details'; i += 1) await press('setup-next');
      playCue.mockClear();
      await choose('setup-sound'); // on (not stored yet)
      expect(playCue).toHaveBeenLastCalledWith('check', true);
      await choose('setup-access-ask');
      expect(playCue).toHaveBeenLastCalledWith('select', true);
      playCue.mockClear();
      await choose('setup-sound'); // off
      expect(playCue.mock.calls.every(([, enabled]) => enabled === false)).toBe(true);
      await choose('setup-access-auto');
      expect(playCue).toHaveBeenLastCalledWith('select', false);
    });
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

  it('"最初の Task を始める" pressed twice in the same moment makes one Project and one Task', async () => {
    installBridge({});
    pickProjectFolders.mockResolvedValue({
      canceled: false,
      folders: [{ path: 'C:/work/app', label: 'app' }],
    });
    await render();
    await press('setup-start');
    await press('setup-next');
    await press('setup-next');
    await press('setup-folder');
    await press('setup-next');
    expect(step()).toBe('done');
    const finishButton = q<HTMLButtonElement>('[data-testid="setup-finish"]')!;
    // Both presses land before the button can be redrawn as disabled.
    await act(async () => {
      finishButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      finishButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitForHandOff();
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenCalledTimes(1);
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
    // Going back and forth between the folder and the end makes nothing yet.
    for (let i = 0; i < 3; i += 1) {
      await press('setup-back');
      expect(step()).toBe('workspace');
      await press('setup-next');
      expect(step()).toBe('done');
    }
    expect(createProject).not.toHaveBeenCalled();
    expect(q('[data-testid="setup-summary"]')?.textContent).toContain('app');
    await press('setup-finish');
    await waitForHandOff();
    expect(createProject).toHaveBeenCalledExactlyOnceWith('app', [
      { path: 'C:/work/app', label: 'app', role: 'primary' },
    ]);
    expect(createTask).toHaveBeenCalledExactlyOnceWith('project-1');
  });

  it('makes the Project once even when the first Task has to be retried', async () => {
    installBridge({});
    pickProjectFolders.mockResolvedValue({
      canceled: false,
      folders: [{ path: 'C:/work/app', label: 'app' }],
    });
    createTask.mockResolvedValueOnce(null);
    const recover = vi.spyOn(SetupSky.prototype, 'recover');
    await render();
    await press('setup-start');
    await press('setup-next');
    await press('setup-next');
    await press('setup-folder');
    await press('setup-next');
    await press('setup-finish');
    await waitForHandOff();
    expect(container.textContent).toContain('最初の Task を作れませんでした');
    // The hand-off is undone: the board and the sky come back.
    expect(q('[data-testid="setup-wizard"]')?.classList.contains('is-leaving')).toBe(false);
    expect(recover).toHaveBeenCalled();
    await press('setup-finish');
    await waitForHandOff();
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenNthCalledWith(2, 'project-1');
  });

  it('a save lays only the items changed here over what is stored now (Settings may have changed others)', async () => {
    const settings = fullBridge();
    let current = { ...DEFAULT_ASSISTANT_PREFERENCES };
    settings.getAssistantPreferences.mockImplementation(async () => ({
      configured: true,
      preferences: current,
    }));
    await render();
    await press('setup-start');
    // Meanwhile, in Settings: another language and a call name.
    current = { ...current, language: 'en', callName: 'ゆう' };
    await press('setup-next'); // ai -> reply
    await choose('setup-tone-crisp');
    await press('setup-next');
    expect(settings.setAssistantPreferences).toHaveBeenCalledExactlyOnceWith({
      ...DEFAULT_ASSISTANT_PREFERENCES,
      tone: 'crisp',
      language: 'en',
      callName: 'ゆう',
    });
  });

  it('back from Settings, the items not touched here show what Settings stored', async () => {
    const settings = fullBridge();
    let current = { ...DEFAULT_ASSISTANT_PREFERENCES };
    settings.getAssistantPreferences.mockImplementation(async () => ({
      configured: true,
      preferences: current,
    }));
    const onOpenSettings = vi.fn();
    await render({ onOpenSettings });
    await press('setup-start');
    expect(step()).toBe('ai');
    const opener = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('接続を設定'),
    )!;
    await act(async () => opener.click());
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    current = { ...current, language: 'en' };
    // Settings closes and gives the focus back to the button inside the Setup.
    await act(async () => opener.focus());
    await flush();
    await press('setup-next'); // reply
    await press('setup-next'); // team
    await press('setup-next'); // details
    expect(q<HTMLInputElement>('[data-testid="setup-language-en"]')?.checked).toBe(true);
  });

  it('while a step is being saved, its choices are locked; the summary shows what was stored', async () => {
    const settings = fullBridge();
    let finishSave: (value: { mode: string }) => void = () => {};
    settings.setTeamUsageMode.mockImplementation(
      () => new Promise<{ mode: string }>((resolve) => (finishSave = resolve)),
    );
    await render();
    await press('setup-start');
    await press('setup-next');
    await press('setup-next');
    expect(step()).toBe('team');
    await choose('setup-team-auto');
    await act(async () => q<HTMLButtonElement>('[data-testid="setup-next"]')!.click());
    // Waiting: the step is locked, and trying to change the choice changes nothing.
    expect(q<HTMLFieldSetElement>('[data-testid="setup-step-team"]')?.disabled).toBe(true);
    expect(q<HTMLButtonElement>('[data-testid="setup-back"]')?.disabled).toBe(true);
    expect(q<HTMLButtonElement>('[data-testid="setup-skip"]')?.disabled).toBe(true);
    await choose('setup-team-explicit');
    expect(q<HTMLInputElement>('[data-testid="setup-team-auto"]')?.checked).toBe(true);
    await act(async () => finishSave({ mode: 'auto' }));
    await flush();
    expect(settings.setTeamUsageMode).toHaveBeenCalledExactlyOnceWith({ mode: 'auto' });
    expect(step()).toBe('details');
    await press('setup-next');
    await press('setup-next');
    expect(q('[data-testid="setup-summary"]')?.textContent).toContain('おまかせ');
  });

  it('a failed save is shown as not stored, not as the choice', async () => {
    const settings = fullBridge();
    settings.setTeamUsageMode.mockRejectedValue(new Error('disk'));
    await render();
    await press('setup-start');
    await press('setup-next');
    await press('setup-next');
    await choose('setup-team-proactive');
    await press('setup-next');
    await press('setup-next');
    await press('setup-next');
    const summary = q('[data-testid="setup-summary"]')?.textContent ?? '';
    expect(summary).toContain('保存できませんでした');
    expect(summary).not.toContain('積極的に');
  });

  it('replay: opens on the stored choices, has no Workspace or first Task, and closes', async () => {
    fullBridge({ tone: 'casual', length: 'detailed' }, 'auto');
    const onClose = vi.fn();
    await render({ mode: 'replay', onClose });
    await press('setup-start');
    await press('setup-next');
    expect(q<HTMLInputElement>('[data-testid="setup-tone-casual"]')?.checked).toBe(true);
    expect(q<HTMLInputElement>('[data-testid="setup-length-detailed"]')?.checked).toBe(true);
    expect(q('[data-testid="setup-skip"]')?.textContent).toBe('あとで決める今の設定のまま進む');
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
      q('[data-testid="setup-preview-live"]')?.textContent,
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
      q('[data-testid="setup-preview-live"]')?.textContent,
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

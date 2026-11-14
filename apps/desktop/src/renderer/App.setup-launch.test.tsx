// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ASSISTANT_PREFERENCES } from '@sprint-coder/contracts';
import { useAppStore } from './store/appStore';
import { SETUP_COMPLETE_KEY, SETUP_REPLAY_EVENT, isSetupShowing } from './lib/setup-preference';
import type * as UiSound from './lib/ui-sound';

// The app shell around the Setup is stubbed: these tests are about which Setup the launch shows.
vi.mock('./lib/ui-sound', async (importOriginal) => ({
  ...(await importOriginal<typeof UiSound>()),
  playInterfaceCue: vi.fn(),
  unlockSoundEffects: vi.fn().mockResolvedValue(false),
}));
vi.mock('./components/Sidebar', () => ({ Sidebar: () => <nav data-testid="stub-sidebar" /> }));
vi.mock('./components/TaskHeader', () => ({ TaskHeader: () => null }));
vi.mock('./components/GraphPanel', () => ({ GraphPanel: () => null }));
vi.mock('./components/ChatSurface/SurfaceLayer', () => ({
  SurfaceLayer: () => null,
  captureSurfaceState: vi.fn(),
}));
vi.mock('./components/TeamCanvas/TeamCanvas', () => ({ TeamCanvas: () => null }));
vi.mock('./components/TeamListView', () => ({ TeamListView: () => null }));
vi.mock('./components/SettingsDialog', () => ({ SettingsDialog: () => null }));
vi.mock('./components/AppTitlebar', () => ({ AppTitlebar: () => null }));
vi.mock('./components/SidebarResizer', () => ({ SidebarResizer: () => null }));

import App from './App';

const OLD_MARK = 'sprint-coder:setup-complete-v1';

let container: HTMLDivElement;
let root: Root;
const createTask = vi.fn();

/** What is stored before the Setup opens. It differs from the defaults (and `emoji` and `callName`
 * are on a step these tests never change), so a save that wrote the defaults, or the whole draft,
 * over it would show. */
const STORED_PREFERENCES = {
  ...DEFAULT_ASSISTANT_PREFERENCES,
  emoji: true,
  callName: 'ゆうせい',
};

function bridge() {
  const settings = {
    getAssistantPreferences: vi
      .fn()
      .mockResolvedValue({ configured: true, preferences: STORED_PREFERENCES }),
    setAssistantPreferences: vi.fn(async (input: unknown) => ({
      configured: true,
      preferences: input,
    })),
    getTeamUsageMode: vi.fn().mockResolvedValue({ mode: 'explicit' }),
    setTeamUsageMode: vi.fn(async (input: { mode: string }) => input),
  };
  Object.defineProperty(window, 'sprintCoder', { configurable: true, value: { settings } });
  return settings;
}

function task(id: string) {
  return { id, title: id, archived: false, createdAt: 0, updatedAt: 0 };
}

function launchWith(state: {
  initialized: boolean;
  tasks: ReturnType<typeof task>[];
  error?: string | null;
}) {
  useAppStore.setState({
    init: vi.fn(),
    createTask,
    sprintCoderAvailable: true,
    selectedTaskId: null,
    teamViewOpen: false,
    error: null,
    ...state,
  } as unknown as Partial<ReturnType<typeof useAppStore.getState>>);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount() {
  // As in development (main.tsx): effects run twice, which the dialog must survive.
  await act(async () =>
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  );
  await flush();
}

/** A new launch: the shell is put up again from scratch on the same profile (localStorage). */
async function relaunch() {
  await act(async () => root.unmount());
  root = createRoot(container);
  await mount();
}

const q = <T extends HTMLElement = HTMLElement>(selector: string) =>
  container.querySelector<T>(selector);
const progress = () => q('.setup-progress-count')?.textContent ?? '';

async function press(testId: string) {
  const button = q<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!button) throw new Error(`missing ${testId}`);
  await act(async () => button.click());
  await flush();
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      // Reduced motion: no timers to wait for between the steps.
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  localStorage.clear();
  createTask.mockReset().mockResolvedValue({ id: 'task-1' });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'sprintCoder');
});

describe('the Setup at launch', () => {
  it('nothing is shown before the Tasks are known', async () => {
    bridge();
    launchWith({ initialized: false, tasks: [task('a')] });
    await mount();
    expect(q('[data-testid="setup-wizard"]')).toBeNull();
    expect(q('[data-testid="setup-replay-dialog"]')).toBeNull();
  });

  it('a new installation (no Task, no mark) gets the first run, Workspace step included', async () => {
    bridge();
    launchWith({ initialized: true, tasks: [] });
    await mount();
    expect(q('[data-testid="setup-wizard"]')).not.toBeNull();
    expect(q('[data-testid="setup-replay-dialog"]')).toBeNull();
    expect(q('[data-testid="stub-sidebar"]')).toBeNull();
    expect(progress()).toMatch(/^1 \/ 7/);
    expect(isSetupShowing()).toBe(true);
  });

  it('the first run also comes when only the older Setup’s mark is there', async () => {
    bridge();
    localStorage.setItem(OLD_MARK, '1');
    launchWith({ initialized: true, tasks: [] });
    await mount();
    expect(q('[data-testid="setup-wizard"]')).not.toBeNull();
    expect(progress()).toMatch(/^1 \/ 7/);
  });

  it('after an update (Tasks and the older mark): the Setup without the Workspace step, over the app; × closes it, nothing is stored, and the next launch does not show it', async () => {
    const settings = bridge();
    localStorage.setItem(OLD_MARK, '1');
    launchWith({ initialized: true, tasks: [task('a')] });
    await mount();
    const dialog = q('[data-testid="setup-replay-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector('[data-testid="setup-wizard"]')).not.toBeNull();
    // The app stays underneath.
    expect(q('[data-testid="stub-sidebar"]')).not.toBeNull();
    expect(progress()).toMatch(/^1 \/ 6/);
    expect(isSetupShowing()).toBe(true);
    // Shown, and not yet gone through.
    expect(localStorage.getItem(SETUP_COMPLETE_KEY)).toBeNull();

    await press('setup-close');
    expect(q('[data-testid="setup-replay-dialog"]')).toBeNull();
    expect(q('[data-testid="stub-sidebar"]')).not.toBeNull();
    expect(localStorage.getItem(SETUP_COMPLETE_KEY)).toBe('1');
    expect(isSetupShowing()).toBe(false);
    expect(settings.setAssistantPreferences).not.toHaveBeenCalled();
    expect(settings.setTeamUsageMode).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();

    await relaunch();
    expect(q('[data-testid="setup-replay-dialog"]')).toBeNull();
    expect(q('[data-testid="setup-wizard"]')).toBeNull();
  });

  it('Tasks without any mark get the same; walked to the end untouched and finished, nothing is stored and it is marked', async () => {
    const settings = bridge();
    launchWith({ initialized: true, tasks: [task('a'), task('b')] });
    await mount();
    expect(q('[data-testid="setup-replay-dialog"]')).not.toBeNull();
    await press('setup-start');
    for (let n = 0; n < 6 && q('[data-testid="setup-next"]'); n++) await press('setup-next');
    expect(q('[data-testid="setup-wizard"]')?.dataset.step).toBe('done');
    expect(container.textContent).not.toContain('最初の Task を始める');
    await press('setup-finish');
    expect(q('[data-testid="setup-replay-dialog"]')).toBeNull();
    expect(localStorage.getItem(SETUP_COMPLETE_KEY)).toBe('1');
    expect(settings.setAssistantPreferences).not.toHaveBeenCalled();
    expect(settings.setTeamUsageMode).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
  });

  it('after an update, one value changed and the Setup finished: only that value is stored, over what is stored now', async () => {
    const settings = bridge();
    localStorage.setItem(OLD_MARK, '1');
    launchWith({ initialized: true, tasks: [task('a')] });
    await mount();
    await press('setup-start');
    await press('setup-next');
    expect(q('[data-testid="setup-wizard"]')?.dataset.step).toBe('reply');
    const casual = q<HTMLInputElement>('[data-testid="setup-tone-casual"]');
    expect(casual?.checked).toBe(false);
    await act(async () => casual?.click());
    for (let n = 0; n < 6 && q('[data-testid="setup-next"]'); n++) await press('setup-next');
    await press('setup-finish');
    expect(settings.setAssistantPreferences).toHaveBeenCalledTimes(1);
    // The one item changed, laid over what was stored: the stored items that are not defaults
    // (emoji, callName) are kept, not put back to the defaults.
    expect(settings.setAssistantPreferences).toHaveBeenCalledWith({
      ...STORED_PREFERENCES,
      tone: 'casual',
    });
    expect(settings.setTeamUsageMode).not.toHaveBeenCalled();
    expect(localStorage.getItem(SETUP_COMPLETE_KEY)).toBe('1');
    // This computer's own settings were not on a step that changed: the only key written is the mark.
    expect(Object.keys(localStorage)).toEqual([SETUP_COMPLETE_KEY, OLD_MARK].sort());
    await relaunch();
    expect(q('[data-testid="setup-replay-dialog"]')).toBeNull();
  });

  it('Escape closes the launch’s Setup like ×: marked, nothing stored', async () => {
    const settings = bridge();
    launchWith({ initialized: true, tasks: [task('a')] });
    await mount();
    const dialog = q<HTMLDialogElement>('[data-testid="setup-replay-dialog"]');
    expect(dialog).not.toBeNull();
    await act(async () => {
      dialog?.dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    await flush();
    expect(q('[data-testid="setup-replay-dialog"]')).toBeNull();
    expect(localStorage.getItem(SETUP_COMPLETE_KEY)).toBe('1');
    expect(Object.keys(localStorage)).toEqual([SETUP_COMPLETE_KEY]);
    expect(settings.setAssistantPreferences).not.toHaveBeenCalled();
    expect(settings.setTeamUsageMode).not.toHaveBeenCalled();
  });

  it('when the Tasks could not be read, no Setup is shown and nothing is marked; the next launch decides again', async () => {
    bridge();
    // What the store holds after a failed `tasks.list()`: initialized, no Task, an error.
    launchWith({ initialized: true, tasks: [], error: 'Tasks could not be read' });
    await mount();
    expect(q('[data-testid="setup-wizard"]')).toBeNull();
    expect(q('[data-testid="setup-replay-dialog"]')).toBeNull();
    expect(q('[data-testid="stub-sidebar"]')).not.toBeNull();
    expect(localStorage.getItem(SETUP_COMPLETE_KEY)).toBeNull();

    await act(async () => root.unmount());
    root = createRoot(container);
    launchWith({ initialized: true, tasks: [task('a')] });
    await mount();
    expect(q('[data-testid="setup-replay-dialog"]')).not.toBeNull();
  });

  it('closes even when the mark cannot be written', async () => {
    bridge();
    launchWith({ initialized: true, tasks: [task('a')] });
    await mount();
    expect(q('[data-testid="setup-replay-dialog"]')).not.toBeNull();
    const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    await press('setup-close');
    expect(refuse).toHaveBeenCalled();
    expect(q('[data-testid="setup-replay-dialog"]')).toBeNull();
    expect(isSetupShowing()).toBe(false);
  });

  it('when the mark cannot be read, people with Tasks are not shown a Setup at every launch; a new installation still gets its first run', async () => {
    bridge();
    // Only the mark is unreadable here; the Setup reads this computer's own settings by itself.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key: string) => {
      if (key === SETUP_COMPLETE_KEY)
        throw new DOMException('The operation is insecure.', 'SecurityError');
      return null;
    });
    launchWith({ initialized: true, tasks: [task('a')] });
    await mount();
    expect(q('[data-testid="setup-replay-dialog"]')).toBeNull();
    expect(q('[data-testid="setup-wizard"]')).toBeNull();

    await act(async () => root.unmount());
    root = createRoot(container);
    launchWith({ initialized: true, tasks: [] });
    await mount();
    expect(q('[data-testid="setup-wizard"]')).not.toBeNull();
    expect(progress()).toMatch(/^1 \/ 7/);
  });

  it('with this Setup’s mark, nothing is shown, with or without Tasks', async () => {
    bridge();
    localStorage.setItem(SETUP_COMPLETE_KEY, '1');
    launchWith({ initialized: true, tasks: [task('a')] });
    await mount();
    expect(q('[data-testid="setup-replay-dialog"]')).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);
    launchWith({ initialized: true, tasks: [] });
    await mount();
    expect(q('[data-testid="setup-wizard"]')).toBeNull();
    expect(q('[data-testid="stub-sidebar"]')).not.toBeNull();
  });

  it('"セットアップをもう一度" still opens the replay afterwards, but not a second one over the launch’s', async () => {
    bridge();
    launchWith({ initialized: true, tasks: [task('a')] });
    await mount();
    await act(async () => window.dispatchEvent(new Event(SETUP_REPLAY_EVENT)));
    expect(container.querySelectorAll('[data-testid="setup-replay-dialog"]')).toHaveLength(1);
    await press('setup-close');
    expect(q('[data-testid="setup-replay-dialog"]')).toBeNull();

    await act(async () => window.dispatchEvent(new Event(SETUP_REPLAY_EVENT)));
    await flush();
    expect(q('[data-testid="setup-replay-dialog"]')).not.toBeNull();
    await press('setup-close');
    expect(q('[data-testid="setup-replay-dialog"]')).toBeNull();
  });

  it('the first run ends with its first Task and marks this Setup, so the next launch shows nothing', async () => {
    bridge();
    launchWith({ initialized: true, tasks: [] });
    createTask.mockImplementation(async () => {
      useAppStore.setState({ tasks: [task('task-1')] } as unknown as Partial<
        ReturnType<typeof useAppStore.getState>
      >);
      return { id: 'task-1' };
    });
    await mount();
    await press('setup-start');
    for (let n = 0; n < 8 && q('[data-testid="setup-next"]'); n++) await press('setup-next');
    expect(q('[data-testid="setup-wizard"]')?.dataset.step).toBe('done');
    await press('setup-finish');
    await flush();
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="setup-wizard"]')).toBeNull();
    expect(q('[data-testid="setup-replay-dialog"]')).toBeNull();
    expect(localStorage.getItem(SETUP_COMPLETE_KEY)).toBe('1');

    await relaunch();
    expect(q('[data-testid="setup-wizard"]')).toBeNull();
    expect(q('[data-testid="setup-replay-dialog"]')).toBeNull();
  });
});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LOCAL_PROVIDER_PROFILES } from '../../main/bundled-provider-profiles';
import { useAppStore } from '../store/appStore';
import { SettingsDialog } from './SettingsDialog';
import { ADD_TOGGLE_ID, LIST_ERROR } from './ProviderSettingsSection';

const initial = useAppStore.getInitialState();
let container: HTMLDivElement;
let opener: HTMLButtonElement;
let root: Root;
let listConnections: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useAppStore.setState(initial, true);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });
  listConnections = vi.fn().mockResolvedValue([]);
  Object.defineProperty(window, 'sprintCoder', {
    configurable: true,
    value: {
      settings: { getRuntime: vi.fn() },
      providers: {
        listConnections,
        listProfiles: vi.fn().mockResolvedValue(LOCAL_PROVIDER_PROFILES),
      },
    },
  });
  opener = document.createElement('button');
  opener.textContent = 'モデル';
  container = document.createElement('div');
  document.body.append(opener, container);
  root = createRoot(container);
  opener.focus();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  opener.remove();
  Reflect.deleteProperty(window, 'sprintCoder');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  delete document.documentElement.dataset.theme;
  useAppStore.setState(initial, true);
  vi.unstubAllGlobals();
});

it.each([
  { workspace: false, theme: 'light' },
  { workspace: false, theme: 'dark' },
  { workspace: true, theme: 'light' },
  { workspace: true, theme: 'dark' },
])(
  'opens Provider connections and restores focus (workspace=$workspace, theme=$theme)',
  async ({ workspace, theme }) => {
    useAppStore.setState({ settingsWorkspaceV2: workspace });
    document.documentElement.dataset.theme = theme;
    const onClose = vi.fn();
    await act(async () => root.render(<SettingsDialog open focusProviders onClose={onClose} />));
    const add = container.querySelector<HTMLButtonElement>(`#${ADD_TOGGLE_ID}`)!;
    expect(add).not.toBeNull();
    expect(document.activeElement).toBe(add);
    expect(container.querySelector('.settings-local-ai')).toBeNull();
    expect(container.querySelector('[data-testid="settings-nav-local-ai"]')).toBeNull();
    if (workspace)
      expect(
        container.querySelector<HTMLElement>('[data-testid="settings-page-models"]')?.hidden,
      ).toBe(false);
    await act(async () => add.click());
    for (const id of ['localai', 'lm-studio', 'ollama'])
      expect(container.querySelector(`option[value="profile:${id}"]`)).not.toBeNull();
    // Native Escape raises cancel; jsdom does not implement the native dialog keyboard default.
    await act(async () =>
      container.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })),
    );
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () =>
      root.render(<SettingsDialog open={false} focusProviders onClose={onClose} />),
    );
    expect(document.activeElement).toBe(opener);
  },
);

it('keeps the Provider destination usable when the existing connection list fails', async () => {
  listConnections.mockRejectedValue(new Error('fixture unavailable'));
  await act(async () => root.render(<SettingsDialog open focusProviders onClose={() => {}} />));
  const add = container.querySelector<HTMLButtonElement>(`#${ADD_TOGGLE_ID}`)!;
  expect(document.activeElement).toBe(add);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(LIST_ERROR);
  expect(add.disabled).toBe(false);
});

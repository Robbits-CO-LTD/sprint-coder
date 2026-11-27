// @vitest-environment jsdom
import type { SprintCoderApi, UpdateInstallState } from '@sprint-coder/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AppTitlebar } from './AppTitlebar';

vi.mock('../lib/logo-glyph', () => ({ useLogoGlyph: () => null }));

it('only shows the update in the titlebar once downloaded and never requests restart while busy', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let publish: (state: UpdateInstallState) => void = () => undefined;
  let resolveSnapshot: (state: UpdateInstallState) => void = () => undefined;
  const restartToInstall = vi.fn(async () => undefined);
  const unsubscribe = vi.fn();
  const updates = {
    subscribeInstallState(listener) {
      publish = listener;
      return unsubscribe;
    },
    getInstallState: () =>
      new Promise<UpdateInstallState>((resolve) => (resolveSnapshot = resolve)),
    restartToInstall,
  } satisfies Pick<
    SprintCoderApi['updates'],
    'subscribeInstallState' | 'getInstallState' | 'restartToInstall'
  >;
  vi.stubGlobal('sprintCoder', { updates, windowControls: { platform: 'darwin' } });
  const container = document.createElement('div');
  const root = createRoot(container);
  const button = () => container.querySelector<HTMLButtonElement>('.titlebar-update-button');

  try {
    await act(async () => root.render(<AppTitlebar />));
    expect(button()).toBeNull();

    await act(async () => publish('busy'));
    await act(async () => resolveSnapshot('unavailable'));
    expect(button()?.textContent).toBe('再起動して更新');
    expect(button()?.getAttribute('aria-disabled')).toBe('true');
    expect(button()?.title).toBe('作業が終わると更新できます。');
    await act(async () => button()?.click());
    expect(restartToInstall).not.toHaveBeenCalled();

    await act(async () => publish('ready'));
    expect(button()?.getAttribute('aria-disabled')).toBe('false');
    await act(async () => button()?.click());
    expect(restartToInstall).toHaveBeenCalledOnce();

    await act(async () => publish('restarting'));
    expect(button()?.getAttribute('aria-disabled')).toBe('true');
    expect(button()?.textContent).toBe('更新を開始中…');
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
  expect(unsubscribe).toHaveBeenCalledOnce();
});

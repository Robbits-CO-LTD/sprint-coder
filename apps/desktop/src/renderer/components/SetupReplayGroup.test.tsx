// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SETUP_REPLAY_EVENT, setSetupShowing } from '../lib/setup-preference';
import { SetupReplayGroup } from './SetupReplayGroup';

afterEach(() => vi.unstubAllGlobals());

it('asks the app to run the Setup again', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const heard = vi.fn();
  window.addEventListener(SETUP_REPLAY_EVENT, heard);
  try {
    await act(async () => root.render(<SetupReplayGroup />));
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-setup-replay-button"]',
    );
    expect(button?.textContent).toContain('セットアップをもう一度');
    await act(async () => button?.click());
    expect(heard).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener(SETUP_REPLAY_EVENT, heard);
    await act(async () => root.unmount());
    container.remove();
  }
});

it('is not offered while a Setup is on screen', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  setSetupShowing(true);
  try {
    await act(async () => root.render(<SetupReplayGroup />));
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-setup-replay-button"]',
    );
    expect(button?.disabled).toBe(true);
    expect(container.textContent).toContain('セットアップの途中です');
    await act(async () => setSetupShowing(false));
    expect(button?.disabled).toBe(false);
  } finally {
    setSetupShowing(false);
    await act(async () => root.unmount());
    container.remove();
  }
});

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComputerUseSettings } from '@sprint-coder/contracts';
import { COMPUTER_USE_SETTING_CHANGED_EVENT } from '../lib/computer-use-setting-event';
import { ComputerUseSetting } from './SettingsDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const off: ComputerUseSettings = {
  enabled: false,
  forcedByEnvironment: false,
  effective: false,
  restartRequired: false,
  buildSupported: null,
};

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  delete (window as { sprintCoder?: unknown }).sprintCoder;
});

async function mount(
  getComputerUse: () => Promise<ComputerUseSettings>,
  setComputerUse: (input: { enabled: boolean }) => Promise<ComputerUseSettings> = async () => off,
): Promise<HTMLElement> {
  window.sprintCoder = {
    settings: { getComputerUse, setComputerUse },
  } as unknown as NonNullable<Window['sprintCoder']>;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<ComputerUseSetting active />));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return host;
}

const checkbox = (el: HTMLElement) =>
  el.querySelector<HTMLInputElement>('[data-testid="settings-computer-use"] input')!;
const state = (el: HTMLElement) =>
  el.querySelector('[data-testid="settings-computer-use-state"]')!.textContent;

describe('Computer Use (beta) setting', () => {
  it('labels the switch as beta, visibly and for assistive technology, and starts off', async () => {
    const el = await mount(async () => off);
    expect(el.querySelector('[data-testid="settings-computer-use-beta"]')?.textContent).toBe(
      'ベータ版',
    );
    expect(el.querySelector('legend')?.textContent).toContain('ベータ版');
    expect(el.querySelector('[data-testid="settings-computer-use"]')?.textContent).toContain(
      'Computer Use を使用する（ベータ版）',
    );
    expect(checkbox(el).checked).toBe(false);
    expect(checkbox(el).disabled).toBe(false);
    expect(state(el)).toBe('OFF');
    const hint = el.querySelector('#settings-computer-use-hint')!.textContent!;
    expect(hint).toContain('ベータ版の機能です');
    expect(hint).toContain('デスクトップ上のアプリ');
    expect(hint).toContain('既定はOFF');
    expect(hint).toContain('Windows / macOS');
    expect(checkbox(el).getAttribute('aria-describedby')).toBe('settings-computer-use-hint');
  });

  it('saves ON, says when a restart applies it, and announces the change', async () => {
    const setComputerUse = vi.fn(async ({ enabled }: { enabled: boolean }) => ({
      ...off,
      enabled,
      restartRequired: enabled,
    }));
    const changed = vi.fn();
    window.addEventListener(COMPUTER_USE_SETTING_CHANGED_EVENT, changed);
    try {
      const el = await mount(async () => off, setComputerUse);
      await act(async () => checkbox(el).click());
      expect(setComputerUse).toHaveBeenCalledWith({ enabled: true });
      expect(checkbox(el).checked).toBe(true);
      expect(state(el)).toBe('ON · 再起動後に有効になります');
      expect(el.querySelector('[role="status"]')?.textContent).toContain(
        '再起動後に有効になります',
      );
      expect(changed).toHaveBeenCalledTimes(1);

      await act(async () => checkbox(el).click());
      expect(setComputerUse).toHaveBeenLastCalledWith({ enabled: false });
      expect(state(el)).toBe('OFF');
      expect(changed).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener(COMPUTER_USE_SETTING_CHANGED_EVENT, changed);
    }
  });

  it('keeps the switch usable but says this build cannot run Computer Use', async () => {
    const el = await mount(async () => ({ ...off, buildSupported: false }));
    expect(checkbox(el).disabled).toBe(false);
    expect(state(el)).toBe('OFF · このビルドでは使用できません');
    expect(el.querySelector('[data-testid="settings-computer-use-build"]')?.textContent).toContain(
      'このビルドではComputer Useを使用できません',
    );
  });

  it('shows the env override as on and not switchable here', async () => {
    const el = await mount(async () => ({ ...off, forcedByEnvironment: true, effective: true }));
    expect(checkbox(el).checked).toBe(true);
    expect(checkbox(el).disabled).toBe(true);
    expect(state(el)).toBe('ON · 環境変数で有効になっています');
  });

  it('restores the last confirmed value when saving fails', async () => {
    const el = await mount(
      async () => off,
      async () => {
        throw new Error('nope');
      },
    );
    await act(async () => checkbox(el).click());
    expect(checkbox(el).checked).toBe(false);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('直前の値に戻しました');
  });
});

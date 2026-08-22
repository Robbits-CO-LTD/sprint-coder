// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SprintCoderApi, UpdateCheckResult } from '@sprint-coder/contracts';
import { useAppStore } from '../store/appStore';
import { UpdateHealthGroup, updateCheckResultText } from './SettingsDialog';

describe('manual update check', () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    useAppStore.setState({
      updateHealth: {
        successfulChecks: 2,
        failedChecks: 0,
        consecutiveFailures: 0,
        lastSuccessAt: '2026-08-20T00:00:00.000Z',
        lastFailureAt: null,
        lastErrorCategory: null,
      },
    });
  });

  afterEach(() => {
    useAppStore.setState({ updateHealth: null });
    vi.restoreAllMocks();
  });

  it('disables the button while checking and reports that the app is current', async () => {
    let resolveCheck!: (result: UpdateCheckResult) => void;
    const pending = new Promise<UpdateCheckResult>((resolve) => {
      resolveCheck = resolve;
    });
    const checkNow = vi.fn(() => pending);
    Object.defineProperty(window, 'sprintCoder', {
      configurable: true,
      value: { updates: { checkNow } } as unknown as SprintCoderApi,
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<UpdateHealthGroup />));

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-check-update"]',
    );
    expect(button?.textContent).toBe('アップデートを確認');
    await act(async () => button?.click());
    expect(checkNow).toHaveBeenCalledOnce();
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toBe('確認中…');

    await act(async () => {
      resolveCheck({ status: 'up_to_date' });
      await pending;
    });
    expect(button?.disabled).toBe(false);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      '最新版を使用しています。',
    );
    await act(async () => root.unmount());
  });

  it('uses clear, non-sensitive copy for every result', () => {
    expect(updateCheckResultText({ status: 'update_available', version: 'v0.4.1' })).toBe(
      'v0.4.1 が見つかりました。バックグラウンドでダウンロードしています。',
    );
    expect(updateCheckResultText({ status: 'already_checking' })).toContain('確認中');
    expect(updateCheckResultText({ status: 'unsupported' })).toContain('インストール版');
    expect(updateCheckResultText({ status: 'failed', errorCategory: 'network' })).toBe(
      'アップデートを確認できませんでした（ネットワーク）。',
    );
  });
});

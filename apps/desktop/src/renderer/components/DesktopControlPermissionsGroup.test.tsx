// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopControlPermissions } from '@sprint-coder/contracts';
import { DesktopControlPermissionsGroup } from './DesktopControlPermissionsGroup';

let container: HTMLDivElement;
let root: Root;

function install(
  getPermissions: () => Promise<DesktopControlPermissions>,
  platform = 'darwin',
): { getPermissions: ReturnType<typeof vi.fn>; openPermissionSettings: ReturnType<typeof vi.fn> } {
  const api = { getPermissions: vi.fn(getPermissions), openPermissionSettings: vi.fn() };
  Object.defineProperty(window, 'sprintCoder', {
    configurable: true,
    value: { windowControls: { platform }, desktopControl: api },
  });
  return api;
}

async function render(active = true): Promise<void> {
  await act(async () => root.render(<DesktopControlPermissionsGroup active={active} />));
}

function group(): HTMLElement | null {
  return container.querySelector('[data-testid="settings-desktop-control-permissions"]');
}

function rowText(pane: string): string {
  return (
    container.querySelector(`[data-testid="settings-desktop-control-permission-${pane}"]`)
      ?.textContent ?? ''
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(window, 'sprintCoder');
  vi.unstubAllGlobals();
});

describe('DesktopControlPermissionsGroup', () => {
  it('draws nothing when the permissions do not apply to this build', async () => {
    install(async () => ({
      applicable: false,
      accessibility: 'unknown',
      screenRecording: 'unknown',
    }));
    await render();
    expect(group()).toBeNull();
  });

  it('draws nothing and reads nothing off macOS', async () => {
    const api = install(async () => {
      throw new Error('not reached');
    }, 'win32');
    await render();
    expect(group()).toBeNull();
    expect(api.getPermissions).not.toHaveBeenCalled();
  });

  it('shows each state in words', async () => {
    install(async () => ({
      applicable: true,
      accessibility: 'granted',
      screenRecording: 'denied',
    }));
    await render();
    expect(group()?.textContent).toContain('デスクトップ操作の権限');
    expect(rowText('accessibility')).toContain('アクセシビリティ');
    expect(rowText('accessibility')).toContain('許可済み');
    expect(rowText('screen-recording')).toContain('画面収録');
    expect(rowText('screen-recording')).toContain('未許可');
  });

  it('shows an unknown state as 確認できません', async () => {
    install(async () => ({
      applicable: true,
      accessibility: 'unknown',
      screenRecording: 'unknown',
    }));
    await render();
    expect(rowText('accessibility')).toContain('確認できません');
    expect(rowText('screen-recording')).toContain('確認できません');
  });

  it('shows the loading state until the first read answers', async () => {
    let answer!: (value: DesktopControlPermissions) => void;
    install(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await render();
    expect(group()?.querySelector('[role="status"]')?.textContent).toContain('読み込んでいます');
    await act(async () =>
      answer({ applicable: true, accessibility: 'granted', screenRecording: 'granted' }),
    );
    expect(group()?.querySelector('[role="status"]')).toBeNull();
    expect(rowText('accessibility')).toContain('許可済み');
  });

  it('opens the pane of the row whose button was pressed', async () => {
    const api = install(async () => ({
      applicable: true,
      accessibility: 'denied',
      screenRecording: 'denied',
    }));
    await render();
    const accessibility = container.querySelector<HTMLButtonElement>(
      'button[aria-label="アクセシビリティのシステム設定を開く"]',
    );
    const screen = container.querySelector<HTMLButtonElement>(
      'button[aria-label="画面収録のシステム設定を開く"]',
    );
    expect(accessibility?.textContent).toBe('システム設定を開く');
    await act(async () => accessibility!.click());
    expect(api.openPermissionSettings).toHaveBeenLastCalledWith('accessibility');
    await act(async () => screen!.click());
    expect(api.openPermissionSettings).toHaveBeenLastCalledWith('screen-recording');
  });

  it('reads again on 再確認 and when the window gets focus back', async () => {
    const answers: DesktopControlPermissions[] = [
      { applicable: true, accessibility: 'denied', screenRecording: 'denied' },
      { applicable: true, accessibility: 'granted', screenRecording: 'denied' },
      { applicable: true, accessibility: 'granted', screenRecording: 'granted' },
    ];
    const api = install(async () => answers.shift()!);
    await render();
    expect(rowText('accessibility')).toContain('未許可');

    const recheck = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-desktop-control-permissions-recheck"]',
    )!;
    await act(async () => recheck.click());
    expect(api.getPermissions).toHaveBeenCalledTimes(2);
    expect(rowText('accessibility')).toContain('許可済み');
    expect(rowText('screen-recording')).toContain('未許可');

    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(api.getPermissions).toHaveBeenCalledTimes(3);
    expect(rowText('screen-recording')).toContain('許可済み');
  });

  it('stops reading on focus once the page is no longer shown', async () => {
    const api = install(async () => ({
      applicable: true,
      accessibility: 'granted',
      screenRecording: 'granted',
    }));
    await render(true);
    expect(api.getPermissions).toHaveBeenCalledTimes(1);
    await render(false);
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(api.getPermissions).toHaveBeenCalledTimes(1);
  });

  it('shows an alert when the read fails, and recovers on 再確認', async () => {
    const api = install(async () => {
      throw new Error('bridge down');
    });
    await render();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('読み取れませんでした');

    api.getPermissions.mockImplementation(async () => ({
      applicable: true,
      accessibility: 'granted',
      screenRecording: 'granted',
    }));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="settings-desktop-control-permissions-recheck"]',
        )!
        .click(),
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(rowText('accessibility')).toContain('許可済み');
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  COMPUTER_USE_PERMISSION_SETTINGS_MIN_INTERVAL_MS,
  computerUsePermissionSettingsUrls,
  createComputerUsePermissionSettingsOpener,
} from './computer-use-permission-settings';

describe('Computer Use OS permission settings opener', () => {
  it('knows one fixed macOS URL list per permission and nothing else', () => {
    expect(computerUsePermissionSettingsUrls('darwin', 'accessibility')).toEqual([
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility',
    ]);
    expect(computerUsePermissionSettingsUrls('darwin', 'screen_recording')).toEqual([
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture',
    ]);
    // Windows has no equivalent per-app grant for these capabilities, so nothing is opened there.
    expect(computerUsePermissionSettingsUrls('win32', 'accessibility')).toEqual([]);
    expect(computerUsePermissionSettingsUrls('linux', 'screen_recording')).toEqual([]);
  });

  it('opens only the constant URL that belongs to the requested permission', async () => {
    const openExternal = vi.fn(async () => undefined);
    const opener = createComputerUsePermissionSettingsOpener({
      platform: 'darwin',
      openExternal,
      now: () => 0,
    });

    await expect(opener.open('screen_recording')).resolves.toEqual({
      opened: true,
      rateLimited: false,
    });
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
  });

  it('falls back to the modern System Settings spelling when the legacy URL is refused', async () => {
    const openExternal = vi.fn(async (url: string) => {
      if (url.includes('com.apple.preference.security')) throw new Error('unsupported');
    });
    const opener = createComputerUsePermissionSettingsOpener({
      platform: 'darwin',
      openExternal,
      now: () => 0,
    });

    await expect(opener.open('accessibility')).resolves.toEqual({
      opened: true,
      rateLimited: false,
    });
    expect(openExternal.mock.calls.map(([url]) => url)).toEqual([
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility',
    ]);
  });

  it('reports a closed result instead of throwing when the OS refuses every URL', async () => {
    const openExternal = vi.fn(async () => {
      throw new Error('unsupported');
    });
    const opener = createComputerUsePermissionSettingsOpener({
      platform: 'darwin',
      openExternal,
      now: () => 0,
    });

    await expect(opener.open('accessibility')).resolves.toEqual({
      opened: false,
      rateLimited: false,
    });
    expect(openExternal).toHaveBeenCalledTimes(2);
  });

  it('opens nothing on a platform without these OS permissions', async () => {
    const openExternal = vi.fn(async () => undefined);
    const opener = createComputerUsePermissionSettingsOpener({
      platform: 'win32',
      openExternal,
      now: () => 0,
    });

    await expect(opener.open('accessibility')).resolves.toEqual({
      opened: false,
      rateLimited: false,
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('rate limits the same permission, and says so, so a held button cannot reopen the pane', async () => {
    const openExternal = vi.fn(async () => undefined);
    let now = 1_000;
    const opener = createComputerUsePermissionSettingsOpener({
      platform: 'darwin',
      openExternal,
      now: () => now,
    });

    await expect(opener.open('accessibility')).resolves.toEqual({
      opened: true,
      rateLimited: false,
    });
    now += COMPUTER_USE_PERMISSION_SETTINGS_MIN_INTERVAL_MS - 1;
    // Suppressed, and reported as suppressed: the renderer must not call this a failure.
    await expect(opener.open('accessibility')).resolves.toEqual({
      opened: false,
      rateLimited: true,
    });
    expect(openExternal).toHaveBeenCalledTimes(1);

    now += 1;
    await expect(opener.open('accessibility')).resolves.toEqual({
      opened: true,
      rateLimited: false,
    });
    expect(openExternal).toHaveBeenCalledTimes(2);
  });

  it('keeps the budget per permission so both missing grants can be opened back to back', async () => {
    const openExternal = vi.fn(async (_url: string) => undefined);
    const opener = createComputerUsePermissionSettingsOpener({
      platform: 'darwin',
      openExternal,
      // Both clicks land inside one rate-limit window, as two real button presses would.
      now: () => 1_000,
    });

    await expect(opener.open('accessibility')).resolves.toEqual({
      opened: true,
      rateLimited: false,
    });
    await expect(opener.open('screen_recording')).resolves.toEqual({
      opened: true,
      rateLimited: false,
    });
    expect(openExternal.mock.calls.map(([url]) => url)).toEqual([
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    ]);
  });

  it('rate limits a second request that arrives while the first is still opening', async () => {
    let release!: () => void;
    const opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    const openExternal = vi.fn(async () => await opened);
    const opener = createComputerUsePermissionSettingsOpener({
      platform: 'darwin',
      openExternal,
      now: () => 0,
    });

    const first = opener.open('accessibility');
    const second = opener.open('accessibility');
    release();

    expect(await Promise.all([first, second])).toEqual([
      { opened: true, rateLimited: false },
      { opened: false, rateLimited: true },
    ]);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('does not rate limit the next attempt after a request that opened nothing', async () => {
    let failing = true;
    const openExternal = vi.fn(async () => {
      if (failing) throw new Error('unsupported');
    });
    const opener = createComputerUsePermissionSettingsOpener({
      platform: 'darwin',
      openExternal,
      now: () => 5_000,
    });

    await expect(opener.open('accessibility')).resolves.toEqual({
      opened: false,
      rateLimited: false,
    });
    failing = false;
    await expect(opener.open('accessibility')).resolves.toEqual({
      opened: true,
      rateLimited: false,
    });
  });
});

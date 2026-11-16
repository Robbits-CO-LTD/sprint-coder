import { describe, expect, it, vi } from 'vitest';
import {
  desktopControlPermissionSettingsUrl,
  readDesktopControlPermissions,
  type DesktopControlPermissionReader,
} from './desktop-control-permissions';

function reader(
  trusted: () => unknown,
  screen: () => unknown,
): DesktopControlPermissionReader & {
  isTrustedAccessibilityClient: ReturnType<typeof vi.fn>;
  getMediaAccessStatus: ReturnType<typeof vi.fn>;
} {
  return {
    isTrustedAccessibilityClient: vi.fn(trusted),
    getMediaAccessStatus: vi.fn(screen),
  } as never;
}

describe('readDesktopControlPermissions', () => {
  it('reports both grants on Apple silicon macOS', () => {
    const prefs = reader(
      () => true,
      () => 'granted',
    );
    expect(readDesktopControlPermissions('darwin', 'arm64', prefs)).toEqual({
      applicable: true,
      accessibility: 'granted',
      screenRecording: 'granted',
    });
    expect(prefs.getMediaAccessStatus).toHaveBeenCalledWith('screen');
  });

  it('never asks macOS to prompt for Accessibility', () => {
    const prefs = reader(
      () => false,
      () => 'granted',
    );
    readDesktopControlPermissions('darwin', 'arm64', prefs);
    expect(prefs.isTrustedAccessibilityClient).toHaveBeenCalledTimes(1);
    expect(prefs.isTrustedAccessibilityClient).toHaveBeenCalledWith(false);
  });

  it.each(['denied', 'restricted', 'not-determined'])(
    'treats screen status %s as not granted',
    (status) => {
      const result = readDesktopControlPermissions(
        'darwin',
        'arm64',
        reader(
          () => false,
          () => status,
        ),
      );
      expect(result).toEqual({
        applicable: true,
        accessibility: 'denied',
        screenRecording: 'denied',
      });
    },
  );

  it.each(['unknown', undefined, 'something-else'])(
    'treats screen status %s as unknown',
    (status) => {
      const result = readDesktopControlPermissions(
        'darwin',
        'arm64',
        reader(
          () => true,
          () => status,
        ),
      );
      expect(result.screenRecording).toBe('unknown');
    },
  );

  it('reports unknown when a read throws', () => {
    const result = readDesktopControlPermissions(
      'darwin',
      'arm64',
      reader(
        () => {
          throw new Error('boom');
        },
        () => {
          throw new Error('boom');
        },
      ),
    );
    expect(result).toEqual({
      applicable: true,
      accessibility: 'unknown',
      screenRecording: 'unknown',
    });
  });

  it('reports an Accessibility answer that is not a boolean as unknown', () => {
    const result = readDesktopControlPermissions(
      'darwin',
      'arm64',
      reader(
        () => undefined,
        () => 'granted',
      ),
    );
    expect(result.accessibility).toBe('unknown');
  });

  it.each([
    ['win32', 'x64'],
    ['darwin', 'x64'],
    ['linux', 'x64'],
  ])('is not applicable on %s %s and reads nothing', (platform, arch) => {
    const prefs = reader(
      () => true,
      () => 'granted',
    );
    expect(readDesktopControlPermissions(platform, arch, prefs)).toEqual({
      applicable: false,
      accessibility: 'unknown',
      screenRecording: 'unknown',
    });
    expect(prefs.isTrustedAccessibilityClient).not.toHaveBeenCalled();
    expect(prefs.getMediaAccessStatus).not.toHaveBeenCalled();
  });
});

describe('desktopControlPermissionSettingsUrl', () => {
  it('maps each pane to its System Settings URL on macOS', () => {
    expect(desktopControlPermissionSettingsUrl('darwin', 'accessibility')).toBe(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    );
    expect(desktopControlPermissionSettingsUrl('darwin', 'screen-recording')).toBe(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
  });

  it('refuses every platform other than macOS', () => {
    expect(desktopControlPermissionSettingsUrl('win32', 'accessibility')).toBeNull();
    expect(desktopControlPermissionSettingsUrl('linux', 'screen-recording')).toBeNull();
  });

  it.each([
    'camera',
    '',
    undefined,
    null,
    42,
    { pane: 'accessibility' },
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    'https://example.com',
  ])('refuses the pane %j', (pane) => {
    expect(desktopControlPermissionSettingsUrl('darwin', pane)).toBeNull();
  });
});

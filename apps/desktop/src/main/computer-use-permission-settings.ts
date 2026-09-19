import type { ComputerUseOsPermission } from '@sprint-coder/contracts';

/**
 * Every settings URL Computer Use is ever allowed to open, as compiled-in constants.  Nothing
 * outside this table can be opened through this seam: the only input the renderer (and therefore
 * the only input a model or an on-screen instruction) can supply is the permission name, so no
 * caller can turn "open the settings pane" into "open this URL".
 *
 * macOS accepts both spellings of the privacy pane. The legacy `com.apple.preference.security`
 * alias is still the most broadly supported, and the `com.apple.settings.PrivacySecurity.extension`
 * spelling is what current System Settings uses, so each permission lists them in that order and
 * the opener falls through to the next one only when the OS refuses the previous URL outright.
 */
const MACOS_PERMISSION_SETTINGS_URLS: Readonly<Record<ComputerUseOsPermission, readonly string[]>> =
  Object.freeze({
    accessibility: Object.freeze([
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility',
    ]),
    screen_recording: Object.freeze([
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture',
    ]),
  });

/**
 * Minimum spacing between two settings openings. A held or repeatedly clicked button must not be
 * able to keep re-launching System Settings.
 */
export const COMPUTER_USE_PERMISSION_SETTINGS_MIN_INTERVAL_MS = 1_500;

/**
 * Windows has no per-app grant matching macOS accessibility/screen recording, so nothing is opened
 * there; the renderer shows platform guidance instead of a settings action.
 */
export function computerUsePermissionSettingsUrls(
  platform: NodeJS.Platform,
  permission: ComputerUseOsPermission,
): readonly string[] {
  return platform === 'darwin' ? MACOS_PERMISSION_SETTINGS_URLS[permission] : [];
}

export type ComputerUsePermissionSettingsOpener = Readonly<{
  open(permission: ComputerUseOsPermission): Promise<Readonly<{ opened: boolean }>>;
}>;

export function createComputerUsePermissionSettingsOpener(
  options: Readonly<{
    openExternal: (url: string) => Promise<void>;
    platform?: NodeJS.Platform;
    now?: () => number;
  }>,
): ComputerUsePermissionSettingsOpener {
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  let lastOpenedAtMs: number | null = null;

  return Object.freeze({
    open: async (permission: ComputerUseOsPermission) => {
      const at = now();
      if (
        lastOpenedAtMs !== null &&
        at - lastOpenedAtMs < COMPUTER_USE_PERMISSION_SETTINGS_MIN_INTERVAL_MS
      )
        return Object.freeze({ opened: false });
      // Claim the window before awaiting the OS: two clicks that arrive while the first
      // `openExternal` is still in flight would otherwise both pass the check above.
      const previousOpenedAtMs = lastOpenedAtMs;
      lastOpenedAtMs = at;
      for (const url of computerUsePermissionSettingsUrls(platform, permission)) {
        try {
          await options.openExternal(url);
          return Object.freeze({ opened: true });
        } catch {
          // This spelling is not registered on this OS version; try the next constant.
        }
      }
      // Nothing opened, so the user's next attempt must not be rate limited by this one.
      lastOpenedAtMs = previousOpenedAtMs;
      return Object.freeze({ opened: false });
    },
  });
}

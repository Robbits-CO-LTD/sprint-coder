import {
  desktopControlPermissionPaneSchema,
  type DesktopControlPermissionPane,
  type DesktopControlPermissionState,
  type DesktopControlPermissions,
} from '@sprint-coder/contracts';
import { desktopControlSupported } from './desktop-control-build';

/** The two `systemPreferences` reads used here, so tests can stand in for Electron's. */
export type DesktopControlPermissionReader = Pick<
  Electron.SystemPreferences,
  'isTrustedAccessibilityClient' | 'getMediaAccessStatus'
>;

export const DESKTOP_CONTROL_PERMISSIONS_NOT_APPLICABLE: DesktopControlPermissions = {
  applicable: false,
  accessibility: 'unknown',
  screenRecording: 'unknown',
};

/** The System Settings panes, held by Main so the renderer never hands it a URL to open. */
export const DESKTOP_CONTROL_PERMISSION_SETTINGS_URLS: Readonly<
  Record<DesktopControlPermissionPane, string>
> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  'screen-recording':
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
};

/**
 * Reads whether macOS lets this process use Accessibility and Screen Recording. Neither read asks
 * the user: `isTrustedAccessibilityClient` is always called with `false` (with `true` macOS shows
 * its own prompt), and `getMediaAccessStatus` only reports the current state.
 */
export function readDesktopControlPermissions(
  platform: string,
  arch: string,
  reader: DesktopControlPermissionReader,
): DesktopControlPermissions {
  if (platform !== 'darwin' || !desktopControlSupported(platform, arch))
    return { ...DESKTOP_CONTROL_PERMISSIONS_NOT_APPLICABLE };
  return {
    applicable: true,
    accessibility: readAccessibility(reader),
    screenRecording: readScreenRecording(reader),
  };
}

function readAccessibility(reader: DesktopControlPermissionReader): DesktopControlPermissionState {
  try {
    const trusted: unknown = reader.isTrustedAccessibilityClient(false);
    if (trusted === true) return 'granted';
    if (trusted === false) return 'denied';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function readScreenRecording(
  reader: DesktopControlPermissionReader,
): DesktopControlPermissionState {
  try {
    const status: unknown = reader.getMediaAccessStatus('screen');
    if (status === 'granted') return 'granted';
    if (status === 'denied' || status === 'restricted' || status === 'not-determined')
      return 'denied';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The System Settings URL for a pane the renderer named, or null when it must not be opened: off
 * macOS, or for anything that is not one of the known panes.
 */
export function desktopControlPermissionSettingsUrl(
  platform: string,
  pane: unknown,
): string | null {
  if (platform !== 'darwin') return null;
  const parsed = desktopControlPermissionPaneSchema.safeParse(pane);
  return parsed.success ? DESKTOP_CONTROL_PERMISSION_SETTINGS_URLS[parsed.data] : null;
}

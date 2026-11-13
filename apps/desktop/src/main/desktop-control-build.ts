/**
 * The desktop-control executable Sprint Coder ships is built from the source kept in this
 * repository (`apps/desktop/desktop-control`, see its VENDORED.md; built by
 * `build-desktop-control.mjs`). Like the sandbox runner, the build writes the SHA-256 of the
 * executable it produced to a `.sha256` manifest beside it, and the package ships that manifest
 * with the executable, re-sealed after signing. Only a file whose bytes match its manifest is
 * ever treated as the desktop-control executable.
 *
 * Windows x64 only for now: macOS and Linux have not been verified on a real desktop (the macOS
 * execution image rules and the Linux display environment and process-group Stop do not fit yet),
 * so nothing is built there and desktop control stays off.
 *
 * Kept free of imports so forge.config.ts can use the same facts at package time.
 */

/** The version of the source the executable is built from. */
export const DESKTOP_CONTROL_VERSION = '1.2.0';

/** The executable's name, in the build output and in the packaged app's resources alike. */
export const DESKTOP_CONTROL_EXECUTABLE = 'sprint-coder-desktop-control.exe';

/** Whether desktop control is built and shipped for this platform and architecture. */
export function desktopControlSupported(platform: string, arch: string): boolean {
  return platform === 'win32' && arch === 'x64';
}

/**
 * The environment variable that turns the Team's desktop cursors off: `0` stops them, so the
 * Leader cannot mark a Worker for desktop control and every desktop-control run is as it was
 * before the Team's cursors existed. Any other value, or none, leaves them on.
 */
export const DESKTOP_CONTROL_TEAM_CURSORS_VARIABLE = 'SPRINT_CODER_DESKTOP_TEAM_CURSORS';

/**
 * Whether a process started with this value of `DESKTOP_CONTROL_TEAM_CURSORS_VARIABLE` has the
 * Team's desktop cursors on: on by default, off with `0`, and never where desktop control is not
 * built (so the Leader there is not offered Workers that could run nothing). Main and the Runtime
 * Host (which inherits Main's environment) both read it here, so they never disagree.
 */
export function desktopControlTeamCursorsEnabled(
  value: string | undefined,
  platform: string,
  arch: string,
): boolean {
  return value !== '0' && desktopControlSupported(platform, arch);
}

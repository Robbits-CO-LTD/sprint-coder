/**
 * The desktop-control build Sprint Coder ships (a third-party binary; its source and license are
 * in docs/licenses), pinned by the SHA-256 of the one native binary per platform and
 * architecture. The package (an exact dependency in apps/desktop/package.json, installed without
 * its install script) carries every native binary; only the pinned one is copied into the app,
 * and only a file with exactly these bytes is ever treated as the desktop-control binary.
 *
 * `file` is the binary's name inside the npm package; `shipped` is its name in the packaged app's
 * resources (the same bytes, renamed when copied).
 *
 * Windows only for now: macOS and Linux have not been verified on a real desktop (the macOS
 * execution image rules and the Linux display environment and process-group Stop do not fit yet),
 * so they have no entry and desktop control stays off there.
 *
 * Kept free of imports so forge.config.ts can check the same table at package time.
 */
export const DESKTOP_CONTROL_VERSION = '1.2.0';

export type DesktopControlPin = Readonly<{ file: string; shipped: string; sha256: string }>;

export const DESKTOP_CONTROL_PINS: Readonly<Record<string, DesktopControlPin>> = Object.freeze({
  'win32-x64': Object.freeze({
    file: 'agent-desktop-win32-x64.exe',
    shipped: 'sprint-coder-desktop-control.exe',
    sha256: 'd274667031322e50b9c2b1ab81c2ca46835d52cc932769a5c34bd4d481fd94c3',
  }),
});

export function desktopControlPin(platform: string, arch: string): DesktopControlPin | null {
  return Object.hasOwn(DESKTOP_CONTROL_PINS, `${platform}-${arch}`)
    ? DESKTOP_CONTROL_PINS[`${platform}-${arch}`]!
    : null;
}

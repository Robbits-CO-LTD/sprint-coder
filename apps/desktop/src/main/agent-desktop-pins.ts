/**
 * The agent-desktop build Sprint Coder ships (vercel-labs/agent-desktop, Apache-2.0), pinned by the
 * SHA-256 of the one native binary per platform and architecture. The package (an exact
 * dependency in apps/desktop/package.json, installed without its install script) carries every
 * native binary; only the pinned one is copied into the app, and only a file with exactly these
 * bytes is ever treated as agent-desktop.
 *
 * Windows only for now: macOS and Linux have not been verified on a real desktop (the macOS
 * execution image rules and the Linux display environment and process-group Stop do not fit yet),
 * so they have no entry and desktop control stays off there.
 *
 * Kept free of imports so forge.config.ts can check the same table at package time.
 */
export const AGENT_DESKTOP_VERSION = '1.2.0';

export const AGENT_DESKTOP_PINS: Readonly<
  Record<string, Readonly<{ file: string; sha256: string }>>
> = Object.freeze({
  'win32-x64': Object.freeze({
    file: 'agent-desktop-win32-x64.exe',
    sha256: 'd274667031322e50b9c2b1ab81c2ca46835d52cc932769a5c34bd4d481fd94c3',
  }),
});

export function agentDesktopPin(
  platform: string,
  arch: string,
): Readonly<{ file: string; sha256: string }> | null {
  return Object.hasOwn(AGENT_DESKTOP_PINS, `${platform}-${arch}`)
    ? AGENT_DESKTOP_PINS[`${platform}-${arch}`]!
    : null;
}

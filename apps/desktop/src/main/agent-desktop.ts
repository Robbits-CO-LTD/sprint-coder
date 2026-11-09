import { realpathSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/**
 * Desktop control goes through the external `agent-desktop` CLI (vercel-labs/agent-desktop,
 * Apache-2.0). Sprint Coder does not ship or wrap it: the agent runs it through its ordinary shell
 * tool, so the command approval and Stop that already cover every shell command cover it too.
 *
 * `SPRINT_CODER_AGENT_DESKTOP` names the executable explicitly (an absolute path); otherwise the
 * first `agent-desktop` on PATH is used. Nothing found means the guidance is left out entirely.
 * Either way the result is the native binary itself, never the npm shim or the Node launcher, so
 * it is the one file `runsOutsideCommandSandbox` can match exactly.
 */
export const AGENT_DESKTOP_PATH_ENV = 'SPRINT_CODER_AGENT_DESKTOP';

export type AgentDesktopLookup = Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  arch?: string;
  isFile?: (path: string) => boolean;
  realpath?: (path: string) => string;
}>;

const NATIVE_NAME = /^agent-desktop(?:-(?:win32|darwin|linux)-[a-z0-9]+)?(?:\.exe)?$/iu;

export function resolveAgentDesktopCommand(lookup: AgentDesktopLookup = {}): string | null {
  const env = lookup.env ?? process.env;
  const platform = lookup.platform ?? process.platform;
  const isFile = lookup.isFile ?? isRegularFile;
  const paths = platform === 'win32' ? win32 : posix;
  const explicit = env[AGENT_DESKTOP_PATH_ENV]?.trim();
  if (explicit !== undefined && explicit !== '')
    return paths.isAbsolute(explicit) && isFile(explicit) ? nativeBinary(explicit, lookup) : null;
  const pathValue = platform === 'win32' ? (env['Path'] ?? env['PATH']) : env['PATH'];
  if (pathValue === undefined || pathValue === '') return null;
  // npm's global install leaves `agent-desktop.cmd` on Windows; a release archive leaves the `.exe`.
  const names =
    platform === 'win32' ? ['agent-desktop.cmd', 'agent-desktop.exe'] : ['agent-desktop'];
  for (const entry of pathValue.split(paths.delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    if (directory === '' || !paths.isAbsolute(directory)) continue;
    for (const name of names) {
      const candidate = paths.join(directory, name);
      if (!isFile(candidate)) continue;
      const native = nativeBinary(candidate, lookup);
      if (native !== null) return native;
    }
  }
  return null;
}

/**
 * Whether one approved command may run outside the command sandbox: only the native agent-desktop
 * binary found above, matched by canonical path, and only when it does not live inside any root
 * of the Turn's Workspace (where the agent could have replaced it). Desktop control cannot work in
 * the sandbox, which hides other apps' windows and processes and `~/.agent-desktop`.
 */
export function runsOutsideCommandSandbox(
  executable: string,
  workspaceRoots: readonly string[],
  lookup: AgentDesktopLookup = {},
): boolean {
  const platform = lookup.platform ?? process.platform;
  const paths = platform === 'win32' ? win32 : posix;
  const canonical = lookup.realpath ?? canonicalPath;
  const native = resolveAgentDesktopCommand(lookup);
  if (native === null) return false;
  const key = (path: string): string => {
    const normalized = paths.normalize(canonical(path));
    return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
  };
  const target = key(native);
  if (key(executable) !== target) return false;
  return workspaceRoots.every((root) => {
    const inside = paths.relative(key(root), target);
    return (
      inside !== '' &&
      (inside === '..' || inside.startsWith(`..${paths.sep}`) || paths.isAbsolute(inside))
    );
  });
}

// The npm shim and the Node launcher only start the native binary next to the package's launcher.
function nativeBinary(found: string, lookup: AgentDesktopLookup): string | null {
  const platform = lookup.platform ?? process.platform;
  const arch = lookup.arch ?? process.arch;
  const isFile = lookup.isFile ?? isRegularFile;
  const paths = platform === 'win32' ? win32 : posix;
  let native = found;
  if (platform === 'win32' && paths.extname(found).toLowerCase() === '.cmd') {
    // `<prefix>\agent-desktop.cmd` (global) or `<project>\node_modules\.bin\agent-desktop.cmd`.
    const directory = paths.dirname(found);
    const binary = `agent-desktop-win32-${arch}.exe`;
    native =
      [
        paths.join(directory, 'node_modules', 'agent-desktop', 'bin', binary),
        paths.join(directory, '..', 'agent-desktop', 'bin', binary),
      ].find(isFile) ?? '';
    if (native === '') return null;
  } else if (platform !== 'win32') {
    const launcher = (lookup.realpath ?? canonicalPath)(found);
    const sibling = paths.join(paths.dirname(launcher), `agent-desktop-${platform}-${arch}`);
    native = isFile(sibling) ? sibling : launcher;
  }
  return NATIVE_NAME.test(paths.basename(native)) ? native : null;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

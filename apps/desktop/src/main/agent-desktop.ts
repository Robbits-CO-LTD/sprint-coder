import { statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/**
 * Desktop control goes through the external `agent-desktop` CLI (vercel-labs/agent-desktop,
 * Apache-2.0). Sprint Coder does not ship or wrap it: the agent runs it through its ordinary shell
 * tool, so the command approval and Stop that already cover every shell command cover it too.
 *
 * `SPRINT_CODER_AGENT_DESKTOP` names the executable explicitly (an absolute path); otherwise the
 * first `agent-desktop` on PATH is used. Nothing found means the guidance is left out entirely.
 */
export const AGENT_DESKTOP_PATH_ENV = 'SPRINT_CODER_AGENT_DESKTOP';

export type AgentDesktopLookup = Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  isFile?: (path: string) => boolean;
}>;

export function resolveAgentDesktopCommand(lookup: AgentDesktopLookup = {}): string | null {
  const env = lookup.env ?? process.env;
  const platform = lookup.platform ?? process.platform;
  const isFile = lookup.isFile ?? isRegularFile;
  const paths = platform === 'win32' ? win32 : posix;
  const explicit = env[AGENT_DESKTOP_PATH_ENV]?.trim();
  if (explicit !== undefined && explicit !== '')
    return paths.isAbsolute(explicit) && isFile(explicit) ? explicit : null;
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
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

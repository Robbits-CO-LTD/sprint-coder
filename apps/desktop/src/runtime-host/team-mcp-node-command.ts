import { lstatSync } from 'node:fs';
import { join, win32 } from 'node:path';

/**
 * The packaged Electron binary has the RunAsNode fuse disabled, so it cannot host the temporary
 * stdio MCP server through ELECTRON_RUN_AS_NODE. Claude Code and Codex CLI are resolved from PATH;
 * resolve Node through the same inherited PATH instead of weakening the production fuse.
 */
export function teamMcpNodeCommand(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  resourcesPath: string | undefined = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath,
): string {
  if (platform !== 'win32') return 'node';
  if (resourcesPath !== undefined) {
    const bundled = join(resourcesPath, 'node.exe');
    if (isRegularFile(bundled)) return bundled;
  }

  // A bare `node.exe` lets Windows search the current Workspace before PATH. Resolve only absolute
  // PATH directories so a Workspace-controlled executable can never host the Team MCP server.
  const pathValue = Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1];
  for (const rawEntry of pathValue?.split(';') ?? []) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/, '$1');
    if (!win32.isAbsolute(entry)) continue;
    const candidate = win32.resolve(entry, 'node.exe');
    if (isRegularFile(candidate)) return candidate;
  }
  throw new Error('A trusted Node.js executable is required to start Team MCP on Windows.');
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

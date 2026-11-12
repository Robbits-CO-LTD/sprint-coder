import { accessSync, constants, existsSync, lstatSync } from 'node:fs';
import { join, win32 } from 'node:path';

/**
 * The packaged Electron binary has the RunAsNode fuse disabled, so it cannot host the temporary
 * stdio MCP server through ELECTRON_RUN_AS_NODE. The macOS and Windows packages ship standalone
 * Node executables for that server.
 */
export function teamMcpNodeCommand(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  resourcesPath: string | undefined = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath,
): string {
  if (
    platform === 'darwin' &&
    resourcesPath !== undefined &&
    existsSync(join(resourcesPath, 'app.asar'))
  ) {
    const bundled = join(resourcesPath, 'node');
    if (!isRegularFile(bundled)) throw new Error('Bundled Node.js is missing on macOS.');
    accessSync(bundled, constants.X_OK);
    return bundled;
  }
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

/**
 * The packaged Electron binary has the RunAsNode fuse disabled, so it cannot host the temporary
 * stdio MCP server through ELECTRON_RUN_AS_NODE. Claude Code and Codex CLI are resolved from PATH;
 * resolve Node through the same inherited PATH instead of weakening the production fuse.
 */
export function teamMcpNodeCommand(platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return 'node';
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath !== undefined) {
    const bundled = join(resourcesPath, 'node.exe');
    if (existsSync(bundled)) return bundled;
  }
  return 'node.exe';
}
import { existsSync } from 'node:fs';
import { join } from 'node:path';

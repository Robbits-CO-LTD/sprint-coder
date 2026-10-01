import { join, dirname } from 'node:path';
import { sandboxRunnerPath } from './sandbox-runner';

export const SANDBOX_NODE_PIPE_GUARD_NAME = 'sandbox-node-pipe-guard.cjs';

export function sandboxNodePipeGuardPath(): string {
  return join(dirname(sandboxRunnerPath()), SANDBOX_NODE_PIPE_GUARD_NAME);
}

export function sandboxNodeOptions(preloadPath = sandboxNodePipeGuardPath()): string {
  if (/["\r\n\0]/u.test(preloadPath)) throw new Error('Invalid sandbox Node preload path');
  // NODE_OPTIONS has its own quote parser; forward slashes avoid backslash-escape ambiguity.
  return `--preserve-symlinks --preserve-symlinks-main --require "${preloadPath.replaceAll('\\', '/')}"`;
}

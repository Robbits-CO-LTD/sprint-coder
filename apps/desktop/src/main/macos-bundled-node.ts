import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

export const MAC_BUNDLED_NODE_SHA256 = {
  arm64: '68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b',
  x64: 'fdb8d4da9332c2c99c3b2ae4bad4672bfef225ecd603e656cd1378b3644583a2',
} as const;

const verifyCodeSignature = promisify(execFile);
const bundledNodeRequirement =
  'anchor apple generic and certificate leaf[subject.OU] = "7TDY87Y997" and identifier "node"';

export async function bundledMacNodePath(): Promise<string | null> {
  if (process.platform !== 'darwin' || !process.resourcesPath) return null;
  try {
    const node = join(await realpath(process.resourcesPath), 'node');
    return (await lstat(node)).isFile() ? node : null;
  } catch {
    return null;
  }
}

/** The only extra macOS Node image eligible for the ordinary command sandbox. */
export async function isBundledMacNode(
  executable: string,
  digest: string,
  workspaceRoots: readonly string[],
): Promise<boolean> {
  if (workspaceRoots.length === 0 || (await bundledMacNodePath()) !== executable) return false;
  try {
    const normalized = (path: string): string => path.normalize('NFD').toLowerCase();
    for (const root of workspaceRoots) {
      const child = relative(normalized(await realpath(root)), normalized(executable));
      if (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)) return false;
    }
    // Forge verifies the official binary before packaging. Signing the app replaces its
    // signature bytes, so released builds verify the bundled Node's release signature.
    if (
      (process.arch === 'arm64' || process.arch === 'x64') &&
      digest === MAC_BUNDLED_NODE_SHA256[process.arch]
    )
      return true;
    await verifyCodeSignature(
      '/usr/bin/codesign',
      ['--verify', '--strict', `-R=${bundledNodeRequirement}`, executable],
      { timeout: 5_000 },
    );
    return true;
  } catch {
    return false;
  }
}

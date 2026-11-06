import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { nativeSafeFsAddonPath } from './native-safe-fs';
import { workspaceMutationBinding, workspaceRootIdentityDigestFor } from './path-guard';

/** A durable witness refreshes registration after a remount. Runtime guards still use
 * dev/ino and never accept this witness as an execution capability. */
export async function projectFolderIdentity(path: string) {
  const binding = await workspaceMutationBinding(path);
  return {
    ...binding,
    persistentIdentityDigest: persistentProjectFolderIdentity(
      binding.canonicalPath,
      binding.rootIdentityDigest,
    ),
  };
}

export function persistentProjectFolderIdentity(
  path: string,
  expectedIdentity?: string,
): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    const identity = lstatSync(path, { bigint: true });
    if (!identity.isDirectory()) return null;
    if (
      expectedIdentity !== undefined &&
      workspaceRootIdentityDigestFor(String(identity.dev), String(identity.ino)) !==
        expectedIdentity
    )
      return null;
    const require = createRequire(join(__dirname, 'project-folder-identity-loader.cjs'));
    const addon: unknown = require(nativeSafeFsAddonPath());
    const query: unknown =
      typeof addon === 'object' && addon !== null
        ? Reflect.get(addon, 'directoryPersistentIdentity')
        : null;
    if (typeof query !== 'function') return null;
    const witness: unknown = query({ path, dev: String(identity.dev), ino: String(identity.ino) });
    if (typeof witness !== 'string' || !/^[a-f0-9]{32}:\d+:\d+:\d+$/u.test(witness)) return null;
    return createHash('sha256').update(`project-folder-apfs-v1:${witness}`).digest('hex');
  } catch {
    // Unsupported filesystems and old addons retain explicit relinking. A path or inode alone
    // cannot establish that a folder is the same one across mounts.
    return null;
  }
}

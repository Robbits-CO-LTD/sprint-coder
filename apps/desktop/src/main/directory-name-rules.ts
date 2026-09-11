import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { nativeSafeFsAddonPath, NativeSafeFsError } from './native-safe-fs';
import type { FileIdentity } from './path-guard';

/** Read filesystem name rules through the same opened directory whose identity was guarded.
 * No probe file is created and unknown/unsupported rules never become a platform assumption. */
export function directoryCaseSensitive(
  path: string,
  identity: Pick<FileIdentity, 'dev' | 'ino'>,
): boolean {
  if (
    !isAbsolute(path) ||
    path.includes('\0') ||
    Buffer.byteLength(path) > 32_768 ||
    !/^\d{1,20}$/u.test(identity.dev) ||
    !/^\d{1,20}$/u.test(identity.ino)
  )
    throw new NativeSafeFsError('INVALID_INPUT', 'Invalid directory identity');
  const require = createRequire(join(__dirname, 'directory-name-rules-loader.cjs'));
  const addon: unknown = require(nativeSafeFsAddonPath());
  if (
    typeof addon !== 'object' ||
    addon === null ||
    !('directoryCaseSensitive' in addon) ||
    typeof addon.directoryCaseSensitive !== 'function'
  )
    throw new NativeSafeFsError('ADDON_UNAVAILABLE', 'Directory name rules are unavailable');
  const result: unknown = addon.directoryCaseSensitive({
    path,
    dev: identity.dev,
    ino: identity.ino,
  });
  if (typeof result !== 'boolean')
    throw new NativeSafeFsError('NATIVE_FAILURE', 'Invalid directory name rules');
  return result;
}

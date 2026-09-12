import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { nativeSafeFsAddonPath, NativeSafeFsError } from './native-safe-fs';
import type { FileIdentity } from './path-guard';

/** Windows ordinal casing does not expand sharp-s or normalize composed Unicode names. */
export function windowsCaseInsensitiveNamesEqual(left: string, right: string): boolean {
  if (
    process.platform !== 'win32' ||
    [left, right].some((name) => !name || /[/\\\0]/u.test(name) || Buffer.byteLength(name) > 1_024)
  )
    throw new NativeSafeFsError('INVALID_INPUT', 'Invalid Windows endpoint names');
  const require = createRequire(join(__dirname, 'directory-name-rules-loader.cjs'));
  const addon: unknown = require(nativeSafeFsAddonPath());
  if (
    typeof addon !== 'object' ||
    addon === null ||
    !('caseInsensitiveNamesEqual' in addon) ||
    typeof addon.caseInsensitiveNamesEqual !== 'function'
  )
    throw new NativeSafeFsError('ADDON_UNAVAILABLE', 'Windows name comparison is unavailable');
  const result: unknown = addon.caseInsensitiveNamesEqual(left, right);
  if (typeof result !== 'boolean')
    throw new NativeSafeFsError('NATIVE_FAILURE', 'Invalid Windows name comparison');
  return result;
}

/** Read filesystem name rules through the same opened directory whose identity was guarded.
 * No probe file is created and unknown/unsupported rules never become a platform assumption. */
export function directoryCaseSensitive(
  path: string,
  identity: Pick<FileIdentity, 'dev' | 'ino'>,
): boolean {
  return directoryRule('directoryCaseSensitive', path, identity);
}

export function directoryCanonicalUnicode(
  path: string,
  identity: Pick<FileIdentity, 'dev' | 'ino'>,
): boolean {
  if (process.platform !== 'darwin')
    throw new NativeSafeFsError('INVALID_INPUT', 'Darwin directory required');
  return directoryRule('directoryCanonicalUnicode', path, identity);
}

function directoryRule(
  method: 'directoryCaseSensitive' | 'directoryCanonicalUnicode',
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
  const query: unknown =
    typeof addon === 'object' && addon !== null ? Reflect.get(addon, method) : null;
  if (typeof query !== 'function')
    throw new NativeSafeFsError('ADDON_UNAVAILABLE', 'Directory name rules are unavailable');
  const result: unknown = query({
    path,
    dev: identity.dev,
    ino: identity.ino,
  });
  if (typeof result !== 'boolean')
    throw new NativeSafeFsError('NATIVE_FAILURE', 'Invalid directory name rules');
  return result;
}

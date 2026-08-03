import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { nativeSafeFsAddonPath } from './native-safe-fs';

type PublicationAddon = Readonly<{
  replaceFileWithBackup?: (replacement: string, target: string, backup: string) => boolean;
  exchangeFiles?: (input: Readonly<{ first: string; second: string }>) => boolean;
  applyWindowsAcl?: (
    path: string,
    kind: 'directory' | 'file',
    operation: 'secure' | 'verify',
  ) => boolean;
}>;

let cachedAddon: PublicationAddon | null = null;

function publicationAddon(): PublicationAddon {
  if (cachedAddon !== null) return cachedAddon;
  const require = createRequire(__filename);
  cachedAddon = require(resolve(nativeSafeFsAddonPath())) as PublicationAddon;
  return cachedAddon;
}

export function applyWindowsAcl(
  path: string,
  kind: 'directory' | 'file',
  operation: 'secure' | 'verify',
): void {
  const apply = publicationAddon().applyWindowsAcl;
  if (process.platform !== 'win32' || typeof apply !== 'function')
    throw new Error('Native Windows ACL support is unavailable');
  if (apply(path, kind, operation) !== true)
    throw new Error(`Native Windows ACL ${operation} failed`);
}

export function replaceWindowsFileWithBackup(
  replacement: string,
  target: string,
  backup: string,
): void {
  const replace = publicationAddon().replaceFileWithBackup;
  if (process.platform !== 'win32' || typeof replace !== 'function')
    throw new Error('Native Windows file replacement is unavailable');
  if (replace(replacement, target, backup) !== true)
    throw new Error('Native Windows file replacement failed');
}

export function exchangePosixFiles(first: string, second: string): void {
  const exchange = publicationAddon().exchangeFiles;
  if (
    (process.platform !== 'linux' && process.platform !== 'darwin') ||
    typeof exchange !== 'function'
  )
    throw new Error('Native POSIX file exchange is unavailable');
  if (exchange({ first, second }) !== true) throw new Error('Native POSIX file exchange failed');
}

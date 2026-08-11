import { realpathSync } from 'node:fs';
import { normalize, resolve, win32 } from 'node:path';

export function pathComparisonKey(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = platform === 'win32' ? win32.normalize(path) : normalize(path);
  return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export function pathsEquivalent(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return pathComparisonKey(left, platform) === pathComparisonKey(right, platform);
}

export function canonicalizeExistingPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

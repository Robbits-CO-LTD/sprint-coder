import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DEFAULT_THEME,
  parseStoredTheme,
  serializeStoredTheme,
  type ThemeId,
} from '../window-theme';

// The profile's theme on disk: one small file beside the database, read before the window is made
// (the database's settings are behind the IPC router, which needs the window first).

/** The theme the profile keeps, or the default when there is no file or it cannot be read. */
export function readStoredTheme(path: string): ThemeId {
  try {
    return parseStoredTheme(readFileSync(path, 'utf8'));
  } catch {
    return DEFAULT_THEME;
  }
}

/** Replaces the file in one step, so a crash mid-write cannot leave half a file behind. */
export function writeStoredTheme(path: string, theme: ThemeId): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, serializeStoredTheme(theme), 'utf8');
  renameSync(temporary, path);
}

export function saveStoredTheme(
  path: string,
  theme: ThemeId,
  onError: (error: unknown) => void,
): { saved: boolean } {
  try {
    writeStoredTheme(path, theme);
    return { saved: true };
  } catch (error) {
    onError(error);
    return { saved: false };
  }
}

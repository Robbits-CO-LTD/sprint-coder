import { TURN_DIFF_DISPLAY_PATH_MAX_LENGTH } from '@sprint-coder/contracts';

const WORKSPACE_DISPLAY_SEPARATOR = ' › ';

/**
 * Escapes the display separator without hiding any user-supplied characters. Doubling the chevron
 * is injective and keeps the single-chevron separator unambiguous across root labels and paths.
 */
export function escapeWorkspaceDisplayComponent(value: string): string {
  return value.replaceAll('›', '››');
}

export function normalizeWorkspaceDisplayRelativePath(
  value: string,
  platform: NodeJS.Platform,
): string | null {
  const segments = value
    .split(platform === 'win32' ? /[\\/]+/u : /\/+/u)
    .filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.some((segment) => segment === '..')) return null;
  return segments.join('/');
}

export function formatWorkspaceDisplayPath(rootLabel: string, relativePath: string): string {
  const value = `${escapeWorkspaceDisplayComponent(rootLabel)}${WORKSPACE_DISPLAY_SEPARATOR}${escapeWorkspaceDisplayComponent(relativePath)}`;
  if (value.length > TURN_DIFF_DISPLAY_PATH_MAX_LENGTH)
    throw new Error('Workspace display path exceeds the contract limit');
  return value;
}

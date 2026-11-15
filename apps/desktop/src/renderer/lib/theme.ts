import { useSyncExternalStore } from 'react';
import { DEFAULT_THEME, THEME_ATTRIBUTE, themeOrDefault, type ThemeId } from '../../window-theme';

// The page's side of the theme. The theme on screen is the `data-theme` of <html>: the preload puts
// the profile's theme there before the first paint, and a change in Settings replaces it here, so
// the whole window recolours at once (every colour is a variable of that attribute's block). Main
// is told, keeps the choice for the next launch and recolours the window's own parts.

const listeners = new Set<() => void>();

/** The theme the window shows now. The default where there is no page (tests, SSR). */
export function activeTheme(): ThemeId {
  if (typeof document === 'undefined') return DEFAULT_THEME;
  return themeOrDefault(document.documentElement.getAttribute(THEME_ATTRIBUTE));
}

export function setTheme(theme: ThemeId): void {
  if (typeof document === 'undefined' || theme === activeTheme()) return;
  document.documentElement.setAttribute(THEME_ATTRIBUTE, theme);
  window.sprintCoder?.theme?.set(theme);
  for (const listener of listeners) listener();
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): ThemeId {
  return useSyncExternalStore(subscribeTheme, activeTheme, () => DEFAULT_THEME);
}

// The app's themes: the one list Main, the preload and the renderer all read.
//
// A theme is one set of colour variables in the renderer's CSS (`renderer/themes.css`; the first
// one is the `:root` set in `renderer/index.css`) plus one entry here. Adding a theme is those two
// things: nothing else names a theme.
//
// The chosen theme is kept by Main, in a small file of the profile, because Main needs it before
// the page exists: the window is made in the theme's colour, and the preload reads it once, before
// anything is drawn, so the page never shows another theme's colours first.

export const WINDOW_THEME_CHANNELS = {
  get: 'sprint-coder:window:theme:get',
  set: 'sprint-coder:window:theme:set',
} as const;

export type ThemeDefinition = Readonly<{
  id: string;
  /** The name in Settings. */
  label: string;
  /** Whether the theme is a dark or a light one: what the window's own parts follow (the macOS
   * traffic lights, native menus and tooltips). */
  scheme: 'dark' | 'light';
  /** The window's own background: the theme's `--bg-app` (a test holds the two together). It shows
   * before the first paint and at the edge of a window being resized. */
  windowBackground: `#${string}`;
}>;

export const THEMES = [
  { id: 'black', label: '黒', scheme: 'dark', windowBackground: '#131315' },
  { id: 'gray', label: '灰色', scheme: 'dark', windowBackground: '#2f2f33' },
  { id: 'white', label: '白', scheme: 'light', windowBackground: '#ffffff' },
] as const satisfies readonly ThemeDefinition[];

export type ThemeId = (typeof THEMES)[number]['id'];

/** The look the app has always had. Also what an unknown or unreadable choice falls back to. */
export const DEFAULT_THEME: ThemeId = 'black';

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

export function themeOrDefault(value: unknown): ThemeId {
  return isThemeId(value) ? value : DEFAULT_THEME;
}

export function themeDefinition(id: ThemeId): (typeof THEMES)[number] {
  return THEMES.find((theme) => theme.id === id)!;
}

/** The attribute on `<html>` (and on any element that shows another theme inside the page, such as
 * the Setup's stage or a preview in Settings) that selects a theme's variables. */
export const THEME_ATTRIBUTE = 'data-theme';

/**
 * Puts the theme on `<html>` as soon as that element exists, and in any case before the page is
 * first drawn. The preload runs before the document has an `<html>`; the observer's callback is a
 * microtask of the parser's task that inserts it, and nothing is painted between the two.
 */
export function applyThemeBeforeFirstPaint(theme: ThemeId, doc: Document): void {
  const apply = (): boolean => {
    const root = doc.documentElement as HTMLElement | null;
    if (root === null) return false;
    root.setAttribute(THEME_ATTRIBUTE, theme);
    return true;
  };
  if (apply()) return;
  const observer = new MutationObserver(() => {
    if (apply()) observer.disconnect();
  });
  observer.observe(doc, { childList: true });
}

/** What Main writes to, and reads from, the profile. */
export function serializeStoredTheme(theme: ThemeId): string {
  return `${JSON.stringify({ theme })}\n`;
}

/** The stored theme, or the default when the text is missing, damaged or names a theme this
 * version does not have (a profile last used by a newer version). */
export function parseStoredTheme(text: string | null): ThemeId {
  if (text === null) return DEFAULT_THEME;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || !('theme' in parsed)) return DEFAULT_THEME;
    return themeOrDefault(parsed.theme);
  } catch {
    return DEFAULT_THEME;
  }
}

/** The window (and the app) as far as a theme reaches outside the page. */
export type WindowThemeTarget = {
  setBackgroundColor(color: string): void;
};
export type NativeThemeTarget = { themeSource: 'system' | 'light' | 'dark' };

/** Makes the parts Main owns follow the theme: the window's background, and whether its native
 * parts are drawn light or dark. */
export function applyWindowTheme(
  theme: ThemeId,
  window: WindowThemeTarget | null,
  nativeTheme: NativeThemeTarget,
): void {
  const { scheme, windowBackground } = themeDefinition(theme);
  nativeTheme.themeSource = scheme;
  window?.setBackgroundColor(windowBackground);
}

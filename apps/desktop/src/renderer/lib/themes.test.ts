import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseHexColor,
  parseRootCustomProperties,
  parseThemeCustomProperties,
  relativeLuminance,
  themeBlockIds,
} from './contrast';
import { DEFAULT_THEME, THEMES } from '../../window-theme';

// A theme is one block of colour variables (the default's is the first block of index.css, every
// other one is a block of themes.css) and one entry in window-theme.ts. These hold the two
// together, so adding a theme cannot leave a variable out, and so no colour is written outside a
// theme where a theme could not reach it. What each theme's colours must achieve is in
// contrast.test.ts.

const rendererDir = join(__dirname, '..');
const indexCss = readFileSync(join(rendererDir, 'index.css'), 'utf8');
const sidebarCss = readFileSync(join(rendererDir, 'sidebar.css'), 'utf8');
const themesCss = readFileSync(join(rendererDir, 'themes.css'), 'utf8');
const defaultTokens = parseRootCustomProperties(indexCss);
const OTHER_THEMES = THEMES.filter(({ id }) => id !== DEFAULT_THEME);

function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('the themes and their colour variables', () => {
  it('lists the default theme first, under the name the first block of index.css carries', () => {
    expect(THEMES[0].id).toBe(DEFAULT_THEME);
    expect(withoutComments(indexCss)).toMatch(
      new RegExp(`:root,\\s*\\[data-theme='${DEFAULT_THEME}'\\]\\s*\\{`),
    );
  });

  it('gives every other theme exactly one block in themes.css, and no block to anything else', () => {
    expect(themeBlockIds(themesCss)).toEqual(OTHER_THEMES.map(({ id }) => id));
  });

  it.each(OTHER_THEMES)(
    '$id defines every colour variable of the default theme, and no other',
    ({ id }) => {
      const own = parseThemeCustomProperties(themesCss, id);
      expect(own).not.toBeNull();
      expect([...own!.keys()].sort()).toEqual([...defaultTokens.keys()].sort());
    },
  );

  it.each(THEMES)("$id: the window's own background is the theme's --bg-app", (theme) => {
    const tokens =
      theme.id === DEFAULT_THEME ? defaultTokens : parseThemeCustomProperties(themesCss, theme.id)!;
    expect(theme.windowBackground.toLowerCase()).toBe(tokens.get('bg-app')!.toLowerCase());
  });

  it.each(THEMES)('$id is listed as dark or light as its colours are', (theme) => {
    const tokens =
      theme.id === DEFAULT_THEME ? defaultTokens : parseThemeCustomProperties(themesCss, theme.id)!;
    const surface = relativeLuminance(parseHexColor(tokens.get('bg-app')!)!);
    const text = relativeLuminance(parseHexColor(tokens.get('text-primary')!)!);
    expect(surface < text ? 'dark' : 'light').toBe(theme.scheme);
  });

  it('works out the derived variables on every element that carries a theme', () => {
    // A variable that refers to another is settled where it is declared: declared on :root only, a
    // theme shown inside the page (a preview, the Setup's stage) would keep the outer theme's.
    const derived = /:root,\s*\[data-theme\]\s*\{([^}]*)\}/.exec(withoutComments(indexCss))?.[1];
    expect(derived).toBeDefined();
    for (const name of ['accent-wash', 'neutral-wash', 'relief', 'shadow-2', 'shadow-3'])
      expect(derived).toContain(`--${name}:`);
    expect(derived).toMatch(/(^|\s)color:\s*var\(--text-primary\)/);
  });
});

describe('colours written outside the themes', () => {
  // Everything the everyday screens draw comes from a theme's variables. What is left is listed
  // here with its reason; a new literal fails until it is either moved into the themes or added.
  const ALLOWED: Record<string, string> = {
    // The ink on a Worker's own colour, which is the same in every theme.
    '#131315': '--on-color-dark',
    '#fff': '--on-color-light / the close button on its red',
    // Windows' own close-button red, the same in every theme.
    '#c42b1c': '.window-control--close:hover',
    // The Setup's dark stage, which the veil continues for a moment (setup.css owns that colour).
    '#070b14': 'the veil as the Setup lets go of the window',
  };

  function literalsOutsideThemes(css: string): string[] {
    const plain = withoutComments(css)
      // the default theme's own block
      .replace(/:root,\s*\[data-theme='[a-z0-9-]+'\]\s*\{[^}]*\}/, '')
      // data: URLs (an SVG mask's own markup)
      .replace(/url\("data:[^"]*"\)/g, '');
    return [
      ...plain.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\((?!\s*var\(--[a-z-]+-rgb\))/g),
    ].map((m) => m[0].toLowerCase());
  }

  it('index.css has none but the listed ones', () => {
    const found = literalsOutsideThemes(indexCss);
    expect(found.filter((literal) => !(literal in ALLOWED))).toEqual([]);
    // …and each listed one is still there (a stale entry would hide a later literal of that value).
    expect([...new Set(found)].sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  it('sidebar.css has none', () => {
    expect(literalsOutsideThemes(sidebarCss)).toEqual([]);
  });

  it('themes.css holds only theme blocks', () => {
    const rest = withoutComments(themesCss).replace(/\[data-theme='[a-z0-9-]+'\]\s*\{[^}]*\}/g, '');
    expect(rest.trim()).toBe('');
  });
});

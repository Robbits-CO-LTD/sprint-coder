import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyThemeBeforeFirstPaint,
  applyWindowTheme,
  DEFAULT_THEME,
  isThemeId,
  parseStoredTheme,
  serializeStoredTheme,
  THEME_ATTRIBUTE,
  themeDefinition,
  themeOrDefault,
  THEMES,
} from './window-theme';

afterEach(() => vi.unstubAllGlobals());

describe('the list of themes', () => {
  it('offers 黒, 灰色 and 白, in that order, with 黒 the default', () => {
    expect(THEMES.map(({ id, label }) => [id, label])).toEqual([
      ['black', '黒'],
      ['gray', '灰色'],
      ['white', '白'],
    ]);
    expect(DEFAULT_THEME).toBe('black');
  });

  it('accepts only a listed theme', () => {
    expect(isThemeId('white')).toBe(true);
    for (const value of ['', 'White', 'system', 'blue', null, undefined, 1, {}, ['white']])
      expect(isThemeId(value)).toBe(false);
    expect(themeOrDefault('gray')).toBe('gray');
    expect(themeOrDefault('sepia')).toBe(DEFAULT_THEME);
  });
});

describe('the theme kept in the profile', () => {
  it('reads back what it wrote', () => {
    for (const { id } of THEMES) expect(parseStoredTheme(serializeStoredTheme(id))).toBe(id);
  });

  it('falls back to the default for a missing, damaged or unknown value', () => {
    for (const text of [
      null,
      '',
      'white',
      '{',
      '[]',
      'null',
      '{"theme":"sepia"}',
      '{"theme":1}',
      '{}',
    ])
      expect(parseStoredTheme(text)).toBe(DEFAULT_THEME);
  });
});

describe('the window following a theme', () => {
  it("takes the theme's background and its dark or light native parts", () => {
    const window = { setBackgroundColor: vi.fn() };
    const nativeTheme = { themeSource: 'system' as 'system' | 'light' | 'dark' };
    applyWindowTheme('white', window, nativeTheme);
    expect(window.setBackgroundColor).toHaveBeenCalledWith(
      themeDefinition('white').windowBackground,
    );
    expect(nativeTheme.themeSource).toBe('light');
    applyWindowTheme('gray', window, nativeTheme);
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith(
      themeDefinition('gray').windowBackground,
    );
    expect(nativeTheme.themeSource).toBe('dark');
  });

  it('sets the native parts before a window exists', () => {
    const nativeTheme = { themeSource: 'system' as 'system' | 'light' | 'dark' };
    expect(() => applyWindowTheme('black', null, nativeTheme)).not.toThrow();
    expect(nativeTheme.themeSource).toBe('dark');
  });
});

describe('the theme on the page before it is first drawn', () => {
  function element(): { setAttribute: ReturnType<typeof vi.fn> } {
    return { setAttribute: vi.fn() };
  }

  it('is put on <html> at once when that element already exists', () => {
    const root = element();
    applyThemeBeforeFirstPaint('white', { documentElement: root } as unknown as Document);
    expect(root.setAttribute).toHaveBeenCalledWith(THEME_ATTRIBUTE, 'white');
  });

  it('waits for <html> when the preload runs before the document has one, then stops watching', () => {
    let notify: () => void = () => {};
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal(
      'MutationObserver',
      class {
        constructor(callback: () => void) {
          notify = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    const doc: { documentElement: ReturnType<typeof element> | null } = { documentElement: null };
    applyThemeBeforeFirstPaint('gray', doc as unknown as Document);
    expect(observe).toHaveBeenCalledWith(doc, { childList: true });

    // Something else is added first (a doctype): still no <html>.
    notify();
    expect(disconnect).not.toHaveBeenCalled();

    const root = element();
    doc.documentElement = root;
    notify();
    expect(root.setAttribute).toHaveBeenCalledWith(THEME_ATTRIBUTE, 'gray');
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyPlatformClass,
  FONT_MONO,
  FONT_SANS,
  STARTUP_FONT_SPECS,
  STARTUP_FONT_WAIT_MS,
  waitForFonts,
} from './fonts';

// Issue #1253: the app's type is two bundled families, named through two tokens. These read the
// stylesheets as text (like contrast.test.ts) so a CDN link, a non-blocking face or a font named
// outside the tokens is caught before it reaches a screen.

const rendererDir = join(__dirname, '..');
const fontsCss = readFileSync(join(rendererDir, 'fonts.css'), 'utf8');
const indexCss = readFileSync(join(rendererDir, 'index.css'), 'utf8');
const faces = fontsCss.match(/@font-face\s*\{[^}]*\}/g) ?? [];
const descriptor = (face: string, name: string) =>
  new RegExp(`${name}:\\s*([^;]+);`).exec(face)?.[1]?.replace(/\s+/g, ' ').trim();
const PLEX_RANGE =
  'U+2E80-2FDF, U+3000-303F, U+3040-309F, U+30A0-30FF, U+31F0-31FF, U+3400-4DBF, U+4E00-9FFF, U+F900-FAFF, U+FF00-FFEF';

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.className = '';
});

describe('bundled font faces', () => {
  it('loads nothing from outside the app', () => {
    for (const css of [fontsCss, indexCss]) {
      expect(css).not.toMatch(/googleapis|gstatic|@import|https?:\/\//i);
    }
    for (const face of faces) {
      const url = /url\('([^']+)'\)/.exec(face)?.[1];
      expect(url).toMatch(/^\.\.\/\.\.\/assets\/fonts\/[\w-]+\.woff2$/);
      expect(existsSync(join(rendererDir, url!))).toBe(true);
    }
  });

  it('declares Geist first, then the five Plex Sans JP weights, then PlemolJP Console, all blocking', () => {
    expect(faces).toHaveLength(12);
    for (const face of faces) expect(descriptor(face, 'font-display')).toBe('block');
    const summary = faces.map((face) => [
      descriptor(face, 'font-family'),
      descriptor(face, 'font-weight'),
      /assets\/fonts\/([\w-]+)\.woff2/.exec(face)?.[1],
    ]);
    // The weight bands a browser chooses between the five Plex weights. Geist is declared once
    // per band with the same band, because only faces with the same descriptors are combined by
    // unicode-range — with a single `100 900` Geist face Chromium drew Latin in the system font.
    const bands = ['1 400', '401 450', '451 500', '501 600', '601 1000'];
    const plex = ['Regular', 'Text', 'Medium', 'SemiBold', 'Bold'];
    expect(summary).toEqual([
      ...bands.map((band) => ["'SC Sans'", band, 'Geist-Variable']),
      ...bands.map((band, i) => ["'SC Sans'", band, `IBMPlexSansJP-${plex[i]}`]),
      ["'SC Mono'", '400', 'PlemolJPConsole-Regular'],
      ["'SC Mono'", '700', 'PlemolJPConsole-Bold'],
    ]);
    // Geist covers everything; Plex only the Japanese ranges, scaled to sit with Geist.
    for (const face of faces.slice(0, 5)) {
      expect(descriptor(face, 'unicode-range')).toBeUndefined();
      expect(descriptor(face, 'size-adjust')).toBeUndefined();
    }
    for (const face of faces.slice(5, 10)) {
      expect(descriptor(face, 'unicode-range')).toBe(PLEX_RANGE);
      expect(descriptor(face, 'size-adjust')).toBe('92%');
    }
  });

  it('names fonts only through the two tokens', () => {
    expect(indexCss).toContain(`--font-sans: 'SC Sans', system-ui, sans-serif;`);
    expect(indexCss).toContain(`--font-mono: 'SC Mono', ui-monospace, monospace;`);
    expect(indexCss).not.toMatch(/--font-(?:ui|display)\b/);
    const families = [...indexCss.matchAll(/font-family:\s*([^;]+);/g)].map((m) => m[1]!.trim());
    for (const family of families)
      expect(family).toMatch(/^(?:var\(--font-(?:sans|mono)\)|inherit)$/);
    const shorthands = [...indexCss.matchAll(/(?<![-\w])font:\s*([^;]+);/g)].map((m) =>
      m[1]!.trim(),
    );
    for (const value of shorthands) expect(value).toMatch(/^(?:inherit|.+ var\(--font-mono\))$/);
    expect(FONT_SANS).toBe('"SC Sans", system-ui, sans-serif');
    expect(FONT_MONO).toBe('"SC Mono", ui-monospace, monospace');
  });

  it('sets Windows running text at 450 without touching weights that are set on purpose', () => {
    expect(indexCss).toMatch(
      /\.is-win body,\s*:where\(\.is-win\) :where\(button, input, textarea, select\) \{\s*font-weight: 450;\s*\}/,
    );
  });

  it('keeps monospaced text on whole cells, so Japanese and box-drawing stay in their columns', () => {
    expect(indexCss).toMatch(
      /pre,\s*code,\s*kbd,\s*samp,\s*\.command-card__output,\s*\.file-editor-textarea \{\s*letter-spacing: 0;\s*\}/,
    );
  });
});

describe('applyPlatformClass', () => {
  it('marks the root on Windows only', () => {
    const root = document.documentElement;
    applyPlatformClass(root, 'win32');
    expect(root.classList.contains('is-win')).toBe(true);
    for (const platform of ['darwin', 'linux', undefined]) {
      applyPlatformClass(root, platform);
      expect(root.classList.contains('is-win')).toBe(false);
    }
  });

  it('loads every declared weight before the first paint, so no face is first asked for later', () => {
    expect(STARTUP_FONT_SPECS).toEqual([
      '400 14px "SC Sans"',
      '450 14px "SC Sans"',
      '500 14px "SC Sans"',
      '600 14px "SC Sans"',
      '700 14px "SC Sans"',
      '400 13px "SC Mono"',
      '700 13px "SC Mono"',
    ]);
  });
});

describe('waitForFonts', () => {
  it('resolves as soon as every face has loaded', async () => {
    const load = vi.fn(async () => []);
    await expect(
      waitForFonts({ load }, ['400 14px "SC Sans"', '400 13px "SC Mono"'], 1000),
    ).resolves.toBe('loaded');
    expect(load).toHaveBeenCalledWith('400 14px "SC Sans"', 'Aあ漢─');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('gives up waiting at the limit, so a slow font never holds the first paint', async () => {
    vi.useFakeTimers();
    const pending = waitForFonts(
      { load: () => new Promise<FontFace[]>(() => {}) },
      ['x'],
      STARTUP_FONT_WAIT_MS,
    );
    vi.advanceTimersByTime(STARTUP_FONT_WAIT_MS - 1);
    await Promise.resolve();
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(pending).resolves.toBe('timeout');
  });

  it('draws anyway when a face fails or the browser has no font loading API', async () => {
    await expect(
      waitForFonts({ load: () => Promise.reject(new Error('bad font')) }, ['x'], 1000),
    ).resolves.toBe('failed');
    await expect(waitForFonts(undefined, ['x'], 1000)).resolves.toBe('unsupported');
  });
});

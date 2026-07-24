// WCAG 2.2 contrast-ratio helpers (NFR-A11Y-01) — pure functions, no DOM dependency, so they can
// run under vitest's default Node environment against the raw index.css text. Used by
// contrast.test.ts to audit the design-token color pairs actually used for text/UI in
// apps/desktop/src/renderer/index.css.

export type RGB = readonly [number, number, number];

/** Parses `#rgb`, `#rrggbb` (case-insensitive). Returns null for anything else (e.g. `rgba(...)`,
 * `color-mix(...)`, keywords) — callers that need those forms provide the RGB directly instead. */
export function parseHexColor(value: string): RGB | null {
  const trimmed = value.trim();
  const long = /^#([0-9a-f]{6})$/i.exec(trimmed);
  if (long) {
    const hex = long[1]!;
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }
  const short = /^#([0-9a-f]{3})$/i.exec(trimmed);
  if (short) {
    const hex = short[1]!;
    return [
      parseInt(hex[0]! + hex[0], 16),
      parseInt(hex[1]! + hex[1], 16),
      parseInt(hex[2]! + hex[2], 16),
    ];
  }
  return null;
}

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (https://www.w3.org/TR/WCAG22/#dfn-relative-luminance). */
export function relativeLuminance([r, g, b]: RGB): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG contrast ratio between two opaque colors, in the [1, 21] range. */
export function contrastRatio(a: RGB, b: RGB): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Alpha-composites `fg` over an opaque `bg` (simple "over" blend, no premultiplication needed
 * since `bg` is always fully opaque here) — models a text color rendered at `<1` CSS `opacity`
 * (or an rgba() foreground) against a solid backdrop. */
export function compositeOver(fg: RGB, bg: RGB, alpha: number): RGB {
  return [
    fg[0] * alpha + bg[0] * (1 - alpha),
    fg[1] * alpha + bg[1] * (1 - alpha),
    fg[2] * alpha + bg[2] * (1 - alpha),
  ];
}

export const WCAG_AA_NORMAL_TEXT = 4.5;
export const WCAG_AA_LARGE_TEXT_OR_UI = 3.0;

/** Parses every `--name: value;` declaration out of the first `:root { ... }` block in a CSS
 * source string. Only used for the small, closed set of tokens this app defines — not a general
 * CSS parser (doesn't handle nested rules, comments inside the block, or multi-value shorthands). */
export function parseRootCustomProperties(css: string): Map<string, string> {
  const match = /:root\s*\{([^}]*)\}/.exec(css);
  const body = match?.[1] ?? '';
  const props = new Map<string, string>();
  const re = /--([a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
  for (const m of body.matchAll(re)) {
    props.set(m[1]!.trim(), m[2]!.trim());
  }
  return props;
}

/** Reads the numeric `opacity:` value declared for a given CSS selector block. Returns null if the
 * selector or an `opacity:` declaration inside it isn't found. Only matches a selector's own rule
 * body (non-greedy up to the next `}`), not any nested/following rules. */
export function findSelectorOpacity(css: string, selector: string): number | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`);
  const match = re.exec(css);
  if (!match) return null;
  const opacityMatch = /opacity:\s*([0-9.]+)/.exec(match[1]!);
  return opacityMatch ? Number(opacityMatch[1]) : null;
}

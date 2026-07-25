import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compositeOver,
  contrastRatio,
  findSelectorOpacity,
  parseHexColor,
  parseRootCustomProperties,
  WCAG_AA_LARGE_TEXT_OR_UI,
  WCAG_AA_NORMAL_TEXT,
} from './contrast';
import type { RGB } from './contrast';

// NFR-A11Y-01 (docs/PRODUCT_AND_TECHNICAL_DESIGN.md): "WCAG 2.2 AA相当のcontrastを満たす". This
// audits every design-token color pair actually used as text/UI color against the backgrounds it
// actually appears on in index.css — computed from the real token values (not hand-copied
// numbers), so it regresses the moment either side of a pair drifts.
//
// Adjustments made as a result of this audit (see index.css comments at each site):
//   - `.composer-input::placeholder` opacity 0.7 -> 0.85 (was 3.88:1 on --bg-elevated, fails AA).
//   - `.tlv-timeline small` opacity 0.75 -> 0.85 (was 4.53:1 on --bg-surface — technically over
//     4.5 but too close to the line to trust across renderers/anti-aliasing).
// No `:root` token itself needed changing — every token pair at full opacity already clears AA
// (worst case 5.18:1, `--state-danger` on `--bg-elevated`); only two *usages* that intentionally
// dim text via `opacity` needed adjusting.

const cssPath = join(__dirname, '..', 'index.css');
const css = readFileSync(cssPath, 'utf8');
const tokens = parseRootCustomProperties(css);

function tokenRgb(name: string): RGB {
  const value = tokens.get(name);
  if (!value) throw new Error(`Token --${name} not found in index.css`);
  const rgb = parseHexColor(value);
  if (!rgb) throw new Error(`Token --${name} (${value}) is not a plain hex color`);
  return rgb;
}

const BACKGROUNDS = ['bg-canvas', 'bg-surface', 'bg-elevated'] as const;

describe('design-token contrast audit (WCAG 2.2 AA)', () => {
  it('every background token is actually opaque (parseable as hex)', () => {
    for (const bg of BACKGROUNDS) {
      expect(() => tokenRgb(bg)).not.toThrow();
    }
  });

  describe.each(['text-primary', 'text-secondary'] as const)('%s (normal text)', (fg) => {
    it.each(BACKGROUNDS)(`meets ${WCAG_AA_NORMAL_TEXT}:1 on --%s`, (bg) => {
      const ratio = contrastRatio(tokenRgb(fg), tokenRgb(bg));
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });
  });

  // Accent/status colors are used both as small-UI-component color (status dots, focus rings —
  // 3:1 is sufficient) and, in several places, as regular-sized text (e.g. the runtime-chip label,
  // approval risk badge, `tlv-timeline` sender links) — held to the stricter 4.5:1 normal-text bar
  // throughout so every real usage is covered without needing to track each call site.
  describe.each([
    'accent-primary',
    'accent-cool',
    'state-success',
    'state-warning',
    'state-danger',
  ] as const)('%s (accent/status, used as text)', (fg) => {
    it.each(BACKGROUNDS)(`meets ${WCAG_AA_NORMAL_TEXT}:1 on --%s`, (bg) => {
      const ratio = contrastRatio(tokenRgb(fg), tokenRgb(bg));
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });
  });

  // The focus ring itself (`:focus-visible { outline: 2px solid var(--accent-cool) }`, NFR-A11Y-02)
  // is a non-text UI indicator — WCAG 1.4.11 only requires 3:1 against its adjacent backgrounds.
  it.each(BACKGROUNDS)(
    'focus ring (--accent-cool) meets %s 3:1 as a UI indicator on --%s',
    (bg) => {
      const ratio = contrastRatio(tokenRgb('accent-cool'), tokenRgb(bg));
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_LARGE_TEXT_OR_UI);
    },
  );
});

// issue #17: the thinking pill's label is painted with a `background-clip: text` gradient that sweeps
// across it, so its effective colour cycles through every stop. Asserting each stop against the
// surface the pill sits on is what makes "readable at every phase of the sweep" a checked property
// rather than a hope — a gradient is exactly the kind of thing that looks fine in the frame someone
// screenshots and fails in the frames they do not.
describe('thinking pill sheen gradient (issue #17)', () => {
  it.each(['text-primary', 'accent-primary', 'accent-cool'] as const)(
    'stop --%s stays readable on the card surface',
    (stop) => {
      const ratio = contrastRatio(tokenRgb(stop), tokenRgb('bg-surface'));
      expect(ratio, `--${stop} on --bg-surface`).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    },
  );

  it('the gradient uses only tokens, so no literal can slip past this audit', () => {
    // A hex or rgba() literal in the gradient would still render, but would be invisible to the token
    // audit above — the assertion is on the CSS text, not on the tokens.
    const sheen = /\.run-title\.sheen\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(sheen, '.run-title.sheen rule found').not.toBe('');
    expect(sheen).toContain('var(--text-primary)');
    expect(sheen).toContain('var(--accent-primary)');
    expect(sheen).toContain('var(--accent-cool)');
    expect(sheen).not.toMatch(/#[0-9a-fA-F]{3,8}|rgba?\(/);
  });

  it('reduced motion restores a solid, painted colour rather than only stopping the animation', () => {
    // With `-webkit-text-fill-color: transparent` still in force, stopping the animation alone leaves
    // the label invisible — the global 0.01ms squash is not enough on its own.
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    const block = reduced.slice(0, reduced.indexOf('@media (forced-colors'));
    expect(block).toContain('.run-title.sheen');
    expect(block).toMatch(/-webkit-text-fill-color:\s*var\(--text-primary\)/);
  });

  it('forced colours paint the label with a system colour', () => {
    const forced = css.slice(css.indexOf('@media (forced-colors: active)'));
    expect(forced).toContain('.run-title.sheen');
    expect(forced).toMatch(/-webkit-text-fill-color:\s*CanvasText/);
  });
});

describe('opacity-dimmed text usages (real text, not decorative)', () => {
  // Placeholder text and de-emphasized list metadata are real, readable content (not disabled or
  // decorative) — WCAG's contrast SC still applies, even though the visual design intentionally
  // dims them below full --text-secondary strength via `opacity`.
  const cases: Array<{ selector: string; bg: string; label: string }> = [
    { selector: '.composer-input::placeholder', bg: 'bg-elevated', label: 'Composer placeholder' },
    { selector: '.tlv-timeline small', bg: 'bg-surface', label: 'List View timeline metadata' },
    {
      selector: '.sb-search input::placeholder',
      bg: 'bg-surface',
      label: 'Sidebar search placeholder',
    },
    { selector: '.cc-hint', bg: 'bg-canvas', label: 'Canvas keyboard-shortcut hint' },
  ];

  it.each(cases)('$label ($selector) meets 4.5:1 on --$bg after opacity', ({ selector, bg }) => {
    const opacity = findSelectorOpacity(css, selector);
    expect(opacity, `expected an opacity: declaration on ${selector}`).not.toBeNull();
    const effective = compositeOver(tokenRgb('text-secondary'), tokenRgb(bg), opacity!);
    const ratio = contrastRatio(effective, tokenRgb(bg));
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });
});

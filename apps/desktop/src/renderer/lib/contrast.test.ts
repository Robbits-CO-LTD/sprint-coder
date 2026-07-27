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
// audits every design token used as text/UI colour against the backgrounds it actually appears on
// in index.css — computed from the real token values (not hand-copied numbers), so it regresses the
// moment either side of a pair drifts.
//
// The current warm-dark palette restores the approved demo's atmosphere while retaining the
// expanded surface/foreground system introduced later. Each group states which contrast bar it is
// held to, so visual direction changes cannot silently weaken readability.

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

/**
 * Every surface real content is rendered on.
 *
 * `--accent-muted` is deliberately absent: it is an accent-tinted *fill*, and the only foreground
 * this palette puts on it is `--text-primary` (asserted separately below). Including it here would
 * force every accent-family token lighter to survive an accent-on-accent pairing the palette does
 * not offer.
 */
const CONTENT_SURFACES = [
  'bg-app',
  'bg-sidebar',
  'bg-panel',
  'bg-elevated',
  'bg-hover',
  'bg-selected',
  'ai-surface',
] as const;

/**
 * Surfaces that host a bordered control.
 *
 * `--bg-selected` is a row-selection fill — it never hosts an input — so it is not part of the bar
 * for `--border-strong`.
 */
const CONTROL_SURFACES = ['bg-app', 'bg-sidebar', 'bg-panel', 'bg-elevated', 'bg-hover'] as const;

/** Held to 4.5:1 on every content surface: all of these render real, readable text somewhere. */
const TEXT_TOKENS = [
  'text-primary',
  'text-secondary',
  'text-muted',
  'accent',
  'accent-hover',
  'focus-ring',
  'success',
  'warning',
  'danger',
  'info',
  'ai-accent',
] as const;

describe('design-token contrast audit (WCAG 2.2 AA)', () => {
  it('every surface token is actually opaque (parseable as hex)', () => {
    for (const bg of [...CONTENT_SURFACES, 'accent-muted']) {
      expect(() => tokenRgb(bg)).not.toThrow();
    }
  });

  // One bar for every text-bearing token rather than a per-token exception list. Accent and status
  // colours are used both as small-UI colour (status dots, focus rings — 3:1 would suffice) and as
  // regular-sized text (chip labels, risk badges, sender links), so holding all of them to the
  // stricter normal-text bar covers every real usage without tracking call sites.
  describe.each(TEXT_TOKENS)('%s (renders text)', (fg) => {
    it.each(CONTENT_SURFACES)(`meets ${WCAG_AA_NORMAL_TEXT}:1 on --%s`, (bg) => {
      const ratio = contrastRatio(tokenRgb(fg), tokenRgb(bg));
      expect(ratio, `--${fg} on --${bg}`).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    });
  });

  // WCAG 1.4.11: a boundary that carries meaning (an input's edge) is a non-text UI component and
  // needs 3:1. `--border-strong` exists precisely for those, so it is the token that must clear it.
  it.each(CONTROL_SURFACES)(
    `--border-strong meets ${WCAG_AA_LARGE_TEXT_OR_UI}:1 as a UI boundary on --%s`,
    (bg) => {
      const ratio = contrastRatio(tokenRgb('border-strong'), tokenRgb(bg));
      expect(ratio, `--border-strong on --${bg}`).toBeGreaterThanOrEqual(WCAG_AA_LARGE_TEXT_OR_UI);
    },
  );

  // The counterpart assertion: --border-subtle is decorative separation and does NOT clear 3:1.
  // Asserting that it does not is what stops it from being quietly promoted into an essential
  // boundary because "it looked fine" — the two tokens have to stay distinguishable in purpose.
  it('--border-subtle stays below the UI-boundary bar, so it cannot be the sole indicator', () => {
    const ratio = contrastRatio(tokenRgb('border-subtle'), tokenRgb('bg-app'));
    expect(ratio).toBeLessThan(WCAG_AA_LARGE_TEXT_OR_UI);
  });

  // The focus ring (`:focus-visible { outline: 2px solid var(--focus-ring) }`, NFR-A11Y-02) only
  // needs 3:1 as a non-text indicator, but it is in TEXT_TOKENS above at 4.5:1 — this records the
  // headroom rather than a second, weaker bar.
  it.each(CONTENT_SURFACES)('focus ring keeps headroom above the 3:1 UI bar on --%s', (bg) => {
    const ratio = contrastRatio(tokenRgb('focus-ring'), tokenRgb(bg));
    expect(ratio).toBeGreaterThan(WCAG_AA_LARGE_TEXT_OR_UI);
  });

  // --accent-muted is a fill. Its sanctioned foreground is --text-primary; accent-on-accent-muted
  // measures 4.10 and is not a pairing the palette offers.
  it('--text-primary is readable on the --accent-muted fill', () => {
    const ratio = contrastRatio(tokenRgb('text-primary'), tokenRgb('accent-muted'));
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });

  // Disabled text is exempt from WCAG 1.4.3, so --text-disabled has no contrast bar. What it does
  // need is to stay clearly *below* --text-muted, or the two stop being visually distinguishable
  // and "disabled" loses its meaning.
  it('--text-disabled reads as dimmer than --text-muted', () => {
    const disabled = contrastRatio(tokenRgb('text-disabled'), tokenRgb('bg-app'));
    const muted = contrastRatio(tokenRgb('text-muted'), tokenRgb('bg-app'));
    expect(disabled).toBeLessThan(muted);
  });

  it('no retired token name is still referenced', () => {
    for (const retired of [
      'bg-canvas',
      'bg-surface',
      'accent-primary',
      'accent-cool',
      'state-success',
      'state-warning',
      'state-danger',
    ]) {
      expect(css, `var(--${retired}) still referenced`).not.toContain(`var(--${retired})`);
    }
  });
});

// issue #17: the thinking pill's label is painted with a `background-clip: text` gradient that sweeps
// across it, so its effective colour cycles through every stop. Asserting each stop against the
// surface the pill sits on is what makes "readable at every phase of the sweep" a checked property
// rather than a hope — a gradient is exactly the kind of thing that looks fine in the frame someone
// screenshots and fails in the frames they do not.
describe('thinking pill sheen gradient (issue #17)', () => {
  it.each(['text-primary', 'accent', 'ai-accent'] as const)(
    'stop --%s stays readable on the card surface',
    (stop) => {
      const ratio = contrastRatio(tokenRgb(stop), tokenRgb('bg-panel'));
      expect(ratio, `--${stop} on --bg-panel`).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
    },
  );

  it('the gradient uses only tokens, so no literal can slip past this audit', () => {
    // A hex or rgba() literal in the gradient would still render, but would be invisible to the token
    // audit above — the assertion is on the CSS text, not on the tokens.
    const sheen = /\.run-title\.sheen\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(sheen, '.run-title.sheen rule found').not.toBe('');
    expect(sheen).toContain('var(--text-primary)');
    expect(sheen).toContain('var(--accent)');
    expect(sheen).toContain('var(--ai-accent)');
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
    { selector: '.tlv-timeline small', bg: 'bg-panel', label: 'List View timeline metadata' },
    {
      selector: '.sb-search input::placeholder',
      bg: 'bg-panel',
      label: 'Sidebar search placeholder',
    },
    { selector: '.cc-hint', bg: 'bg-app', label: 'Canvas keyboard-shortcut hint' },
  ];

  it.each(cases)('$label ($selector) meets 4.5:1 on --$bg after opacity', ({ selector, bg }) => {
    const opacity = findSelectorOpacity(css, selector);
    expect(opacity, `expected an opacity: declaration on ${selector}`).not.toBeNull();
    const effective = compositeOver(tokenRgb('text-secondary'), tokenRgb(bg), opacity!);
    const ratio = contrastRatio(effective, tokenRgb(bg));
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT);
  });
});

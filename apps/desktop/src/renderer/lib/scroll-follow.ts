// Scroll-follow arithmetic for the chat Timeline (issue #3).
//
// Kept as pure functions on a plain metrics object rather than reading the element inline, so the
// "is the reader still pinned to the bottom?" decision is unit-testable without a DOM — the
// renderer suite runs on react-dom/server and has no jsdom (see components/Markdown.adversarial.test.tsx).

/**
 * How far from the exact bottom still counts as "pinned".
 *
 * Needs to be > 0 for two reasons: sub-pixel `scrollHeight`/`clientHeight` rounding means a
 * scrollport that is visually at the bottom often reports a residual 0.5–1px, and a reader who
 * nudges the wheel a notch without meaning to leave the live tail should not lose autoscroll.
 * 40px is under one line-height of chat text (20px gap + ~22px line), so it cannot span a whole
 * message — scrolling up far enough to read anything at all already exceeds it.
 */
export const FOLLOW_THRESHOLD_PX = 40;

export type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/** Pixels of content below the bottom edge of the scrollport. */
export function distanceFromBottom({
  scrollTop,
  scrollHeight,
  clientHeight,
}: ScrollMetrics): number {
  return scrollHeight - clientHeight - scrollTop;
}

/**
 * True while the reader is at (or within `threshold` of) the bottom — i.e. while autoscroll should
 * keep following new tokens.
 *
 * Content shorter than the scrollport reports `scrollHeight === clientHeight` and `scrollTop === 0`,
 * giving distance 0, so a timeline with nothing to scroll is always "pinned" and never offers a
 * jump-to-latest affordance. Rubber-band overscroll reports a negative distance and stays pinned.
 */
export function isPinnedToBottom(metrics: ScrollMetrics, threshold = FOLLOW_THRESHOLD_PX): boolean {
  return distanceFromBottom(metrics) <= threshold;
}

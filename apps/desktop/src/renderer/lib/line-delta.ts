import { changedLineIndices } from './changed-lines';

/**
 * How many lines a file gained and lost, for the one-line summary on a file row (issue #45).
 *
 * Derived from the same LCS the highlight uses, so the number in the list and the marks in the body
 * can never disagree — two independent diffs drifting apart would be worse than no number at all.
 *
 * Returns null when there is no baseline. That is not a failure: a file the Turn created, or one the
 * app only heard about after it changed, has nothing to be counted against, and the row shows its
 * total size instead of inventing a delta.
 */
export type LineDelta = { added: number; removed: number };

export function lineDelta(baseline: string | null, text: string): LineDelta | null {
  if (baseline === null) return null;
  const before = baseline.split('\n');
  const after = text.split('\n');
  const added = changedLineIndices(baseline, text).size;
  // Removals are what the LCS did not keep. Counting them this way rather than with a second pass
  // keeps the two numbers consistent with each other by construction.
  const kept = after.length - added;
  const removed = Math.max(0, before.length - kept);
  return { added, removed };
}

/** Lines in a body, counting a trailing newline as ending the last line rather than starting one. */
export function lineCount(text: string): number {
  if (text === '') return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

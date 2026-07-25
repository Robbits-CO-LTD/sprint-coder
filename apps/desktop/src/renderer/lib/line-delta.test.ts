import { describe, expect, it } from 'vitest';
import { lineCount, lineDelta } from './line-delta';

describe('lineDelta (issue #45)', () => {
  it('reports nothing to compare when there is no baseline', () => {
    // A file the Turn created, or one only seen after it changed, has nothing to count against. The
    // row shows its size instead of an invented delta.
    expect(lineDelta(null, 'a\nb\n')).toBeNull();
  });

  it('counts added lines for an append', () => {
    expect(lineDelta('a\nb', 'a\nb\nc')).toEqual({ added: 1, removed: 0 });
  });

  it('counts removed lines for a deletion', () => {
    expect(lineDelta('a\nb\nc', 'a\nc')).toEqual({ added: 0, removed: 1 });
  });

  it('counts a replaced line as one added and one removed', () => {
    expect(lineDelta('a\nb\nc', 'a\nB\nc')).toEqual({ added: 1, removed: 1 });
  });

  it('reports zero for an unchanged file rather than null', () => {
    // Null means "cannot compare"; zero means "compared, nothing moved". A row must be able to say
    // the second thing.
    expect(lineDelta('a\nb', 'a\nb')).toEqual({ added: 0, removed: 0 });
  });

  it('counts a whole-file rewrite on both sides', () => {
    expect(lineDelta('a\nb\nc', 'x\ny')).toEqual({ added: 2, removed: 3 });
  });

  it('never reports a negative count', () => {
    // The two numbers come from one LCS pass, so they cannot disagree — but a row rendering "−-1"
    // would be worse than any wrong-but-plausible number, so it is pinned.
    for (const [before, after] of [
      ['', 'a'],
      ['a', ''],
      ['a\n\n\nb', 'b'],
      ['a\nb\nc\nd\ne', 'e\nd\nc\nb\na'],
    ] as const) {
      const delta = lineDelta(before, after);
      expect(delta).not.toBeNull();
      expect(delta?.added).toBeGreaterThanOrEqual(0);
      expect(delta?.removed).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('lineCount (issue #45)', () => {
  it('treats a trailing newline as ending the last line, not starting a new one', () => {
    // "a\n" is one line. Counting it as two would make every file report one line more than an
    // editor shows.
    expect(lineCount('a\n')).toBe(1);
    expect(lineCount('a\nb\n')).toBe(2);
    expect(lineCount('a\nb')).toBe(2);
  });

  it('is zero for empty text', () => {
    expect(lineCount('')).toBe(0);
  });
});

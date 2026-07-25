import { describe, expect, it } from 'vitest';
import { changedLineIndices } from './changed-lines';

const changed = (before: string, after: string): number[] =>
  [...changedLineIndices(before, after)].sort((a, b) => a - b);

describe('changedLineIndices (issue #39)', () => {
  it('marks nothing on the first frame of a file', () => {
    // Flashing an entire body the moment it appears is noise, not information.
    expect(changed('', 'a\nb\nc')).toEqual([]);
  });

  it('marks nothing when the text is unchanged', () => {
    expect(changed('a\nb', 'a\nb')).toEqual([]);
  });

  it('marks only the appended lines while text streams in', () => {
    expect(changed('a\nb', 'a\nb\nc')).toEqual([2]);
  });

  it('marks the last line while it is still being typed', () => {
    // Streaming rewrites the final line character by character; that line is the one that moved.
    expect(changed('const a =', 'const a = 1;')).toEqual([0]);
  });

  it('marks an insertion in the middle without marking everything after it', () => {
    // The whole point: a naive index-by-index compare would call every line below an insertion
    // changed, which highlights the entire file and says nothing.
    expect(changed('a\nb\nc', 'a\nNEW\nb\nc')).toEqual([1]);
  });

  it('marks a replaced line and leaves its neighbours alone', () => {
    expect(changed('a\nb\nc', 'a\nB\nc')).toEqual([1]);
  });

  it('marks nothing for a pure deletion, because no line in the new text is new', () => {
    expect(changed('a\nb\nc', 'a\nc')).toEqual([]);
  });

  it('handles a whole-file rewrite, which is what a patch application looks like', () => {
    expect(changed('a\nb\nc', 'x\ny\nz')).toEqual([0, 1, 2]);
  });

  it('falls back to the common prefix past the size budget instead of going quadratic', () => {
    // 400 is the budget; a 5,000-line file must not spend the frame on an LCS table. The fallback is
    // exact for the append-only case, which is what streaming produces.
    const base = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
    const grown = `${base}\nline 5000`;
    expect(changed(base, grown)).toEqual([5000]);
  });

  it('never reports an index outside the new text', () => {
    // The set indexes into the rendered lines; an out-of-range index would highlight nothing and
    // hide a real bug.
    const after = 'a\nb';
    for (const before of ['', 'a', 'a\nb\nc\nd', 'x\ny\nz'])
      for (const index of changedLineIndices(before, after))
        expect(index).toBeLessThan(after.split('\n').length);
  });
});

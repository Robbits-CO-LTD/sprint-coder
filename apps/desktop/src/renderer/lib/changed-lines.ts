/**
 * Which lines differ between two versions of a file body (issue #39).
 *
 * A disk-sourced update replaces the whole file at once — Codex applies a patch rather than typing,
 * so twenty lines can change between two frames. Without marking what moved, the reader has to
 * diff two screens of monospace by eye, which is exactly the work the panel is supposed to save.
 *
 * This is a line-level longest-common-subsequence, not a character diff: it answers "which lines are
 * new right now" and nothing more. A real patch view belongs next to the file, not inside a 380px
 * side panel, and a character diff of streaming text would re-render on every frame.
 *
 * Cheap by construction. Above LCS_LINE_BUDGET lines the quadratic table is skipped and every line
 * is reported unchanged: a highlight is a nicety, and spending 30ms of the frame budget on one for a
 * 5,000-line file would cost the very smoothness it exists to provide.
 */
const LCS_LINE_BUDGET = 400;

export function changedLineIndices(previous: string, next: string): Set<number> {
  if (previous === next) return new Set();
  const before = previous.split('\n');
  const after = next.split('\n');
  // First render of a file: everything is new, but flashing the entire body would be noise rather
  // than information.
  if (previous === '') return new Set();
  if (before.length > LCS_LINE_BUDGET || after.length > LCS_LINE_BUDGET) {
    // Fall back to the common-prefix heuristic, which is exact for the append-only case that
    // streaming produces and is the one that matters at this size.
    const changed = new Set<number>();
    let shared = 0;
    while (shared < before.length && shared < after.length && before[shared] === after[shared])
      shared += 1;
    for (let index = shared; index < after.length; index += 1) changed.add(index);
    return changed;
  }

  // table[i][j] = length of the LCS of before[i..] and after[j..]
  const table: number[][] = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const row = table[i];
    if (row === undefined) continue;
    for (let j = after.length - 1; j >= 0; j -= 1)
      row[j] =
        before[i] === after[j]
          ? (table[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(table[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
  }

  const changed = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      // The `before` line was removed; nothing in `after` to mark for it.
      i += 1;
      continue;
    }
    changed.add(j);
    j += 1;
  }
  for (; j < after.length; j += 1) changed.add(j);
  return changed;
}

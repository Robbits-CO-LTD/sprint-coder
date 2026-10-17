import { describe, expect, it } from 'vitest';
import { commitMessageLine } from './team-coordinator';

describe('commitMessageLine (issue #829)', () => {
  it('cuts by code point, never between the halves of an emoji', () => {
    const line = commitMessageLine(`${'a'.repeat(8)}😀😀😀`, 10);
    expect(line).toBe(`${'a'.repeat(8)}😀…`);
    expect(line).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });

  it('keeps a line that fits, folded to one line and redacted', () => {
    expect(commitMessageLine('write\n  the   file', 72)).toBe('write the file');
    expect(commitMessageLine('use password=hunter2-correct-horse', 72)).toBe(
      'use password=[REDACTED]',
    );
  });
});

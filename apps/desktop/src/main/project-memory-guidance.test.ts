import { describe, expect, it } from 'vitest';
import {
  appendProjectMemoryCandidate,
  parseProjectMemoryCandidate,
} from './project-memory-guidance';

describe('Project Memory candidate policy', () => {
  it('normalizes a self-contained candidate and rejects secrets or extra fields', () => {
    expect(parseProjectMemoryCandidate({ content: '  Stable decision.  ' })).toBe(
      'Stable decision.',
    );
    expect(() => parseProjectMemoryCandidate({ content: 'token=abcdefghijklmnop' })).toThrow(
      '秘密を含む内容',
    );
    expect(() => parseProjectMemoryCandidate({ content: 'safe', taskId: 'spoofed' })).toThrow();
  });

  it('deduplicates candidates and enforces the per-Turn cap', () => {
    const one = appendProjectMemoryCandidate([], { projectId: 'p', content: 'one' });
    expect(appendProjectMemoryCandidate(one, { projectId: 'p', content: 'one' })).toEqual(one);
    const three = [
      { projectId: 'p', content: 'one' },
      { projectId: 'p', content: 'two' },
      { projectId: 'p', content: 'three' },
    ];
    expect(() => appendProjectMemoryCandidate(three, { projectId: 'p', content: 'four' })).toThrow(
      '3件まで',
    );
  });
});

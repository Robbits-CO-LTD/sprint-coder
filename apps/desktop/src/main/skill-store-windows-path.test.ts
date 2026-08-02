import { describe, expect, it } from 'vitest';
import { isWindowsSafePathSegment } from './skill-store';

describe('Windows-safe Skill path validation', () => {
  it('rejects device names, invalid characters, and ambiguous trailing characters', () => {
    for (const name of ['CON', 'nul.txt', 'COM1', 'LPT9.log', 'bad:name', 'trail.', 'trail '])
      expect(isWindowsSafePathSegment(name), name).toBe(false);
  });

  it('accepts ordinary Japanese names and names that merely contain reserved text', () => {
    for (const name of ['日本語スキル', 'console', 'component', '..notes'])
      expect(isWindowsSafePathSegment(name), name).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { pathComparisonKey, pathsEquivalent } from './path-comparison';

describe('path comparison', () => {
  it('folds Windows drive, separator, and tail casing into one identity', () => {
    const canonical = 'C:\\Users\\Alice\\Repo\\Src\\App.ts';
    const variant = 'c:/users/alice/repo/src/app.ts';

    expect(pathComparisonKey(canonical, 'win32')).toBe(pathComparisonKey(variant, 'win32'));
    expect(pathsEquivalent(canonical, variant, 'win32')).toBe(true);
  });

  it('preserves case-sensitive path identities on POSIX platforms', () => {
    expect(pathsEquivalent('/workspace/Src/App.ts', '/workspace/src/app.ts', 'linux')).toBe(false);
  });
});

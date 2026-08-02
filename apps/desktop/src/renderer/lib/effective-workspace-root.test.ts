import { describe, expect, it } from 'vitest';
import { hasEffectiveWorkspaceRoot } from './effective-workspace-root';

describe('effective Workspace root availability', () => {
  it('disables file editing for loaded and loading rootless tasks', () => {
    expect(hasEffectiveWorkspaceRoot(null, null, 0)).toBe(false);
    expect(hasEffectiveWorkspaceRoot(undefined, null, undefined)).toBe(false);
  });

  it('accepts a selected legacy Workspace or its task-summary fallback', () => {
    expect(hasEffectiveWorkspaceRoot({ path: 'C:\\work' }, null, 0)).toBe(true);
    expect(hasEffectiveWorkspaceRoot(undefined, 'C:\\legacy', 0)).toBe(true);
  });

  it('accepts a Project with configured folders even without a legacy Workspace', () => {
    expect(hasEffectiveWorkspaceRoot(null, null, 2)).toBe(true);
  });
});

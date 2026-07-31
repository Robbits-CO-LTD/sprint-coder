import { describe, expect, it, vi } from 'vitest';
import { allowTaskBoundary } from './task-boundary';

describe('dirty-editor Task boundary', () => {
  it('does not prompt when there is no unsaved edit', () => {
    const confirm = vi.fn(() => false);
    expect(allowTaskBoundary(false, confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('blocks Task selection and creation when discard is declined', () => {
    expect(allowTaskBoundary(true, () => false)).toBe(false);
  });

  it('allows the boundary after explicit discard confirmation', () => {
    expect(allowTaskBoundary(true, () => true)).toBe(true);
  });
});

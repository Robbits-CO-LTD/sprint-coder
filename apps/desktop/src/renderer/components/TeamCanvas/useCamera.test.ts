import { describe, expect, it, vi } from 'vitest';
import { preservesNestedScroll } from './useCamera';

describe('preservesNestedScroll', () => {
  it.each(['.timeline-scroll', '.w-body'])(
    'keeps wheel gestures inside the %s scrollport',
    (matchedSelector) => {
      const closest = vi.fn((selectors: string) =>
        selectors.includes(matchedSelector) ? ({} as Element) : null,
      );

      expect(preservesNestedScroll({ closest } as unknown as EventTarget)).toBe(true);
      expect(closest).toHaveBeenCalledWith('.timeline-scroll, .w-body');
    },
  );

  it('leaves wheel gestures on the canvas to camera controls', () => {
    expect(
      preservesNestedScroll({
        closest: () => null,
      } as unknown as EventTarget),
    ).toBe(false);
    expect(preservesNestedScroll(null)).toBe(false);
  });
});

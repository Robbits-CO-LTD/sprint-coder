import { describe, expect, it } from 'vitest';
import {
  MODEL_LIST_OVERSCAN_ROWS,
  MODEL_LIST_VIEWPORT_PX,
  MODEL_PAGE_PREFETCH_ROWS,
  MODEL_ROW_HEIGHT_PX,
  needsNextPage,
  nextActiveIndex,
  scrollTopForIndex,
  virtualRange,
} from './model-picker-virtualization';

// UI slice U1b: the Model Picker must hold a 1000+ model catalog without putting 1000 rows in the
// DOM, and must window the list identically at 2 rows and at 1200 — no small-list bypass. These
// cases pin down both, plus the arithmetic keyboard navigation and cursor paging depend on.

const DEFAULTS = {
  viewportHeightPx: MODEL_LIST_VIEWPORT_PX,
  rowHeightPx: MODEL_ROW_HEIGHT_PX,
  overscanRows: MODEL_LIST_OVERSCAN_ROWS,
};

/** Rows the window may ever mount: what fits, plus one straddling row, plus both overscan sides. */
const MAX_MOUNTED =
  Math.ceil(MODEL_LIST_VIEWPORT_PX / MODEL_ROW_HEIGHT_PX) + 1 + MODEL_LIST_OVERSCAN_ROWS * 2;

describe('virtualRange', () => {
  it('mounts a bounded window of a 1200 model catalog, not the catalog', () => {
    const range = virtualRange({ ...DEFAULTS, itemCount: 1200, scrollTop: 0 });
    expect(range.endIndex - range.startIndex).toBeLessThanOrEqual(MAX_MOUNTED);
    expect(range.startIndex).toBe(0);
    expect(range.totalHeightPx).toBe(1200 * MODEL_ROW_HEIGHT_PX);
  });

  it('stays bounded deep into the catalog and never mounts row 0 there', () => {
    const range = virtualRange({
      ...DEFAULTS,
      itemCount: 1200,
      scrollTop: 600 * MODEL_ROW_HEIGHT_PX,
    });
    expect(range.endIndex - range.startIndex).toBeLessThanOrEqual(MAX_MOUNTED);
    expect(range.startIndex).toBe(600 - MODEL_LIST_OVERSCAN_ROWS);
    expect(range.startIndex).toBeGreaterThan(0);
  });

  it('windows a 2 item list too — a short catalog gets no bypass', () => {
    const scrolledPastFirst = virtualRange({
      itemCount: 2,
      scrollTop: MODEL_ROW_HEIGHT_PX,
      viewportHeightPx: MODEL_ROW_HEIGHT_PX,
      rowHeightPx: MODEL_ROW_HEIGHT_PX,
      overscanRows: 0,
    });
    expect(scrolledPastFirst.startIndex).toBe(1);
    expect(scrolledPastFirst.endIndex).toBe(2);
    expect(scrolledPastFirst.topPadPx).toBe(MODEL_ROW_HEIGHT_PX);
    expect(scrolledPastFirst.bottomPadPx).toBe(0);
  });

  it('keeps the pads summing to the untruncated list height', () => {
    const range = virtualRange({ ...DEFAULTS, itemCount: 1200, scrollTop: 12_345 });
    const mountedPx = (range.endIndex - range.startIndex) * MODEL_ROW_HEIGHT_PX;
    expect(range.topPadPx + mountedPx + range.bottomPadPx).toBe(range.totalHeightPx);
    expect(range.topPadPx).toBeGreaterThanOrEqual(0);
    expect(range.bottomPadPx).toBeGreaterThanOrEqual(0);
  });

  it('mounts nothing for an empty result', () => {
    const range = virtualRange({ ...DEFAULTS, itemCount: 0, scrollTop: 0 });
    expect(range).toEqual({
      startIndex: 0,
      endIndex: 0,
      topPadPx: 0,
      bottomPadPx: 0,
      totalHeightPx: 0,
    });
  });

  it('clamps overscroll rather than trusting it', () => {
    const rubberBanded = virtualRange({ ...DEFAULTS, itemCount: 40, scrollTop: -300 });
    expect(rubberBanded.startIndex).toBe(0);
    expect(rubberBanded.topPadPx).toBe(0);
    // A search that shrinks the result set leaves the scrollport parked past the new end.
    const stale = virtualRange({ ...DEFAULTS, itemCount: 3, scrollTop: 90_000 });
    expect(stale.startIndex).toBe(0);
    expect(stale.endIndex).toBe(3);
    expect(stale.bottomPadPx).toBe(0);
  });
});

describe('scrollTopForIndex', () => {
  const base = { viewportHeightPx: MODEL_LIST_VIEWPORT_PX, rowHeightPx: MODEL_ROW_HEIGHT_PX };

  it('leaves the offset alone when the row is already visible', () => {
    expect(scrollTopForIndex({ ...base, index: 3, scrollTop: 0 })).toBe(0);
  });

  it('scrolls up to the row when it sits above the scrollport', () => {
    expect(scrollTopForIndex({ ...base, index: 2, scrollTop: 500 })).toBe(2 * MODEL_ROW_HEIGHT_PX);
  });

  it('scrolls down just far enough to reveal a row below the scrollport', () => {
    expect(scrollTopForIndex({ ...base, index: 6, scrollTop: 0 })).toBe(
      7 * MODEL_ROW_HEIGHT_PX - MODEL_LIST_VIEWPORT_PX,
    );
  });
});

describe('needsNextPage', () => {
  const base = { itemCount: 50, hasMore: true, prefetchRows: MODEL_PAGE_PREFETCH_ROWS };

  it('does not page when the cursor is exhausted', () => {
    expect(needsNextPage({ ...base, hasMore: false, endIndex: 50, activeIndex: 49 })).toBe(false);
  });

  it('pages when scrolling nears the end of the loaded rows', () => {
    expect(needsNextPage({ ...base, endIndex: 44, activeIndex: 0 })).toBe(true);
    expect(needsNextPage({ ...base, endIndex: 10, activeIndex: 0 })).toBe(false);
  });

  it('pages when the keyboard alone nears the end, with the scrollport untouched', () => {
    expect(needsNextPage({ ...base, endIndex: 8, activeIndex: 45 })).toBe(true);
  });

  it('pages for a first page that has not arrived yet', () => {
    expect(needsNextPage({ ...base, itemCount: 0, endIndex: 0, activeIndex: 0 })).toBe(true);
  });
});

describe('nextActiveIndex', () => {
  it('clamps instead of wrapping, so the end of a page does not read as the end of the list', () => {
    expect(nextActiveIndex('ArrowDown', 49, 50)).toBe(49);
    expect(nextActiveIndex('ArrowUp', 0, 50)).toBe(0);
  });

  it('moves one row per press', () => {
    expect(nextActiveIndex('ArrowDown', 3, 50)).toBe(4);
    expect(nextActiveIndex('ArrowUp', 3, 50)).toBe(2);
  });

  it('jumps to the ends', () => {
    expect(nextActiveIndex('Home', 30, 50)).toBe(0);
    expect(nextActiveIndex('End', 0, 50)).toBe(49);
  });

  it('declines keys it does not own, and an empty list', () => {
    expect(nextActiveIndex('Enter', 0, 50)).toBeNull();
    expect(nextActiveIndex('a', 0, 50)).toBeNull();
    expect(nextActiveIndex('ArrowDown', 0, 0)).toBeNull();
  });
});

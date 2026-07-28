// Windowing arithmetic for the multi-provider Model Picker list (UI slice U1b).
//
// Pure functions on plain numbers rather than element reads, for the same reason scroll-follow.ts
// is: the renderer suite runs on react-dom/server and has no jsdom, so the only way to pin down
// "which rows may exist in the DOM at this scroll offset?" is to make that decision arithmetic.
//
// The window is computed unconditionally — there is no small-list bypass. A catalog page can hold
// 2 models or 1200, and a bypass would mean the DOM contract ("nothing outside viewport+overscan")
// held only for the large case, which is exactly the case a test can least easily observe. One
// code path, one invariant.

/** Row height, in px. Must match `.mpv2-row`'s fixed `height` in index.css — the whole scheme
 * rests on every row being the same known height, so the list can be positioned without measuring. */
export const MODEL_ROW_HEIGHT_PX = 46;
/** Scrollport height, in px: six rows. Sized like `.model-menu`'s 320px cap so the picker keeps the
 * existing menus' proportions rather than introducing a new one. */
export const MODEL_LIST_VIEWPORT_PX = MODEL_ROW_HEIGHT_PX * 6;
/** Rows kept mounted on each side of the scrollport. Two is enough to cover a wheel notch between
 * a scroll event and the re-render it causes, without materially widening the DOM. */
export const MODEL_LIST_OVERSCAN_ROWS = 2;
/** How close to the end of the loaded rows the user gets before the next cursor page is fetched.
 * Larger than the overscan so paging starts before the user reaches blank space. */
export const MODEL_PAGE_PREFETCH_ROWS = 8;

export type VirtualRangeInput = {
  itemCount: number;
  scrollTop: number;
  viewportHeightPx: number;
  rowHeightPx: number;
  overscanRows: number;
};

export type VirtualRange = {
  /** First row index to mount (inclusive). */
  startIndex: number;
  /** One past the last row index to mount. `startIndex === endIndex` means mount nothing. */
  endIndex: number;
  /** Spacer height above the mounted rows, so the scrollbar and the rows agree. */
  topPadPx: number;
  /** Spacer height below the mounted rows. */
  bottomPadPx: number;
  /** Height the full list would occupy if every row were mounted. */
  totalHeightPx: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * The rows that may be in the DOM at `scrollTop`.
 *
 * Overscroll (a negative `scrollTop` from rubber-banding, or a `scrollTop` past the end after the
 * list shrinks under a new search) is clamped rather than trusted, so the range stays inside
 * `[0, itemCount]` and the pads stay non-negative no matter what the scrollport reports.
 */
export function virtualRange({
  itemCount,
  scrollTop,
  viewportHeightPx,
  rowHeightPx,
  overscanRows,
}: VirtualRangeInput): VirtualRange {
  const totalHeightPx = itemCount * rowHeightPx;
  if (itemCount <= 0 || rowHeightPx <= 0) {
    return { startIndex: 0, endIndex: 0, topPadPx: 0, bottomPadPx: 0, totalHeightPx: 0 };
  }
  const offset = clamp(scrollTop, 0, Math.max(0, totalHeightPx - viewportHeightPx));
  const firstVisible = Math.floor(offset / rowHeightPx);
  const lastVisible = Math.ceil((offset + viewportHeightPx) / rowHeightPx);
  const startIndex = clamp(firstVisible - overscanRows, 0, itemCount);
  const endIndex = clamp(lastVisible + overscanRows, startIndex, itemCount);
  return {
    startIndex,
    endIndex,
    topPadPx: startIndex * rowHeightPx,
    bottomPadPx: totalHeightPx - endIndex * rowHeightPx,
    totalHeightPx,
  };
}

/**
 * The scroll offset that brings `index` fully inside the scrollport, or the current one when it
 * already is.
 *
 * Keyboard navigation depends on this being exact, not approximate: `aria-activedescendant` can
 * only point at an element that exists, and with windowing an option exists only while it is in
 * range — so "scroll the active row into view" is what keeps the active descendant referencable.
 */
export function scrollTopForIndex({
  index,
  scrollTop,
  viewportHeightPx,
  rowHeightPx,
}: {
  index: number;
  scrollTop: number;
  viewportHeightPx: number;
  rowHeightPx: number;
}): number {
  const top = index * rowHeightPx;
  const bottom = top + rowHeightPx;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewportHeightPx) return bottom - viewportHeightPx;
  return scrollTop;
}

/**
 * Whether the next cursor page should be fetched now.
 *
 * Covers both ways the end of the loaded rows is approached — scrolling (`endIndex`) and arrowing
 * (`activeIndex`) — because paging off only the scroll position would strand a keyboard user who
 * holds ArrowDown at the last loaded row.
 */
export function needsNextPage({
  endIndex,
  activeIndex,
  itemCount,
  hasMore,
  prefetchRows,
}: {
  endIndex: number;
  activeIndex: number;
  itemCount: number;
  hasMore: boolean;
  prefetchRows: number;
}): boolean {
  if (!hasMore) return false;
  if (itemCount === 0) return true;
  const threshold = itemCount - prefetchRows;
  return endIndex >= threshold || activeIndex >= threshold;
}

/**
 * The active option after a navigation key, or null when the key is not one this list handles.
 *
 * Deliberately clamps instead of wrapping: the list is paged, so wrapping from the last loaded row
 * to the first would read as "you have reached the end" when more pages exist.
 */
export function nextActiveIndex(key: string, activeIndex: number, itemCount: number): number | null {
  if (itemCount <= 0) return null;
  const last = itemCount - 1;
  switch (key) {
    case 'ArrowDown':
      return clamp(activeIndex + 1, 0, last);
    case 'ArrowUp':
      return clamp(activeIndex - 1, 0, last);
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return null;
  }
}

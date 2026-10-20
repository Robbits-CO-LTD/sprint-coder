import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { clampSidebarWidth, maxSidebarWidth, SIDEBAR_MIN_WIDTH } from '../lib/sidebar-preference';

const KEY_STEP = 16;
const KEY_STEP_LARGE = 48;

// The draggable right edge of the sidebar: the WAI-ARIA window-splitter pattern, so it is a
// focusable `separator` with a value and works from the keyboard (arrows, Home/End) as well as by
// pointer. Dragging reports every intermediate width through `onResize` and the settled one through
// `onResizeEnd`, so the caller can repaint live but persist once. Double-click restores the default.

export function SidebarResizer({
  width,
  availableWidth,
  onResize,
  onResizeEnd,
  onReset,
}: {
  width: number;
  /** Room shared by the sidebar and the conversation (window minus any docked right panel). */
  availableWidth: number;
  onResize: (width: number) => void;
  onResizeEnd: (width: number) => void;
  onReset: () => void;
}) {
  const drag = useRef<{ startX: number; startWidth: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const onResizeEndRef = useRef(onResizeEnd);
  useEffect(() => {
    onResizeEndRef.current = onResizeEnd;
  }, [onResizeEnd]);

  // The handle can disappear mid-drag (⌘B collapses the sidebar, Team mode hides the chrome). A
  // detached element never receives its pointerup, so settle the drag here or the painted width
  // would never be saved.
  useEffect(
    () => () => {
      const current = drag.current;
      if (current === null) return;
      drag.current = null;
      onResizeEndRef.current(current.width);
    },
    [],
  );

  // While a drag is in flight the cursor must stay `col-resize` and text must not select, wherever
  // the pointer wanders — and an iframe (the graph panel) must not swallow the pointer stream.
  useEffect(() => {
    if (!dragging) return;
    document.body.classList.add('is-resizing-sidebar');
    return () => document.body.classList.remove('is-resizing-sidebar');
  }, [dragging]);

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width, width };
    setDragging(true);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (current === null) return;
    const next = clampSidebarWidth(
      current.startWidth + event.clientX - current.startX,
      availableWidth,
    );
    if (next === current.width) return;
    current.width = next;
    onResize(next);
  }

  function endDrag() {
    const current = drag.current;
    if (current === null) return;
    drag.current = null;
    setDragging(false);
    onResizeEnd(current.width);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = width - step;
    else if (event.key === 'ArrowRight') next = width + step;
    else if (event.key === 'Home') next = SIDEBAR_MIN_WIDTH;
    else if (event.key === 'End') next = maxSidebarWidth(availableWidth);
    if (next === null) return;
    event.preventDefault();
    const clamped = clampSidebarWidth(next, availableWidth);
    onResize(clamped);
    onResizeEnd(clamped);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Task履歴の幅"
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={maxSidebarWidth(availableWidth)}
      aria-valuenow={width}
      tabIndex={0}
      className={`sidebar-resizer${dragging ? ' is-dragging' : ''}`}
      data-testid="sidebar-resizer"
      title="ドラッグで幅を変更・ダブルクリックで元に戻す"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
    />
  );
}

import { useLayoutEffect, useState } from 'react';
import type { Ref, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ChatSurface } from './ChatSurface';
import type { TaskSummary } from '../../types/sprint-coder';

// SurfaceLayer: the "single resident ChatSurface instance" from ADR-002 / docs
// §4.6 ("ChatSurfaceのDOM subtreeを複製せず、SurfaceLayer内で同じinstanceを保つ"). It owns one
// host <div>, created exactly once (see `hostRef`) and portaled into via `createPortal`, and
// imperatively re-parents that same host between the two layouts' anchors — `mainAnchorRef` for
// the normal Chat column, `leaderAnchorRef` for the Team Canvas Leader node — instead of ever
// letting App/TeamCanvas unmount and remount the React tree underneath. `mode` both selects the
// anchor and is forwarded to ChatSurface as `variant`; that is the only thing that changes on
// the live instance, since Timeline/Composer/ContextBar key off `taskId`, not layout.

function createHost(): HTMLDivElement {
  const host = document.createElement('div');
  // Transparent to layout in both anchors (see `.surface-anchor`/`.leader-anchor`/`.surface-host`
  // in index.css) — moving this node between them must be visually invisible.
  host.className = 'surface-host';
  return host;
}

function isTextInput(el: Element | null): el is HTMLTextAreaElement | HTMLInputElement {
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement;
}

export type CapturedSurfaceState = {
  focused: HTMLElement | null;
  selection: { start: number | null; end: number | null } | null;
  scrollEl: HTMLElement | null;
  scrollTop: number | null;
};

// Snapshot the bits of DOM state a synchronous `appendChild` re-parent can disturb (Slice 6.2
// item 3: scroll position, composer focus + selection). Draft text is store-persisted already
// (see Composer/appStore), so it needs no capture here.
//
// NOT capturable: an in-flight IME composition. Re-parenting an element mid-composition resets
// the browser's composition state — there is no DOM API to snapshot or resume it. This is an
// accepted platform limitation for this gate (documented in the Slice 6.2 task write-up as
// "IME連続性" bound), not something restoreSurfaceState can work around.
export function captureSurfaceState(host: HTMLElement): CapturedSurfaceState {
  const active = document.activeElement;
  const focused = active instanceof HTMLElement && host.contains(active) ? active : null;
  const selection = isTextInput(focused)
    ? { start: focused.selectionStart, end: focused.selectionEnd }
    : null;
  const scrollEl = host.querySelector<HTMLElement>('.timeline-scroll');
  return { focused, selection, scrollEl, scrollTop: scrollEl ? scrollEl.scrollTop : null };
}

function restoreSurfaceState(state: CapturedSurfaceState): void {
  if (state.scrollEl && state.scrollTop !== null) {
    state.scrollEl.scrollTop = state.scrollTop;
  }
  if (state.focused && document.contains(state.focused)) {
    state.focused.focus({ preventScroll: true });
    if (state.selection && isTextInput(state.focused)) {
      const { start, end } = state.selection;
      if (start !== null && end !== null) state.focused.setSelectionRange(start, end);
    }
  }
}

export function SurfaceLayer({
  task,
  mode,
  mainAnchorRef,
  leaderAnchorRef,
  surfaceRef,
  surfaceId,
  pendingCaptureRef,
}: {
  task: TaskSummary;
  mode: 'main' | 'node';
  mainAnchorRef: RefObject<HTMLDivElement | null>;
  leaderAnchorRef: RefObject<HTMLDivElement | null>;
  surfaceRef?: Ref<HTMLDivElement> | undefined;
  surfaceId?: string | undefined;
  /**
   * Optional pre-captured snapshot (see App.tsx's `requestExitTeam`), consumed and cleared by
   * the move effect below instead of capturing fresh. Needed because *removing* `.surface--node`
   * (main variant's default, flex-context-dependent sizing) and physically moving the host are
   * two separate steps — React applies the className change during this same commit's mutation
   * phase, strictly before this layout effect runs, so a same-effect capture would already be
   * reading a transiently mis-parented, mis-sized `.timeline-scroll` (still under the *old*
   * anchor, but with the *new* variant's non-fixed-size layout), which forces scrollTop to 0
   * before we ever get to read it. Capturing eagerly — synchronously, before `mode` even
   * changes — sidesteps that window entirely. Entering doesn't need this: *adding*
   * `.surface--node` sets an explicit fixed 720x620 box that doesn't depend on the surrounding
   * flex context, so the same transient mis-parenting there never changes the timeline's
   * measured height.
   */
  pendingCaptureRef?: RefObject<CapturedSurfaceState | null> | undefined;
}) {
  // `useState` (not `useRef`): the portal target has to be read during render (createPortal's
  // second argument, below) — react-hooks/refs flags a `ref.current` read at render time even
  // for a value that, as here, never actually changes across renders. State is the correct tool
  // for "a value read during render that's computed exactly once" (the lazy initializer form
  // guarantees `createHost()` only ever runs on first render); the setter is simply never called,
  // so this node is the one-and-only, never-recreated host for this SurfaceLayer's lifetime.
  const [host] = useState(createHost);

  // Re-parent the host synchronously, before paint, whenever `mode` flips. The target anchor is
  // read from the ref's `.current` *inside* the effect rather than computed during render, so
  // this always sees whichever anchor mounted in the same commit as the `mode` change — React
  // runs layout effects for an entire commit only after every ref in that commit has attached,
  // regardless of component order (App mounts/unmounts TeamCanvas's leader anchor in the same
  // commit that flips `mode`; see App.tsx's morph orchestration).
  useLayoutEffect(() => {
    const anchor = mode === 'node' ? leaderAnchorRef.current : mainAnchorRef.current;
    if (!anchor || host.parentElement === anchor) return;
    const captured = pendingCaptureRef?.current ?? captureSurfaceState(host);
    if (pendingCaptureRef) pendingCaptureRef.current = null;
    anchor.appendChild(host);
    restoreSurfaceState(captured);
  }, [mode, mainAnchorRef, leaderAnchorRef, host, pendingCaptureRef]);

  return createPortal(<ChatSurface task={task} variant={mode} id={surfaceId} ref={surfaceRef} />, host);
}

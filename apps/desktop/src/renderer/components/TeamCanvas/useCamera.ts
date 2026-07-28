import { useCallback, useEffect, useRef } from 'react';
import { nextCameraOwner, shouldRunAutomaticMove } from './cameraOwnership';
import type { CameraOwner } from './cameraOwnership';

// Pannable/zoomable camera for the Team Canvas (demo/index.html lines 756-828). Mutates refs and
// writes directly to `style.transform`/`style.backgroundPosition` on every frame instead of
// going through React state — matching the mock's approach so pan/zoom stays smooth (60fps)
// without triggering component re-renders.

export type Rect = { x: number; y: number; w: number; h: number };
export type CamState = { x: number; y: number; s: number };

export const MIN_SCALE = 0.18;
export const MAX_SCALE = 1.6;
const DOT_GRID_PX = 26;

// LOD thresholds (FR-CAN-04): two steps as camera scale shrinks. Chosen so lod1 kicks in once
// Worker cards are small enough that body text stops being comfortably readable, and lod2 once
// even the head's sub-line would be illegible — comment mirrors the values in index.css's
// `[data-lod]` rules, which are the actual visual effect; this hook only owns the threshold math
// and the data-attribute write.
export const LOD1_MAX_SCALE = 0.55;
export const LOD2_MAX_SCALE = 0.32;

// How long after the last wheel tick a zoom is considered "settled" (used to fire onSettle for
// debounced canvas-view autosave — see TeamCanvas's scheduleSave). Wheel events have no native
// "end" signal, unlike pointerup for a pan drag, so this is a plain quiet-period debounce.
const WHEEL_SETTLE_MS = 260;

export function preservesNestedScroll(target: EventTarget | null): boolean {
  const element = target as { closest?: (selectors: string) => Element | null } | null;
  return (
    typeof element?.closest === 'function' && element.closest('.timeline-scroll, .w-body') !== null
  );
}

export function useCamera(onSettle?: () => void) {
  const canvasRef = useRef<HTMLElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const camRef = useRef<CamState>({ x: 0, y: 0, s: 1 });
  const animRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  // Reduced-motion (a11y fix, Phase 7 / NFR-A11Y-04): computed synchronously as the ref's initial
  // value, NOT in a `useEffect` (as this previously was). TeamCanvas's own camera-seed choreography
  // reads `isReduced()` from a `useLayoutEffect` in the SAME commit this hook mounts in — layout
  // effects always run before passive `useEffect`s for a given commit, so a plain `useEffect` here
  // could never win that race: on every single Team-mode entry (a fresh mount each time — see
  // App.tsx's `showTeamCanvas`), the seed-then-fly read `reducedRef.current` while it was still at
  // its default `false`, silently ignoring "prefers-reduced-motion: reduce" for that first,
  // choreographed camera move every time, no matter the OS setting. A synchronous initial value has
  // no such ordering to race. The `change` listener below then keeps it live for any *later* camera
  // move within the same mount, if the user toggles the OS setting mid-session.
  const reducedRef = useRef(
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const lodRef = useRef<'0' | '1' | '2'>('0');
  const wheelSettleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSettleRef = useRef(onSettle);
  // CameraDirector ownership (Slice 6.3 item 2) — see cameraOwnership.ts for the transition rule.
  const ownerRef = useRef<CameraOwner>('system');

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedRef.current = media.matches; // keep in sync in case it changed between mount and here
    const onChange = (e: MediaQueryListEvent) => {
      reducedRef.current = e.matches;
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  // Mirrors ownership onto a dev-only data attribute on the canvas root so e2e/tests can assert
  // it directly (`data-camera-owner="system" | "user"`) without instrumenting internals.
  const writeOwnerAttribute = useCallback((owner: CameraOwner) => {
    if (canvasRef.current) canvasRef.current.dataset.cameraOwner = owner;
  }, []);

  useEffect(() => {
    writeOwnerAttribute(ownerRef.current);
  }, [writeOwnerAttribute]);

  // Mirror the latest `onSettle` into a ref inside an effect (not read/written during render
  // itself, per react-hooks/refs) so the pointer/wheel/animateCamTo callbacks below — which are
  // created once and closed over this ref, not over `onSettle` directly — always invoke whatever
  // the caller's most recent callback identity is.
  useEffect(() => {
    onSettleRef.current = onSettle;
  });

  const isReduced = useCallback(() => reducedRef.current, []);

  const applyCam = useCallback(() => {
    const world = worldRef.current;
    const canvas = canvasRef.current;
    if (!world || !canvas) return;
    const { x, y, s } = camRef.current;
    world.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    canvas.style.backgroundPosition = `${x}px ${y}px`;
    canvas.style.backgroundSize = `${DOT_GRID_PX * s}px ${DOT_GRID_PX * s}px`;
    // Toggle the LOD data-attribute only when the step actually changes — CSS (`[data-lod]` rules
    // in index.css) does the rest, so this never causes per-frame layout churn beyond one DOM
    // write at the moment a threshold is crossed.
    const nextLod = s < LOD2_MAX_SCALE ? '2' : s < LOD1_MAX_SCALE ? '1' : '0';
    if (lodRef.current !== nextLod) {
      lodRef.current = nextLod;
      canvas.dataset.lod = nextLod;
    }
  }, []);

  const cancelCamAnim = useCallback(() => {
    if (animRef.current !== null) {
      cancelAnimationFrame(animRef.current);
      animRef.current = null;
    }
  }, []);

  // ANY manual input (pan start, wheel zoom, node drag start) claims 'user' ownership and cancels
  // whatever system animation is in flight — the viewport freezes exactly where it currently is
  // rather than snapping anywhere. Callers of the camera hook (TeamCanvas) call this from their
  // own node-drag pointerdown handler too; the pan/wheel handlers below call it directly.
  const claimUserOwnership = useCallback(() => {
    cancelCamAnim();
    ownerRef.current = nextCameraOwner(ownerRef.current, 'manual-input');
    writeOwnerAttribute(ownerRef.current);
  }, [cancelCamAnim, writeOwnerAttribute]);

  // Explicit user view commands (Fit view, Leaderへ, Enter-focus, keyboard f/l) always execute
  // and hand ownership back to 'system' — call this immediately before animating.
  const claimSystemOwnership = useCallback(() => {
    ownerRef.current = nextCameraOwner(ownerRef.current, 'explicit-command');
    writeOwnerAttribute(ownerRef.current);
  }, [writeOwnerAttribute]);

  // Gate for every *automatic* move (spawn-follow, scheduleFit, the saved-view redirect, ...):
  // these must no-op once the user owns the camera, instead of fighting a manual pan/zoom/drag.
  const isSystemOwned = useCallback(() => shouldRunAutomaticMove(ownerRef.current), []);

  const animateCamTo = useCallback(
    (target: CamState, dur = 560, opts?: { silent?: boolean }): Promise<void> => {
      cancelCamAnim();
      if (reducedRef.current) {
        camRef.current = { ...target };
        applyCam();
        if (!opts?.silent) onSettleRef.current?.();
        return Promise.resolve();
      }
      const from = { ...camRef.current };
      const ease = (t: number) => 1 - Math.pow(1 - t, 3);
      return new Promise((resolve) => {
        const t0 = performance.now();
        const step = (now: number) => {
          const t = Math.min(1, (now - t0) / dur);
          const e = ease(t);
          camRef.current = {
            x: from.x + (target.x - from.x) * e,
            y: from.y + (target.y - from.y) * e,
            s: from.s + (target.s - from.s) * e,
          };
          applyCam();
          if (t < 1) {
            animRef.current = requestAnimationFrame(step);
          } else {
            animRef.current = null;
            if (!opts?.silent) onSettleRef.current?.();
            resolve();
          }
        };
        animRef.current = requestAnimationFrame(step);
      });
    },
    [applyCam, cancelCamAnim],
  );

  const worldRectOf = useCallback(
    (el: HTMLElement): Rect => ({
      x: el.offsetLeft,
      y: el.offsetTop,
      w: el.offsetWidth,
      h: el.offsetHeight,
    }),
    [],
  );

  const camToFit = useCallback((rects: Rect[], pad = 90): CamState => {
    const canvas = canvasRef.current;
    const minX = Math.min(...rects.map((r) => r.x)) - pad;
    const minY = Math.min(...rects.map((r) => r.y)) - pad;
    const maxX = Math.max(...rects.map((r) => r.x + r.w)) + pad;
    const maxY = Math.max(...rects.map((r) => r.y + r.h)) + pad;
    const vw = canvas?.clientWidth ?? 1;
    const vh = canvas?.clientHeight ?? 1;
    const s = Math.min(vw / (maxX - minX), vh / (maxY - minY), 1.4);
    return {
      s,
      x: (vw - (maxX - minX) * s) / 2 - minX * s,
      y: (vh - (maxY - minY) * s) / 2 - minY * s,
    };
  }, []);

  const camToFocus = useCallback((rect: Rect, occupancy = 0.7): CamState => {
    const canvas = canvasRef.current;
    const vw = canvas?.clientWidth ?? 1;
    const vh = canvas?.clientHeight ?? 1;
    const s = Math.min((vh * occupancy) / rect.h, (vw * occupancy) / rect.w, 1.3);
    return { s, x: vw / 2 - (rect.x + rect.w / 2) * s, y: vh / 2 - (rect.y + rect.h / 2) * s };
  }, []);

  // Pan (drag) & zoom (wheel/pinch). Attached once — canvasRef is expected to stay attached to
  // the same `.team-canvas` root for the lifetime of this hook instance.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let dragging: { x: number; y: number; cx: number; cy: number } | null = null;

    function onPointerDown(e: PointerEvent) {
      const target = e.target as HTMLElement;
      // Ignore drags that start on the Leader node, a worker/hire card, or the header/controls
      // overlays — those need normal click/type interaction, not canvas panning (mock lines
      // 802-807). In the mock, the header/controls overlays are DOM *siblings* of the pannable
      // canvas layer, so they never reach this listener at all; here everything shares one
      // `.team-canvas` root (so `data-testid="team-list"` can gate on a single element), so the
      // overlays must be excluded explicitly instead.
      if (
        target.closest('.surface--node') ||
        target.closest('.worker') ||
        target.closest('.team-header-overlay') ||
        target.closest('.team-canvas-controls') ||
        target.closest('.team-policy-dialog')
      )
        return;
      claimUserOwnership(); // manual input: cancels any in-flight system animation, keeps the view
      dragging = { x: e.clientX, y: e.clientY, cx: camRef.current.x, cy: camRef.current.y };
      draggingRef.current = true;
      canvas!.setPointerCapture(e.pointerId);
    }
    function onPointerMove(e: PointerEvent) {
      if (!dragging) return;
      camRef.current = {
        ...camRef.current,
        x: dragging.cx + (e.clientX - dragging.x),
        y: dragging.cy + (e.clientY - dragging.y),
      };
      applyCam();
    }
    function onPointerUp() {
      const wasDragging = dragging !== null;
      dragging = null;
      draggingRef.current = false;
      // Pan end: notify only if a pan actually happened (not every stray pointerup on the canvas).
      if (wasDragging) onSettleRef.current?.();
    }
    function onWheel(e: WheelEvent) {
      // The Leader timeline and Worker report body are scrollports inside the canvas. Let their
      // native vertical scrolling win instead of turning the same wheel gesture into camera zoom.
      // `overscroll-behavior: contain` on both scrollports prevents a gesture at either edge from
      // chaining into the canvas or the surrounding app.
      if (preservesNestedScroll(e.target)) return;
      e.preventDefault();
      claimUserOwnership(); // manual input: same ownership claim as a pan start, every tick
      const current = camRef.current;
      if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016));
        const ns = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.s * k));
        camRef.current = {
          x: e.clientX - (e.clientX - current.x) * (ns / current.s),
          y: e.clientY - (e.clientY - current.y) * (ns / current.s),
          s: ns,
        };
      } else {
        camRef.current = { ...current, x: current.x - e.deltaX };
      }
      applyCam();
      // Zoom "end" via quiet-period debounce (wheel has no native end event, unlike pointerup).
      if (wheelSettleTimeoutRef.current) clearTimeout(wheelSettleTimeoutRef.current);
      wheelSettleTimeoutRef.current = setTimeout(() => {
        wheelSettleTimeoutRef.current = null;
        onSettleRef.current?.();
      }, WHEEL_SETTLE_MS);
    }

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      if (wheelSettleTimeoutRef.current) clearTimeout(wheelSettleTimeoutRef.current);
    };
  }, [applyCam, claimUserOwnership]);

  return {
    canvasRef,
    worldRef,
    camRef,
    draggingRef,
    isReduced,
    applyCam,
    cancelCamAnim,
    animateCamTo,
    camToFit,
    camToFocus,
    worldRectOf,
    claimUserOwnership,
    claimSystemOwnership,
    isSystemOwned,
  };
}

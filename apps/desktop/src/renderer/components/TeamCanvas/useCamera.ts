import { useCallback, useEffect, useRef } from 'react';

// Pannable/zoomable camera for the Team Canvas (demo/index.html lines 756-828). Mutates refs and
// writes directly to `style.transform`/`style.backgroundPosition` on every frame instead of
// going through React state — matching the mock's approach so pan/zoom stays smooth (60fps)
// without triggering component re-renders.

export type Rect = { x: number; y: number; w: number; h: number };
export type CamState = { x: number; y: number; s: number };

const MIN_SCALE = 0.18;
const MAX_SCALE = 1.6;
const DOT_GRID_PX = 26;

export function useCamera() {
  const canvasRef = useRef<HTMLElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const camRef = useRef<CamState>({ x: 0, y: 0, s: 1 });
  const animRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  const reducedRef = useRef(false);

  useEffect(() => {
    reducedRef.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  const isReduced = useCallback(() => reducedRef.current, []);

  const applyCam = useCallback(() => {
    const world = worldRef.current;
    const canvas = canvasRef.current;
    if (!world || !canvas) return;
    const { x, y, s } = camRef.current;
    world.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    canvas.style.backgroundPosition = `${x}px ${y}px`;
    canvas.style.backgroundSize = `${DOT_GRID_PX * s}px ${DOT_GRID_PX * s}px`;
  }, []);

  const cancelCamAnim = useCallback(() => {
    if (animRef.current !== null) {
      cancelAnimationFrame(animRef.current);
      animRef.current = null;
    }
  }, []);

  const animateCamTo = useCallback(
    (target: CamState, dur = 560): Promise<void> => {
      cancelCamAnim();
      if (reducedRef.current) {
        camRef.current = { ...target };
        applyCam();
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
        target.closest('.team-canvas-controls')
      )
        return;
      cancelCamAnim();
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
      dragging = null;
      draggingRef.current = false;
    }
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      cancelCamAnim();
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
    };
  }, [applyCam, cancelCamAnim]);

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
  };
}

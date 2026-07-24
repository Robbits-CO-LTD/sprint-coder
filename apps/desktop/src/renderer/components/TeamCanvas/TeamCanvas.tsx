import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, Ref, RefObject } from 'react';
import { useAppStore } from '../../store/appStore';
import { WorkerNode } from './WorkerNode';
import { HireNode } from './HireNode';
import { useCamera } from './useCamera';
import type { CamState, Rect } from './useCamera';
import { sendCable } from './cables';
import type { TaskSummary, TeamDetail, TeamMessageSummary } from '../../types/sprint-coder';

// Team Canvas: the spatial "promoted chat" experience from demo/index.html (§Team mode,
// lines 104-145 / 346-405 / 756-961). The Leader node is the app-root SurfaceLayer's ChatSurface
// instance (variant="node"), re-parented into `leaderAnchorRef` by App — see SurfaceLayer.tsx and
// App.tsx's morph orchestration; this component only owns the anchor slot, camera, Worker nodes,
// and the cable overlay between them. Camera state lives in refs (useCamera) so pan/zoom stays
// smooth.

const LEADER_RECT: Rect = { x: 0, y: 0, w: 720, h: 620 };
const WORKER_SLOTS: readonly Rect[] = [
  { x: 960, y: -70, w: 480, h: 260 },
  { x: 1000, y: 420, w: 480, h: 260 },
  { x: 440, y: 760, w: 480, h: 260 },
];
const MAX_WORKERS = WORKER_SLOTS.length;

function slotFor(index: number): { x: number; y: number } {
  const clamped = Math.max(0, Math.min(index, WORKER_SLOTS.length - 1));
  const slot = WORKER_SLOTS[clamped];
  return slot ? { x: slot.x, y: slot.y } : { x: 0, y: 0 };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The seed camera state (docs §4.6 step 3 / demo/index.html lines 936-951): positions the world
// so the fixed-size Leader node lands exactly where the normal chat column used to be —
// sidebar width 264 / header height 52, the mock's own fallback constants (the real chat
// surface's rect isn't reliably measurable at this point; see the enter effect below). Shared by
// the entering seed-then-fly AND the exiting reverse-fly (`playExitAnimation`), since the latter
// is the former run backwards to the same physical rect.
function seedCamState(): CamState {
  const rectA = {
    left: 264,
    top: 52,
    width: Math.max(720, window.innerWidth - 264),
    height: Math.max(480, window.innerHeight - 52),
  };
  return { x: rectA.left, y: rectA.top, s: rectA.width / 720 };
}

// Imperative surface exposed to App's morph orchestration (requestExitTeam/requestEnterTeam) —
// the camera lives inside this component's `useCamera()` instance, so the reverse FLIP has to be
// triggered from here rather than re-derived at the App level.
export interface TeamCanvasHandle {
  /** Stop whatever camera animation is in flight (enter-fly or exit-fly) immediately, wherever
   * it currently is. Used when the two directions interrupt each other mid-flight. */
  cancelCameraAnimation(): void;
  /** Reverse FLIP (docs §4.6 run backwards): fly the camera from its current position back to
   * the seed rect (the Leader node visually "expands back" to where the chat column was), then
   * fade the whole canvas out. Resolves once both finish; instant under reduced motion. */
  playExitAnimation(): Promise<void>;
  /** Re-settle the camera to a normal in-Team-mode view and clear the fade-out. Used when an
   * in-flight exit is cancelled (Team re-requested mid-exit) so the canvas doesn't stay parked
   * at the exit's seed position or faded out. */
  resettle(): void;
}

export function TeamCanvas({
  task,
  leaderRef,
  leaderAnchorRef,
  onRequestExit,
  onSwitchToListView,
  ref,
}: {
  task: TaskSummary;
  leaderRef: RefObject<HTMLDivElement | null>;
  leaderAnchorRef: RefObject<HTMLDivElement | null>;
  /** Requests the reverse-FLIP exit (App's morph orchestration) instead of flipping the store
   * directly — the store toggle itself is delayed until after the exit animation settles, see
   * App.tsx's `requestExitTeam`. */
  onRequestExit: () => void;
  /** Switches the renderer-only Team view preference to 'list' (Slice 6.1 list fallback). Canvas
   * itself doesn't own that preference — App does — this is just the header toggle button. */
  onSwitchToListView: () => void;
  ref?: Ref<TeamCanvasHandle>;
}) {
  const detail = useAppStore((s) => s.teamByTask[task.id]);
  const teamBusy = useAppStore((s) => s.teamBusy);
  const hireTeamWorker = useAppStore((s) => s.hireTeamWorker);
  const sendTeamMessage = useAppStore((s) => s.sendTeamMessage);
  const stopTeamWorker = useAppStore((s) => s.stopTeamWorker);
  const stopAllTeamWorkers = useAppStore((s) => s.stopAllTeamWorkers);

  // Stable indirection into the (not-yet-defined-at-this-point) autosave scheduler, so it can be
  // passed into useCamera() before `scheduleSave` itself exists — see the `useEffect` near
  // `scheduleSave`'s definition below that keeps this ref current. useCamera mirrors whatever
  // function this points to into its own ref (also via an effect), so identity churn here is free.
  const handleSettleRef = useRef<() => void>(() => {});
  const handleCameraSettle = useCallback(() => handleSettleRef.current(), []);

  const {
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
  } = useCamera(handleCameraSettle);

  const hireRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const workerElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  // Re-entering Team mode remounts this component from scratch, so `seenWorkerIdsRef` would
  // otherwise start empty — treating every pre-existing Worker as a brand-new spawn on re-entry
  // (replaying the blur/scale entrance + a camera follow). Pre-seed it with whichever Worker ids
  // are already present in `detail` at the moment this ref is first constructed (the initial
  // render), so only Workers that appear in a *later* store update go through `handleWorkerRef`'s
  // spawn treatment. This has to be the ref's *initial value* rather than a `.current` read/write
  // in the render body — mutating `.current` during render is not allowed (react-hooks/refs); an
  // initializer expression is a plain value construction, not a ref access.
  const seenWorkerIdsRef = useRef<Set<string>>(
    new Set(detail ? detail.workers.filter((w) => w.kind === 'worker').map((w) => w.id) : []),
  );
  const fitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialCameraSetRef = useRef(false);
  const cableQueueRef = useRef<TeamMessageSummary[]>([]);
  const cablePlayingRef = useRef(false);
  const cableCancelledRef = useRef(false);
  const lastEnqueuedSeqRef = useRef(0);
  const seqInitializedRef = useRef(false);

  // --- Canvas view persistence (Slice 6.1, FR-CAN-02) ---
  //
  // Node positions live in React state (they drive WorkerNode's `style.left/top`, so they must be
  // render-visible) but everything about *saving* them is imperative — a ref mirror avoids stale
  // closures inside the debounce timeout, and the actual IPC calls never go through zustand (the
  // task's "keep it out of render state" guidance): this component talks to
  // `window.sprintCoder.teams.getCanvasView/saveCanvasView` directly.
  const [nodePositions, setNodePositions] = useState<Record<string, { x: number; y: number }>>({});
  const nodePositionsRef = useRef(nodePositions);
  useEffect(() => {
    nodePositionsRef.current = nodePositions;
  }, [nodePositions]);
  const canvasViewRevisionRef = useRef(0);
  const canvasViewLoadedRef = useRef(false);
  const savedCameraRef = useRef<CamState | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nodeDraggingRef = useRef<{
    agentId: string;
    pointerId: number;
    originClientX: number;
    originClientY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const workers = useMemo(
    () =>
      detail
        ? [...detail.workers]
            .filter((w) => w.kind === 'worker')
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        : [],
    [detail],
  );
  const workerCount = workers.length;
  const hireVisible =
    !!detail &&
    workerCount < MAX_WORKERS &&
    detail.team.state !== 'completed' &&
    detail.team.state !== 'failed';

  const collectRects = useCallback((): Rect[] => {
    const rects: Rect[] = [LEADER_RECT];
    workerElsRef.current.forEach((el) => rects.push(worldRectOf(el)));
    if (hireRef.current) rects.push(worldRectOf(hireRef.current));
    return rects;
  }, [worldRectOf]);

  const scheduleFit = useCallback(() => {
    if (fitTimeoutRef.current) clearTimeout(fitTimeoutRef.current);
    fitTimeoutRef.current = setTimeout(() => {
      fitTimeoutRef.current = null;
      if (draggingRef.current) return;
      void animateCamTo(camToFit(collectRects()), isReduced() ? 0 : 600);
    }, 900);
  }, [animateCamTo, camToFit, collectRects, isReduced, draggingRef]);

  // Ref callback invoked by React at commit time (never during render) when a Worker card
  // mounts/unmounts. Kept as a single stable function — the per-worker id is bound via a small
  // inline arrow at the call site — so no ref is read while rendering (react-hooks/refs).
  const handleWorkerRef = useCallback(
    (workerId: string, el: HTMLDivElement | null) => {
      if (!el) {
        workerElsRef.current.delete(workerId);
        return;
      }
      workerElsRef.current.set(workerId, el);
      if (seenWorkerIdsRef.current.has(workerId)) return;
      seenWorkerIdsRef.current.add(workerId);
      el.classList.add('spawn');
      // Camera follows the newly spawned Worker briefly (mock lines 968-976), then settles
      // back to a view that fits everything (scheduleFit) so nothing is left off-screen. Skip
      // the follow if the user is mid-drag (mock's `if (!dragging)` guard, lines 972-973).
      setTimeout(() => {
        if (draggingRef.current) return;
        void animateCamTo(camToFocus(worldRectOf(el), 0.62), isReduced() ? 0 : 480);
      }, 120);
      scheduleFit();
    },
    [animateCamTo, camToFocus, worldRectOf, isReduced, scheduleFit, draggingRef],
  );

  // Initial camera: mirrors the mock's promoteToTeam choreography (demo/index.html lines
  // 929-961) — seed the camera so the Leader node first renders exactly where the chat surface
  // used to sit, then fly to a settled view that includes the Leader plus whatever is
  // immediately actionable (existing Workers / the hire ghost node).
  //
  // Runs in `useLayoutEffect` (synchronous, before paint) rather than `useEffect`+rAF: by commit
  // time all child refs (Leader/Worker/hire nodes) are already attached, so rects are accurate
  // immediately, and seeding the camera here means the very first paint already shows the seed
  // position — no flash of the identity transform.
  //
  // Depend on a stable boolean (not `detail` itself): `detail` is a fresh object on every store
  // update (e.g. the Team subscription firing again right after promote/toggle), which would
  // re-run this effect on every such update. The `initialCameraSetRef` guard makes it a true
  // one-shot regardless of how many times `detail` changes afterward.
  const hasDetail = detail != null;
  useLayoutEffect(() => {
    if (!hasDetail || initialCameraSetRef.current) return;
    // Matches every other automatic camera move: never fight an in-progress user drag. (In
    // practice unreachable at mount — there is no prior DOM for a drag to have started on — but
    // kept for consistency with scheduleFit/handleWorkerRef.)
    if (draggingRef.current) return;
    initialCameraSetRef.current = true;
    const rects = collectRects();
    const defaultTarget = rects.length > 1 ? camToFit(rects) : camToFocus(LEADER_RECT, 0.8);
    // If a saved canvas view (Slice 6.1) already resolved before this ran, settle there instead of
    // the default fit/focus — see the getCanvasView load effect below, which redirects the camera
    // itself if this effect already ran first (the far more common ordering, since IPC is async).
    const target = savedCameraRef.current ?? defaultTarget;
    // `silent: true` on every call in this effect: this is mount choreography (seed position,
    // restored/default settle), not a user-driven change worth persisting — see scheduleSave.
    if (isReduced()) {
      // Reduced motion: jump straight to the settled view — no seed-then-fly choreography.
      void animateCamTo(target, 0, { silent: true });
      return;
    }
    // Seed (mock lines 936-951): the mock measures the real chat surface's bounding rect via
    // FLIP, but by the time this effect runs the anchor move (SurfaceLayer) hasn't necessarily
    // painted yet either, so use the mock's own fallback constants directly (seedCamState).
    camRef.current = seedCamState();
    applyCam();
    void animateCamTo(target, 560, { silent: true });
  }, [
    hasDetail,
    draggingRef,
    collectRects,
    camToFit,
    camToFocus,
    animateCamTo,
    isReduced,
    camRef,
    applyCam,
  ]);

  // Load the saved canvas view (Slice 6.1) once per mount. Node positions merge in immediately
  // (new Worker cards not present in the saved map simply keep their default slot — "fixed slots
  // are defaults for NEW workers only"); the camera redirects to the saved position, silently, on
  // top of whatever the effect above already started flying to — IPC is async, so in practice this
  // almost always resolves partway through that flight rather than strictly before or after it.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const client = window.sprintCoder?.teams;
      if (!client?.getCanvasView) {
        canvasViewLoadedRef.current = true;
        return;
      }
      try {
        const saved = await client.getCanvasView(task.id);
        if (cancelled) return;
        if (saved) {
          canvasViewRevisionRef.current = saved.revision;
          setNodePositions((prev) => ({ ...saved.nodePositions, ...prev }));
          const restored: CamState = {
            x: saved.camera.x,
            y: saved.camera.y,
            s: saved.camera.scale,
          };
          savedCameraRef.current = restored;
          if (initialCameraSetRef.current && !draggingRef.current) {
            void animateCamTo(restored, isReduced() ? 0 : 420, { silent: true });
          }
        }
      } catch {
        // Best-effort restore only — fall back to the default fit/focus already in flight.
      } finally {
        if (!cancelled) canvasViewLoadedRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
    // Effectively a one-shot per mount: `task.id` is stable for this component's lifetime, and
    // `animateCamTo`/`isReduced`/`draggingRef` are all stable identities from useCamera (memoized
    // with empty/stable deps), so none of these ever actually change and re-trigger a refetch.
  }, [task.id, animateCamTo, isReduced, draggingRef]);

  // Exit choreography state: whether the canvas should be playing its fade-out (docs §4.6 run
  // backwards — see playExitAnimation below). A plain local boolean, not a prop, because the
  // fade must start only *after* the reverse camera fly settles, which this component alone
  // knows the timing of.
  const [exitingFade, setExitingFade] = useState(false);

  useImperativeHandle(
    ref,
    () => ({
      cancelCameraAnimation: cancelCamAnim,
      async playExitAnimation() {
        cancelCamAnim();
        const reduced = isReduced();
        // Silent: this flies to the seed rect purely as a visual trick for the exit choreography —
        // persisting it as "the" canvas view would overwrite the user's real last-viewed camera.
        await animateCamTo(seedCamState(), reduced ? 0 : 560, { silent: true });
        setExitingFade(true);
        if (!reduced) await sleep(220); // matches `.team-canvas.exiting`'s teamCanvasOut duration
      },
      resettle() {
        setExitingFade(false);
        const rects = collectRects();
        const target = rects.length > 1 ? camToFit(rects) : camToFocus(LEADER_RECT, 0.8);
        void animateCamTo(target, isReduced() ? 0 : 400, { silent: true });
      },
    }),
    [cancelCamAnim, animateCamTo, isReduced, collectRects, camToFit, camToFocus],
  );

  // --- Canvas view autosave (Slice 6.1) ---
  const performSave = useCallback(async () => {
    const client = window.sprintCoder?.teams;
    if (!client?.saveCanvasView) return;
    const payload = {
      taskId: task.id,
      camera: { x: camRef.current.x, y: camRef.current.y, scale: camRef.current.s },
      nodePositions: nodePositionsRef.current,
    };
    try {
      const result = await client.saveCanvasView({ ...payload, revision: canvasViewRevisionRef.current });
      canvasViewRevisionRef.current = result.revision;
    } catch {
      // Optimistic-concurrency conflict (or the first save racing a slow initial load): re-read
      // the authoritative revision and overwrite with the current local state. This is a
      // single-window app, so there is no other writer to lose data to — this is a deliberate
      // simplification, not a general CRDT-style merge (documented per the Slice 6.1 task notes).
      try {
        const fresh = await client.getCanvasView(task.id);
        canvasViewRevisionRef.current = fresh?.revision ?? 0;
        const retried = await client.saveCanvasView({
          ...payload,
          revision: canvasViewRevisionRef.current,
        });
        canvasViewRevisionRef.current = retried.revision;
      } catch {
        // Best-effort autosave only — never surface this to the user or interrupt interaction.
      }
    }
  }, [task.id, camRef]);

  const scheduleSave = useCallback(() => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    // A local named function (not the outer `scheduleSave` identifier) so the retry below is a
    // plain closure recursion, not a hook referencing its own reactive binding.
    const attempt = (delayMs: number) => {
      saveTimeoutRef.current = setTimeout(() => {
        saveTimeoutRef.current = null;
        if (draggingRef.current) return; // mid pan/drag — not settled yet
        if (!canvasViewLoadedRef.current) {
          // The initial getCanvasView load hasn't landed yet — saving now risks a stale revision
          // guess AND clobbering the not-yet-applied saved node positions with today's defaults.
          // Re-arm rather than drop the request; the load is a single fast local IPC round-trip
          // so this resolves within a poll or two in practice.
          attempt(200);
          return;
        }
        void performSave();
      }, delayMs);
    };
    attempt(800);
  }, [performSave, draggingRef]);

  // Keep the ref useCamera's `onSettle` actually calls pointed at the latest `scheduleSave` —
  // mirrored via effect (not written during render) per react-hooks/refs.
  useEffect(() => {
    handleSettleRef.current = scheduleSave;
  }, [scheduleSave]);

  // Flush a pending debounced save immediately on unmount (best-effort; fire-and-forget). Doesn't
  // special-case the Team-exit FLIP: `playExitAnimation`'s own camera fly is marked `silent`, so
  // it never itself schedules a save, and in practice any save armed by a real user action before
  // clicking "back" has already fired well before the ~780ms exit choreography finishes.
  useEffect(
    () => () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
        void performSave();
      }
    },
    [performSave],
  );

  // --- Worker node drag (Slice 6.1): reposition a Worker card by dragging its `.w-head`. ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function onPointerDown(e: PointerEvent) {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      // Buttons inside the head (停止) keep their normal click behaviour instead of starting a
      // drag. Camera panning is already a no-op anywhere inside `.worker` (see useCamera's own
      // pointerdown guard), so there is nothing to disambiguate against there.
      if (target.closest('button, textarea, input, a, select')) return;
      const head = target.closest('.w-head');
      if (!head) return;
      const card = head.closest<HTMLElement>('.worker');
      const agentId = card?.dataset.agentId;
      if (!card || !agentId || card.classList.contains('worker--hire')) return;
      const index = workers.findIndex((w) => w.id === agentId);
      const current = nodePositionsRef.current[agentId] ?? slotFor(Math.max(0, index));
      nodeDraggingRef.current = {
        agentId,
        pointerId: e.pointerId,
        originClientX: e.clientX,
        originClientY: e.clientY,
        originX: current.x,
        originY: current.y,
      };
      draggingRef.current = true; // reuse the camera's flag: pauses auto-follow/scheduleFit too
      card.classList.add('dragging');
      card.setPointerCapture(e.pointerId);
    }
    function onPointerMove(e: PointerEvent) {
      const drag = nodeDraggingRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      const scale = camRef.current.s || 1;
      const dx = (e.clientX - drag.originClientX) / scale;
      const dy = (e.clientY - drag.originClientY) / scale;
      setNodePositions((prev) => ({
        ...prev,
        [drag.agentId]: { x: drag.originX + dx, y: drag.originY + dy },
      }));
    }
    function onPointerEnd(e: PointerEvent) {
      const drag = nodeDraggingRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      nodeDraggingRef.current = null;
      draggingRef.current = false;
      workerElsRef.current.get(drag.agentId)?.classList.remove('dragging');
      scheduleSave();
    }

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerEnd);
    canvas.addEventListener('pointercancel', onPointerEnd);
    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerEnd);
      canvas.removeEventListener('pointercancel', onPointerEnd);
    };
  }, [canvasRef, camRef, draggingRef, workers, scheduleSave]);

  const pumpCables = useCallback(() => {
    if (cablePlayingRef.current) return;
    cablePlayingRef.current = true;
    void (async () => {
      while (cableQueueRef.current.length > 0) {
        if (cableCancelledRef.current) break;
        const message = cableQueueRef.current.shift();
        if (!message) break;
        const svg = svgRef.current;
        const leaderEl = leaderRef.current;
        if (!svg || !leaderEl) continue;
        const fromLeader = message.sourceKind === 'leader';
        const workerId = fromLeader ? message.targetAgentId : message.sourceAgentId;
        const workerEl = workerElsRef.current.get(workerId);
        if (!workerEl) continue;
        const fromEl = fromLeader ? leaderEl : workerEl;
        const toEl = fromLeader ? workerEl : leaderEl;
        const toHead = fromLeader
          ? workerEl.querySelector<HTMLElement>('.w-head')
          : leaderEl.querySelector<HTMLElement>('.surface-header');
        // Cables must animate in message order, one at a time — intentionally sequential.
        await sendCable(svg, worldRectOf(fromEl), worldRectOf(toEl), toHead, {
          reverse: !fromLeader,
          reduced: isReduced(),
        });
      }
      cablePlayingRef.current = false;
    })();
  }, [worldRectOf, isReduced, leaderRef]);

  // Cable animations: enqueue newly observed Team messages (oldest to newest) onto a persistent
  // queue and (re)start the pump if it's idle. Messages already present when the canvas first
  // mounts (e.g. a Team restored after restart) are treated as baseline history and are not
  // re-animated.
  //
  // Enqueueing is deliberately decoupled from playback: `lastEnqueuedSeqRef` advances as soon as
  // a message is queued (not after it plays), and only unmounting cancels the pump. Previously
  // this effect ran its own sequential player and canceled it on every re-render/cleanup, which —
  // combined with advancing the seq watermark for the *whole* batch before playback — meant a
  // fast-arriving next batch would cancel an in-flight sequence partway through and its
  // still-unplayed messages could never replay (their seqs were already marked seen). Re-renders
  // must never cancel or skip queued cables; only the unmount effect below does.
  useEffect(() => {
    if (!detail) return;
    if (!seqInitializedRef.current) {
      seqInitializedRef.current = true;
      lastEnqueuedSeqRef.current = detail.messages.reduce((max, m) => Math.max(max, m.seq), 0);
      return;
    }
    const pending = detail.messages
      .filter((m) => m.seq > lastEnqueuedSeqRef.current)
      .sort((a, b) => a.seq - b.seq);
    if (pending.length === 0) return;
    lastEnqueuedSeqRef.current = pending.reduce(
      (max, m) => Math.max(max, m.seq),
      lastEnqueuedSeqRef.current,
    );
    cableQueueRef.current.push(...pending);
    pumpCables();
  }, [detail, pumpCables]);

  useEffect(
    () => () => {
      if (fitTimeoutRef.current) clearTimeout(fitTimeoutRef.current);
      cableCancelledRef.current = true;
    },
    [],
  );

  // --- Canvas keyboard navigation (Slice 6.1) ---
  const leaderAgentId = detail?.team.leaderAgentId;
  const nodeIds = useMemo(() => {
    const ids: string[] = [];
    if (leaderAgentId) ids.push(leaderAgentId);
    for (const worker of workers) ids.push(worker.id);
    if (hireVisible) ids.push('hire');
    return ids;
  }, [leaderAgentId, workers, hireVisible]);

  // Drop a selection that no longer refers to a navigable node (e.g. the hire slot disappearing
  // once the Worker cap is reached while it was selected). Render-time adjustment (not an effect
  // — react-hooks/set-state-in-effect convention, see TaskHeader/GoalChip) — bails out after the
  // one corrective re-render since `nodeIds` no longer contains the stale id.
  if (selectedNodeId !== null && !nodeIds.includes(selectedNodeId)) {
    setSelectedNodeId(null);
  }

  // Selection ring + aria-label on the Leader node: it's the portaled ChatSurface instance, not a
  // node this component renders itself, so this is imperative (matches cables.ts's `.glow` toggle
  // style) rather than a prop.
  useEffect(() => {
    const leaderEl = leaderRef.current;
    if (!leaderEl || !detail) return;
    leaderEl.classList.toggle('node-selected', selectedNodeId === detail.team.leaderAgentId);
    leaderEl.setAttribute('aria-label', `Leader · ${detail.team.state}`);
  }, [selectedNodeId, detail, leaderRef]);

  const rectForNode = useCallback(
    (nodeId: string): Rect => {
      if (nodeId === leaderAgentId) return LEADER_RECT;
      if (nodeId === 'hire') return hireRef.current ? worldRectOf(hireRef.current) : LEADER_RECT;
      const el = workerElsRef.current.get(nodeId);
      return el ? worldRectOf(el) : LEADER_RECT;
    },
    [leaderAgentId, worldRectOf],
  );

  const describeNode = useCallback(
    (nodeId: string): string => {
      if (nodeId === leaderAgentId) return 'Leader';
      if (nodeId === 'hire') return 'Workerを雇用';
      const worker = workers.find((w) => w.id === nodeId);
      return worker ? `${worker.role} (${worker.state})` : nodeId;
    },
    [leaderAgentId, workers],
  );

  // Moves DOM focus *into* the selected node's primary input (Enter's second effect, alongside
  // the camera focus below) — composer textarea for the Leader/a Worker, the hire form's first
  // field for the ghost node.
  const focusIntoNode = useCallback(
    (nodeId: string) => {
      if (nodeId === leaderAgentId) {
        leaderRef.current?.querySelector<HTMLElement>('.composer-input')?.focus();
        return;
      }
      if (nodeId === 'hire') {
        hireRef.current?.querySelector<HTMLElement>('input, textarea')?.focus();
        return;
      }
      workerElsRef.current.get(nodeId)?.querySelector<HTMLElement>('textarea')?.focus();
    },
    [leaderAgentId, leaderRef],
  );

  const moveSelection = useCallback(
    (direction: 1 | -1) => {
      if (nodeIds.length === 0) return;
      const currentIndex = selectedNodeId ? nodeIds.indexOf(selectedNodeId) : -1;
      const nextIndex = (currentIndex + direction + nodeIds.length) % nodeIds.length;
      setSelectedNodeId(nodeIds[nextIndex] ?? null);
    },
    [nodeIds, selectedNodeId],
  );

  const activateSelection = useCallback(() => {
    if (!selectedNodeId) return;
    void animateCamTo(camToFocus(rectForNode(selectedNodeId), 0.7), isReduced() ? 0 : 480);
    focusIntoNode(selectedNodeId);
  }, [selectedNodeId, animateCamTo, camToFocus, rectForNode, isReduced, focusIntoNode]);

  const handleCanvasKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>) => {
      if (e.key === 'Escape') {
        // Works even when a descendant (e.g. a Worker's 依頼 textarea) currently has focus —
        // Escape always returns keyboard focus to the canvas root itself.
        e.preventDefault();
        canvasRef.current?.focus();
        return;
      }
      // Every other shortcut only fires when the canvas root itself is the event target — i.e.
      // not while typing in a node's textarea/input, which would otherwise see its own "l"/"f"
      // keystrokes hijacked.
      if (e.target !== e.currentTarget) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault();
        moveSelection(1);
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
        e.preventDefault();
        moveSelection(-1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        activateSelection();
        return;
      }
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        void animateCamTo(camToFit(collectRects()), isReduced() ? 0 : 500);
        return;
      }
      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        if (leaderAgentId) setSelectedNodeId(leaderAgentId);
        void animateCamTo(camToFocus(LEADER_RECT, 0.8), isReduced() ? 0 : 500);
      }
    },
    [
      canvasRef,
      moveSelection,
      activateSelection,
      animateCamTo,
      camToFit,
      camToFocus,
      collectRects,
      isReduced,
      leaderAgentId,
    ],
  );

  // Deliberately worded differently from the visible `.team-status-chip` text below: Playwright's
  // getByText() is a substring match, so an aria-live region carrying the *exact same* string
  // would make `getByText('<state> · Worker N/3')` resolve to two elements (chip + live region).
  const selectionText = selectedNodeId ? `選択: ${describeNode(selectedNodeId)}` : '';
  const liveText = detail
    ? `Team status: ${detail.team.state}, workers ${workerCount} of ${MAX_WORKERS}${
        selectionText ? `. ${selectionText}` : ''
      }`
    : '';
  const hireSlot = slotFor(workerCount);

  return (
    <section
      className={`team-canvas${exitingFade ? ' exiting' : ''}`}
      ref={canvasRef}
      data-testid="team-list"
      aria-label="Team canvas"
      tabIndex={0}
      onKeyDown={handleCanvasKeyDown}
    >
      {!detail ? (
        <div className="team-canvas-notice">
          <div className="sys-notice">Teamを準備しています</div>
        </div>
      ) : (
        <>
          <div className="team-world" ref={worldRef}>
            <svg className="team-cables" ref={svgRef} viewBox="0 0 7000 6000" />
            <div className="team-world-nodes">
              {/* SurfaceLayer (owned by App) portals the shared ChatSurface instance in here —
                  this anchor only reserves the slot; see App.tsx's morph orchestration. */}
              <div className="leader-anchor" ref={leaderAnchorRef} />
              {workers.map((worker, index) => {
                const pos = nodePositions[worker.id] ?? slotFor(index);
                return (
                  <WorkerNode
                    key={worker.id}
                    worker={worker}
                    x={pos.x}
                    y={pos.y}
                    messages={detail.messages}
                    teamBusy={teamBusy}
                    selected={selectedNodeId === worker.id}
                    onSend={(content) => void sendTeamMessage(task.id, worker.id, content)}
                    onStop={() => void stopTeamWorker(task.id, worker.id)}
                    ref={(el) => handleWorkerRef(worker.id, el)}
                  />
                );
              })}
              {hireVisible && (
                <HireNode
                  x={hireSlot.x}
                  y={hireSlot.y}
                  teamBusy={teamBusy}
                  selected={selectedNodeId === 'hire'}
                  onHire={(role, objective) => void hireTeamWorker(task.id, role, objective)}
                  ref={hireRef}
                />
              )}
            </div>
          </div>

          <TeamHeaderOverlay
            task={task}
            detail={detail}
            workerCount={workerCount}
            teamBusy={teamBusy}
            onBack={onRequestExit}
            onStopAll={() => void stopAllTeamWorkers(task.id)}
            onSwitchToListView={onSwitchToListView}
          />

          <CanvasControlsOverlay
            onFit={() => void animateCamTo(camToFit(collectRects()), isReduced() ? 0 : 500)}
            onFocusLeader={() =>
              void animateCamTo(camToFocus(LEADER_RECT, 0.8), isReduced() ? 0 : 500)
            }
          />
        </>
      )}
      <div aria-live="polite" className="visually-hidden">
        {liveText}
      </div>
    </section>
  );
}

function TeamHeaderOverlay({
  task,
  detail,
  workerCount,
  teamBusy,
  onBack,
  onStopAll,
  onSwitchToListView,
}: {
  task: TaskSummary;
  detail: TeamDetail;
  workerCount: number;
  teamBusy: boolean;
  onBack: () => void;
  onStopAll: () => void;
  onSwitchToListView: () => void;
}) {
  return (
    <div className="team-header-overlay">
      <button type="button" className="team-back-btn" data-testid="team-back" onClick={onBack}>
        ← Chatに戻る
      </button>
      <span className="team-title">{task.title}</span>
      <span className="team-badge">Team · {workerCount} workers</span>
      <span className="team-status-chip">{`${detail.team.state} · Worker ${workerCount}/${MAX_WORKERS}`}</span>
      <button
        type="button"
        className="team-view-toggle-btn"
        data-testid="team-view-toggle"
        onClick={onSwitchToListView}
        title="Team List Viewに切り替え"
      >
        List表示
      </button>
      <button
        type="button"
        className="team-stop-all-btn"
        data-testid="team-stop-all"
        disabled={teamBusy || workerCount === 0 || detail.team.state === 'completed'}
        onClick={onStopAll}
      >
        すべて停止
      </button>
    </div>
  );
}

function CanvasControlsOverlay({
  onFit,
  onFocusLeader,
}: {
  onFit: () => void;
  onFocusLeader: () => void;
}) {
  return (
    <div className="team-canvas-controls">
      <div className="cc-row">
        <button type="button" className="cc-btn" data-testid="team-canvas-fit" onClick={onFit}>
          Fit view
        </button>
        <button
          type="button"
          className="cc-btn"
          data-testid="team-canvas-focus-leader"
          onClick={onFocusLeader}
        >
          Leaderへ
        </button>
      </div>
      <div className="cc-hint">
        ドラッグで移動 · ホイール/ピンチでズーム · ↑↓←→/Tabで選択 · Enterで開く · F: フィット ·
        L: Leaderへ · Esc: 選択解除
      </div>
    </div>
  );
}

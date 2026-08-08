import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, Ref, RefObject } from 'react';
import { useAppStore } from '../../store/appStore';
import { WorkerNode } from './WorkerNode';
import { useCamera } from './useCamera';
import teamCanvasNetwork from '../../../../assets/generated/team-canvas-network.webp';
import teamEmptyDocks from '../../../../assets/generated/team-empty-docks.webp';
import type { CamState, Rect } from './useCamera';
import { sendCable } from './cables';
import {
  LEADER_RECT,
  PLACEMENT_MARGIN,
  WORKER_SIZE,
  computeHierarchyLayout,
  findFreePosition,
  hierarchySlot,
  parentAgentOf,
} from './placement';
import { ArrowLeft, List } from '../icons';
import { TeamPolicyDialog, TeamPolicyTrigger } from '../TeamPolicyDialog';
import { latestExecutionForWorker } from '../../lib/team-execution-display';
import { currentTeamWorkerCount } from '../../lib/team-progress';
import type { TaskSummary, TeamDetail, TeamMessageSummary } from '../../types/sprint-coder';

// Team Canvas: the spatial "promoted chat" experience from demo/index.html (§Team mode,
// lines 104-145 / 346-405 / 756-961). The Leader node is the app-root SurfaceLayer's ChatSurface
// instance (variant="node"), re-parented into `leaderAnchorRef` by App — see SurfaceLayer.tsx and
// App.tsx's morph orchestration; this component only owns the anchor slot, camera, Worker nodes,
// and the cable overlay between them. Camera state lives in refs (useCamera) so pan/zoom stays
// smooth.

// Node geometry and default slots live in ./placement (pure, unit-tested). A Team is neither
// capped at three Workers nor flat any more: `computeHierarchyLayout` lays the recorded agent tree
// out as depth columns x sibling rows, so Leader -> Manager -> Worker reads left to right.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Static parent -> child connector geometry. Same anchor convention and the same +2000 world
// offset the animated cables use (cables.ts, matching `.team-cables`' left/top:-2000px in
// index.css), so a message cable travels along the connector it belongs to instead of a parallel
// line of its own.
const EDGE_OFFSET = 2000;
function hierarchyEdgePath(from: Rect, to: Rect): string {
  const a = { x: from.x + from.w, y: from.y + Math.min(90, from.h / 2) };
  const b = { x: to.x, y: to.y + Math.min(60, to.h / 2) };
  const dx = Math.max(70, Math.abs(b.x - a.x) * 0.45);
  const o = EDGE_OFFSET;
  return (
    `M ${a.x + o} ${a.y + o} C ${a.x + o + dx} ${a.y + o}, ` +
    `${b.x + o - dx} ${b.y + o}, ${b.x + o} ${b.y + o}`
  );
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
  const stopTeamWorker = useAppStore((s) => s.stopTeamWorker);
  const resumeTeamMission = useAppStore((s) => s.resumeTeamMission);
  const resumeTeamExecutionIntegration = useAppStore((s) => s.resumeTeamExecutionIntegration);
  const stopAllTeamWorkers = useAppStore((s) => s.stopAllTeamWorkers);
  const [policyOpen, setPolicyOpen] = useState(false);

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
    claimUserOwnership,
    claimSystemOwnership,
    isSystemOwned,
  } = useCamera(handleCameraSettle);

  const svgRef = useRef<SVGSVGElement>(null);
  const workerElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  // Collision-aware placement (Slice 6.3 item 1): positions handed out to a new Worker before it
  // has actually mounted (or before its DOM rect otherwise reflects it), so a second rapid
  // placement decision (the Leader hires several Workers back-to-back) doesn't pick the same
  // spot. Cleared for a Worker id the moment that Worker actually mounts — from then on its real
  // DOM rect (via `workerElsRef`) is authoritative.
  const reservedPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
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
  // Live lookup of each Team message's CURRENT row (Slice 6.4 item 4) — kept fresh on every store
  // update regardless of the cable queue, so a cable that's mid-flight (or holding, pre-ack) can
  // observe an ack/failure that arrives after it was enqueued instead of only ever seeing the
  // stale snapshot it was queued with.
  const messagesByIdRef = useRef<Map<string, TeamMessageSummary>>(new Map());
  // Transient textual event overlay (Slice 6.4 item 6, reduced motion) + its aria-live mirror
  // (always, every motion mode — see the render below).
  const [transientCableEvents, setTransientCableEvents] = useState<{ id: number; text: string }[]>(
    [],
  );
  const transientCableEventIdRef = useRef(0);
  const [cableAnnouncement, setCableAnnouncement] = useState('');
  // Textual canvas event (Slice 6.4 item 6, extended to hires per FR-TEAM-03): always mirrored to
  // the aria-live announcer (every motion mode — screen reader users get an announcement
  // regardless of animation); the small transient bottom-center overlay is otherwise
  // reduced-motion-only for CABLE events (in full motion, the cable animation itself is the
  // visible artifact) — callers that have no animation standing in for them (a Worker hire) pass
  // `visual: true` unconditionally instead.
  const announceCableEvent = useCallback((text: string, visual: boolean) => {
    setCableAnnouncement(text);
    if (!visual) return;
    const id = (transientCableEventIdRef.current += 1);
    setTransientCableEvents((prev) => [...prev, { id, text }]);
    setTimeout(() => {
      setTransientCableEvents((prev) => prev.filter((event) => event.id !== id));
    }, 3000);
  }, []);

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
  const workerCount = detail ? currentTeamWorkerCount(detail) : 0;
  const leaderAgentId = detail?.team.leaderAgentId;
  // Default (pre-drag, pre-restore) positions for every Worker, from the Team's recorded agent
  // tree — `workers` is already in stable creation order, which is the sibling order the layout
  // uses. A Worker with a saved/dragged position in `nodePositions` keeps that instead; this only
  // ever answers "where does a card go if nothing else has decided".
  const hierarchyLayout = useMemo(
    () => computeHierarchyLayout(leaderAgentId ?? null, workers),
    [leaderAgentId, workers],
  );
  const defaultPositionFor = useCallback(
    (workerId: string): { x: number; y: number } => {
      const placement = hierarchyLayout.get(workerId);
      if (placement) return { x: placement.x, y: placement.y };
      // Unreachable in practice (the layout is built from this same list), but a card must never
      // fall back to (0,0) — that is the Leader's own slot.
      const index = workers.findIndex((w) => w.id === workerId);
      return hierarchySlot(1, index < 0 ? 0 : index);
    },
    [hierarchyLayout, workers],
  );
  // Empty-team guidance (FR-TEAM-03/06): the Leader hires on its own once it decides a Task
  // needs a Team — there is nothing for the user to do here but ask the Leader for something, so
  // this hint only shows while there is genuinely nothing else to look at yet.
  const showEmptyTeamHint = !!detail && workerCount === 0;

  const collectRects = useCallback((): Rect[] => {
    const rects: Rect[] = [LEADER_RECT];
    workerElsRef.current.forEach((el) => rects.push(worldRectOf(el)));
    return rects;
  }, [worldRectOf]);

  // Rects to avoid when placing a NEW Worker (Slice 6.3 item 1): the Leader, every currently-
  // mounted Worker at its CURRENT (possibly dragged/persisted) position, and any position already
  // handed out to a not-yet-mounted Worker (`reservedPositionsRef`) — covers several placements
  // decided back-to-back (the Leader hires up to 3 Workers within a single Turn) before any of
  // them has actually landed in `workerElsRef`.
  const collectPlacementRects = useCallback((): Rect[] => {
    const rects: Rect[] = [LEADER_RECT];
    workerElsRef.current.forEach((el) => rects.push(worldRectOf(el)));
    reservedPositionsRef.current.forEach((pos) =>
      rects.push({ x: pos.x, y: pos.y, w: WORKER_SIZE.w, h: WORKER_SIZE.h }),
    );
    return rects;
  }, [worldRectOf]);

  const scheduleFit = useCallback(() => {
    if (fitTimeoutRef.current) clearTimeout(fitTimeoutRef.current);
    fitTimeoutRef.current = setTimeout(() => {
      fitTimeoutRef.current = null;
      if (!isSystemOwned()) return; // user owns the camera — never fight it (Slice 6.3 item 2)
      void animateCamTo(camToFit(collectRects()), isReduced() ? 0 : 600);
    }, 900);
  }, [animateCamTo, camToFit, collectRects, isReduced, isSystemOwned]);

  // Ref callback invoked by React at commit time (never during render) when a Worker card
  // mounts/unmounts. Kept as a single stable function — the per-worker id is bound via a small
  // inline arrow at the call site — so no ref is read while rendering (react-hooks/refs).
  const handleWorkerRef = useCallback(
    (workerId: string, el: HTMLDivElement | null) => {
      if (!el) {
        workerElsRef.current.delete(workerId);
        reservedPositionsRef.current.delete(workerId);
        return;
      }
      if (seenWorkerIdsRef.current.has(workerId)) {
        workerElsRef.current.set(workerId, el);
        return;
      }
      seenWorkerIdsRef.current.add(workerId);
      // Collision-aware placement (Slice 6.3 item 1): only for a genuinely first-time spawn — a
      // Worker restored with a saved/dragged position already in `nodePositions` keeps it as-is.
      // Computed and reserved BEFORE this Worker is added to `workerElsRef`, so it never collides
      // with its own (not-yet-placed) rect, then cleared once it mounts below. The Leader can hire
      // up to 3 Workers back-to-back within one Turn, so several placements may be decided before
      // any of them has actually landed in `workerElsRef` — `reservedPositionsRef` covers that.
      if (!nodePositionsRef.current[workerId]) {
        const defaultPos = defaultPositionFor(workerId);
        const occupied = collectPlacementRects();
        const resolved = findFreePosition(defaultPos, WORKER_SIZE, occupied, PLACEMENT_MARGIN);
        reservedPositionsRef.current.set(workerId, resolved);
        setNodePositions((prev) => ({ ...prev, [workerId]: resolved }));
      }
      workerElsRef.current.set(workerId, el);
      reservedPositionsRef.current.delete(workerId); // mounted — its DOM rect is now authoritative
      el.classList.add('spawn');
      // Camera follows the newly spawned Worker briefly (mock lines 968-976), then settles
      // back to a view that fits everything (scheduleFit) so nothing is left off-screen. Skip
      // the follow once the user owns the camera (Slice 6.3 item 2) — never fight a manual pan/
      // zoom/drag that happened in the meantime.
      setTimeout(() => {
        if (!isSystemOwned()) return;
        void animateCamTo(camToFocus(worldRectOf(el), 0.7), isReduced() ? 0 : 480);
      }, 120);
      scheduleFit();
      // Hiring visibility (FR-TEAM-03): the spawn animation above is complemented — not
      // replaced — by a terse transient event line, shown in EVERY motion mode (unlike the cable
      // events below, which are reduced-motion-only substitutes for their own animation) since
      // there is no other animation standing in for it under full motion.
      const role = workers.find((w) => w.id === workerId)?.role ?? workerId;
      announceCableEvent(`Leaderが ${role} を雇用しました`, true);
    },
    [
      animateCamTo,
      camToFocus,
      worldRectOf,
      isReduced,
      scheduleFit,
      isSystemOwned,
      workers,
      defaultPositionFor,
      collectPlacementRects,
      announceCableEvent,
    ],
  );

  // Initial camera: mirrors the mock's promoteToTeam choreography (demo/index.html lines
  // 929-961) — seed the camera so the Leader node first renders exactly where the chat surface
  // used to sit, then fly to a settled view that includes the Leader plus any existing Workers.
  //
  // Runs in `useLayoutEffect` (synchronous, before paint) rather than `useEffect`+rAF: by commit
  // time all child refs (Leader/Worker nodes) are already attached, so rects are accurate
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
    const defaultTarget = rects.length > 1 ? camToFit(rects) : camToFocus(LEADER_RECT, 0.75);
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

  // Mount-time focus (a11y fix, Phase 7 / NFR-A11Y-02): entering Team mode makes Sidebar/TaskHeader
  // `inert` in the SAME commit this component mounts (App.tsx's `chromeInert`). If the element that
  // triggered the transition — the "⬡ Team" button inside TaskHeader — was itself focused (the
  // keyboard-only path), it goes inert mid-interaction and the browser silently drops focus to
  // `document.body`, breaking keyboard navigation. Move focus onto the canvas root itself as soon
  // as it mounts. This always runs before SurfaceLayer's own re-parent effect (App.tsx renders
  // TeamCanvas ahead of SurfaceLayer in the same parent, and React fires layout effects in tree
  // order for a shared commit), so whenever there IS a captured in-host focus to restore
  // (re-entering Team mode while the composer was focused, see team-morph.spec.ts), that effect's
  // `restoreSurfaceState` still wins and moves focus there instead, immediately after this.
  useLayoutEffect(() => {
    canvasRef.current?.focus({ preventScroll: true });
  }, [canvasRef]);

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
          if (initialCameraSetRef.current && !draggingRef.current && isSystemOwned()) {
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
    // `animateCamTo`/`isReduced`/`draggingRef`/`isSystemOwned` are all stable identities from
    // useCamera (memoized with empty/stable deps), so none of these ever actually change and
    // re-trigger a refetch.
  }, [task.id, animateCamTo, isReduced, draggingRef, isSystemOwned]);

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
        claimSystemOwnership(); // re-settling to a normal view is itself a system-decided move
        const rects = collectRects();
        const target = rects.length > 1 ? camToFit(rects) : camToFocus(LEADER_RECT, 0.75);
        void animateCamTo(target, isReduced() ? 0 : 400, { silent: true });
      },
    }),
    [
      cancelCamAnim,
      animateCamTo,
      isReduced,
      collectRects,
      camToFit,
      camToFocus,
      claimSystemOwnership,
    ],
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
      const result = await client.saveCanvasView({
        ...payload,
        revision: canvasViewRevisionRef.current,
      });
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
      if (!card || !agentId) return;
      const current = nodePositionsRef.current[agentId] ?? defaultPositionFor(agentId);
      nodeDraggingRef.current = {
        agentId,
        pointerId: e.pointerId,
        originClientX: e.clientX,
        originClientY: e.clientY,
        originX: current.x,
        originY: current.y,
      };
      draggingRef.current = true; // reuse the camera's flag: pauses auto-follow/scheduleFit too
      claimUserOwnership(); // manual input (Slice 6.3 item 2): cancels any in-flight system move
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
  }, [canvasRef, camRef, draggingRef, defaultPositionFor, scheduleSave, claimUserOwnership]);

  // Live message-by-id lookup (Slice 6.4 item 4), kept fresh on EVERY store update regardless of
  // whether anything is currently enqueued — a cable holding on a pre-ack message needs to see an
  // ack that lands after it started polling, not just the snapshot it was queued with.
  useEffect(() => {
    if (!detail) return;
    const next = new Map<string, TeamMessageSummary>();
    for (const m of detail.messages) next.set(m.id, m);
    messagesByIdRef.current = next;
  }, [detail]);

  // Worker role names (Slice 6.4 item 6), used only to compose the textual cable event — plain
  // display copy, not identity.
  const workerRoleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const worker of workers) map.set(worker.id, worker.role);
    return map;
  }, [workers]);

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
        const leaderHead = leaderEl.querySelector<HTMLElement>('.surface-header');
        const workerHead = workerEl.querySelector<HTMLElement>('.w-head');
        const fromHead = fromLeader ? leaderHead : workerHead;
        const toHead = fromLeader ? workerHead : leaderHead;
        const role = workerRoleById.get(workerId) ?? workerId;
        const reduced = isReduced();
        const messageId = message.id;
        // Cables must animate in message order, one at a time — intentionally sequential.
        await sendCable(svg, worldRectOf(fromEl), worldRectOf(toEl), toHead, {
          reverse: !fromLeader,
          reduced,
          fromHead,
          sourceId: message.sourceAgentId,
          targetId: message.targetAgentId,
          getLatest: () => messagesByIdRef.current.get(messageId),
          onOutcome: (outcome) => {
            const text =
              outcome === 'danger'
                ? fromLeader
                  ? `Leader → ${role}: 配信に失敗しました`
                  : `${role} → Leader: 配信に失敗しました`
                : fromLeader
                  ? `Leader → ${role}: 依頼を送信`
                  : `${role} → Leader: 報告を受信 (ack)`;
            announceCableEvent(text, reduced);
          },
        });
      }
      cablePlayingRef.current = false;
    })();
  }, [worldRectOf, isReduced, leaderRef, workerRoleById, announceCableEvent]);

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

  // Pre-existing bug fixed as part of 6.4: the app renders under <StrictMode> (main.tsx), which
  // dev-mode double-invokes a mount-once effect's cleanup as part of its mount -> cleanup ->
  // remount simulation. A cleanup-only effect (no setup body) permanently poisoned
  // `cableCancelledRef.current` to `true` on that very first phantom cleanup — the pump's own
  // `if (cableCancelledRef.current) break;` guard then silently dropped every cable for the rest
  // of the REAL mount's lifetime, with no error (this is why cables/glow never appeared in dev
  // mode despite messages being delivered correctly at the domain level). Fix: the setup function
  // must undo whatever the cleanup does, so the ref ends up correctly "not cancelled" after
  // StrictMode's simulation, exactly like it would with a single real mount.
  useEffect(() => {
    cableCancelledRef.current = false;
    return () => {
      if (fitTimeoutRef.current) clearTimeout(fitTimeoutRef.current);
      cableCancelledRef.current = true;
    };
  }, []);

  // --- Canvas keyboard navigation (Slice 6.1) ---
  const nodeIds = useMemo(() => {
    const ids: string[] = [];
    if (leaderAgentId) ids.push(leaderAgentId);
    for (const worker of workers) ids.push(worker.id);
    return ids;
  }, [leaderAgentId, workers]);

  // Drop a selection that no longer refers to a navigable node (e.g. a Worker being stopped and
  // removed while selected). Render-time adjustment (not an effect — react-hooks/
  // set-state-in-effect convention, see TaskHeader/GoalChip) — bails out after the one corrective
  // re-render since `nodeIds` no longer contains the stale id.
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
      const el = workerElsRef.current.get(nodeId);
      return el ? worldRectOf(el) : LEADER_RECT;
    },
    [leaderAgentId, worldRectOf],
  );

  const describeNode = useCallback(
    (nodeId: string): string => {
      if (nodeId === leaderAgentId) return 'Leader';
      const worker = workers.find((w) => w.id === nodeId);
      return worker ? `${worker.role} (${worker.state})` : nodeId;
    },
    [leaderAgentId, workers],
  );

  // Moves DOM focus *into* the selected node's primary interactive element (Enter's second
  // effect, alongside the camera focus below) — the composer textarea for the Leader, the 停止
  // button for a Worker (its only remaining interactive element now that it's an observation
  // card — see WorkerNode.tsx).
  const focusIntoNode = useCallback(
    (nodeId: string) => {
      if (nodeId === leaderAgentId) {
        leaderRef.current?.querySelector<HTMLElement>('.composer-input')?.focus();
        return;
      }
      workerElsRef.current.get(nodeId)?.querySelector<HTMLElement>('.w-stop-btn')?.focus();
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
    claimSystemOwnership(); // explicit command (Slice 6.3 item 2): executes, hands ownership back
    void animateCamTo(camToFocus(rectForNode(selectedNodeId), 0.75), isReduced() ? 0 : 480);
    focusIntoNode(selectedNodeId);
  }, [
    selectedNodeId,
    claimSystemOwnership,
    animateCamTo,
    camToFocus,
    rectForNode,
    isReduced,
    focusIntoNode,
  ]);

  // Escape-from-anywhere (a11y fix, Phase 7 / NFR-A11Y-02): a plain, non-React `addEventListener`
  // on the canvas root, kept separate from `handleCanvasKeyDown` below. The Leader's composer
  // (SurfaceLayer/ChatSurface) is a REACT PORTAL whose content is rendered into `.leader-anchor`
  // (a real DOM descendant of this section) but whose React-tree parent is `<SurfaceLayer>` — a
  // *sibling* of this component in App.tsx, not an ancestor. React's synthetic `onKeyDown` bubbles
  // along the React tree, so a key pressed inside the portaled composer never reaches this
  // section's JSX `onKeyDown` at all, no matter how deep it is in the real DOM — `handleCanvasKeyDown`
  // below's Escape branch (and its "always works, even from the composer" comment) was simply
  // never true for that case. A native listener bubbles along the real DOM tree instead, so it
  // does reach here regardless of the portal. Scoped to only `Escape` — every other shortcut
  // (arrows/Enter/f/l) must stay off while the user is typing in the composer, which
  // `handleCanvasKeyDown`'s `e.target !== e.currentTarget` guard already ensures for the
  // non-portaled cases (a selected Worker's own 停止 button, a direct child) below.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if ((e.target as HTMLElement).closest('.team-policy-dialog')) return;
      e.preventDefault();
      canvasRef.current?.focus({ preventScroll: true });
    }
    canvas.addEventListener('keydown', onKeyDown);
    return () => canvas.removeEventListener('keydown', onKeyDown);
  }, [canvasRef]);

  const handleCanvasKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>) => {
      if ((e.target as HTMLElement).closest('.team-policy-dialog')) return;
      if (e.key === 'Escape') {
        // Native-DOM Escape handling above already covers every case (including from inside the
        // portaled composer); this branch just avoids a double `.preventDefault()`/no-op re-run
        // for the ordinary, non-portaled case where this synthetic handler also fires.
        e.preventDefault();
        canvasRef.current?.focus({ preventScroll: true });
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
        claimSystemOwnership(); // explicit command: executes, hands ownership back to system
        void animateCamTo(camToFit(collectRects()), isReduced() ? 0 : 500);
        return;
      }
      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        if (leaderAgentId) setSelectedNodeId(leaderAgentId);
        claimSystemOwnership(); // explicit command
        void animateCamTo(camToFocus(LEADER_RECT, 0.75), isReduced() ? 0 : 500);
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
      claimSystemOwnership,
    ],
  );

  // Static parent -> child connectors (Team v2 hierarchy). Deliberately NOT part of the message
  // cable overlay: these describe STRUCTURE, so they are always drawn, never animated (nothing for
  // `prefers-reduced-motion` to suppress — they look identical in every motion mode) and never
  // removed after a message settles. Geometry comes from state rather than measured DOM rects, so
  // a connector follows its card live while it is being dragged. The parent id is the same one the
  // layout placed the card under, so a line can never disagree with the arrangement it explains.
  const hierarchyEdges = useMemo(() => {
    if (!leaderAgentId) return [];
    const rectOf = (nodeId: string): Rect | null => {
      if (nodeId === leaderAgentId) return LEADER_RECT;
      const placement = hierarchyLayout.get(nodeId);
      if (!placement) return null;
      const pos = nodePositions[nodeId] ?? placement;
      return { x: pos.x, y: pos.y, w: WORKER_SIZE.w, h: WORKER_SIZE.h };
    };
    const edges: { childId: string; parentId: string; d: string }[] = [];
    for (const worker of workers) {
      const placement = hierarchyLayout.get(worker.id);
      if (!placement) continue;
      const from = rectOf(placement.parentAgentId);
      const to = rectOf(worker.id);
      if (!from || !to) continue;
      edges.push({
        childId: worker.id,
        parentId: placement.parentAgentId,
        d: hierarchyEdgePath(from, to),
      });
    }
    return edges;
  }, [leaderAgentId, hierarchyLayout, nodePositions, workers]);

  // Deliberately worded differently from the visible `.team-status-chip` text below: Playwright's
  // getByText() is a substring match, so an aria-live region carrying the *exact same* string
  // would make `getByText('<state> · Worker N人')` resolve to two elements (chip + live region).
  // No denominator on either side (Team v2 B1b): a Team's Worker count is dynamic, so any fixed
  // "/N" would be wrong — and the Team Policy's execution cap of 8 is a concurrency limit, not a
  // Worker headcount limit, so it must not stand in as one either.
  const selectionText = selectedNodeId ? `選択: ${describeNode(selectedNodeId)}` : '';
  const liveText = detail
    ? `Team status: ${detail.team.state}, workers ${workerCount}${
        selectionText ? `. ${selectionText}` : ''
      }`
    : '';

  return (
    <section
      className={`team-canvas${exitingFade ? ' exiting' : ''}`}
      ref={canvasRef}
      data-testid="team-list"
      aria-label="Team canvas"
      tabIndex={0}
      onKeyDown={handleCanvasKeyDown}
    >
      <img
        className="team-canvas-art"
        src={teamCanvasNetwork}
        alt=""
        aria-hidden="true"
        draggable={false}
      />
      {!detail ? (
        <div className="team-canvas-notice">
          <div className="sys-notice">Teamを準備しています</div>
        </div>
      ) : (
        <>
          <div className="team-world" ref={worldRef}>
            {/* Hierarchy connectors, painted under the cards (DOM order: both layers are
                positioned, so `.team-world-nodes` below still paints on top). Reuses `.team-cables`
                for its geometry/`pointer-events: none` rather than adding CSS, and styles the lines
                with plain SVG presentation attributes — `currentColor` at low opacity keeps them
                readable in either theme and visually distinct from an amber/blue message cable.
                `aria-hidden` + non-interactive: the same depth/parent facts are text on every
                Worker card (and in the List), so this steals neither pointer nor focus. */}
            <svg
              className="team-cables"
              viewBox="0 0 7000 6000"
              data-testid="team-hierarchy-edges"
              aria-hidden="true"
              pointerEvents="none"
            >
              {hierarchyEdges.map((edge) => (
                <path
                  key={edge.childId}
                  d={edge.d}
                  data-testid="team-hierarchy-edge"
                  data-parent-id={edge.parentId}
                  data-child-id={edge.childId}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.4}
                  strokeLinecap="round"
                  opacity={0.32}
                />
              ))}
            </svg>
            <svg className="team-cables" ref={svgRef} viewBox="0 0 7000 6000" />
            <div className="team-world-nodes">
              {/* SurfaceLayer (owned by App) portals the shared ChatSurface instance in here —
                  this anchor only reserves the slot; see App.tsx's morph orchestration. */}
              <div className="leader-anchor" ref={leaderAnchorRef} />
              {workers.map((worker) => {
                const pos = nodePositions[worker.id] ?? defaultPositionFor(worker.id);
                const execution = latestExecutionForWorker(detail.executions, worker.id);
                return (
                  <WorkerNode
                    key={worker.id}
                    worker={worker}
                    parent={parentAgentOf(worker, workers)}
                    // Message lines name their counterpart by its persisted agent id — the Leader
                    // by `leaderAgentId`, a sibling Worker by its own role. TeamListView resolves
                    // against the exact same two facts, so both views tag a message identically.
                    leaderAgentId={detail.team.leaderAgentId}
                    agents={workers}
                    x={pos.x}
                    y={pos.y}
                    messages={detail.messages}
                    execution={execution}
                    teamBusy={teamBusy}
                    selected={selectedNodeId === worker.id}
                    onStop={() => void stopTeamWorker(task.id, worker.id)}
                    onResumeMission={
                      execution?.missionId == null
                        ? undefined
                        : () => void resumeTeamMission(task.id, execution.missionId!)
                    }
                    onResumeIntegration={
                      execution === null
                        ? undefined
                        : () => void resumeTeamExecutionIntegration(task.id, execution.id)
                    }
                    ref={(el) => handleWorkerRef(worker.id, el)}
                  />
                );
              })}
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
            onOpenPolicy={() => setPolicyOpen(true)}
          />

          <CanvasControlsOverlay
            onFit={() => {
              claimSystemOwnership(); // explicit command
              void animateCamTo(camToFit(collectRects()), isReduced() ? 0 : 500);
            }}
            onFocusLeader={() => {
              claimSystemOwnership(); // explicit command
              void animateCamTo(camToFocus(LEADER_RECT, 0.75), isReduced() ? 0 : 500);
            }}
          />
          {/* Empty-team guidance (FR-TEAM-03/06): there is no hire form anymore — the Leader
              hires on its own once it decides the Task needs help. Keep this screen-fixed rather
              than inside `.team-world`: the initial camera fits the Leader node, so a world-space
              banner below it would begin outside the first viewport and hide the only guidance. */}
          {showEmptyTeamHint && (
            <div className="team-empty-hint">
              <img src={teamEmptyDocks} alt="" aria-hidden="true" draggable={false} />
              <span className="team-empty-hint-copy">
                <strong>Teamは待機中</strong>
                Leaderに依頼すると、必要に応じてWorkerを雇用します
              </span>
            </div>
          )}
        </>
      )}
      {/* Transient textual event overlay — bottom-center, auto-dismissed after ~3s by
          `announceCableEvent`. Reduced-motion-only for cable dispatch/report events (Slice 6.4
          item 6), but always shown for a Worker hire (FR-TEAM-03) since no other animation stands
          in for it there. The same text is always mirrored to the aria-live announcer below
          regardless of motion mode, so this overlay is purely visual/redundant for screen readers
          (`aria-hidden`). */}
      {transientCableEvents.length > 0 && (
        <div className="team-cable-events" aria-hidden="true">
          {transientCableEvents.map((event) => (
            <div key={event.id} className="sys-notice team-cable-event">
              {event.text}
            </div>
          ))}
        </div>
      )}
      <div aria-live="polite" className="visually-hidden">
        {liveText}
      </div>
      <div aria-live="polite" className="visually-hidden" data-testid="team-cable-announcer">
        {cableAnnouncement}
      </div>
      {detail && policyOpen && (
        <TeamPolicyDialog
          open={policyOpen}
          taskId={task.id}
          detail={detail}
          onClose={() => setPolicyOpen(false)}
        />
      )}
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
  onOpenPolicy,
}: {
  task: TaskSummary;
  detail: TeamDetail;
  workerCount: number;
  teamBusy: boolean;
  onBack: () => void;
  onStopAll: () => void;
  onSwitchToListView: () => void;
  onOpenPolicy: () => void;
}) {
  return (
    <div className="team-header-overlay">
      <button type="button" className="team-back-btn" data-testid="team-back" onClick={onBack}>
        <ArrowLeft size={14} /> Chatに戻る
      </button>
      <span className="team-title">{task.title}</span>
      <span className="team-badge">Team · {workerCount} workers</span>
      <span className="team-status-chip">{`${detail.team.state} · Worker ${workerCount}人`}</span>
      <button
        type="button"
        className="team-view-toggle-btn"
        data-testid="team-view-toggle"
        onClick={onSwitchToListView}
        title="Team List Viewに切り替え"
      >
        <List size={14} /> List表示
      </button>
      <TeamPolicyTrigger onOpen={onOpenPolicy} />
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
        ドラッグで移動 · ホイール/ピンチでズーム · ↑↓←→/Tabで選択 · Enterで開く · F: フィット · L:
        Leaderへ · Esc: 選択解除
      </div>
    </div>
  );
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useAppStore } from '../../store/appStore';
import { ChatSurface } from '../ChatSurface/ChatSurface';
import { WorkerNode } from './WorkerNode';
import { HireNode } from './HireNode';
import { useCamera } from './useCamera';
import type { Rect } from './useCamera';
import { sendCable } from './cables';
import type { TaskSummary, TeamDetail, TeamMessageSummary } from '../../types/sprint-coder';

// Team Canvas: the spatial "promoted chat" experience from demo/index.html (§Team mode,
// lines 104-145 / 346-405 / 756-961). The Leader node is a real ChatSurface (variant="node");
// Worker nodes sit at fixed world slots; an SVG layer draws animated cables between them when
// Team messages flow. Camera state lives in refs (useCamera) so pan/zoom stays smooth.

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

export function TeamCanvas({ task }: { task: TaskSummary }) {
  const detail = useAppStore((s) => s.teamByTask[task.id]);
  const teamBusy = useAppStore((s) => s.teamBusy);
  const toggleTeamView = useAppStore((s) => s.toggleTeamView);
  const hireTeamWorker = useAppStore((s) => s.hireTeamWorker);
  const sendTeamMessage = useAppStore((s) => s.sendTeamMessage);
  const stopTeamWorker = useAppStore((s) => s.stopTeamWorker);
  const stopAllTeamWorkers = useAppStore((s) => s.stopAllTeamWorkers);

  const {
    canvasRef,
    worldRef,
    camRef,
    draggingRef,
    isReduced,
    applyCam,
    animateCamTo,
    camToFit,
    camToFocus,
    worldRectOf,
  } = useCamera();

  const leaderRef = useRef<HTMLDivElement>(null);
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
    const target = rects.length > 1 ? camToFit(rects) : camToFocus(LEADER_RECT, 0.8);
    if (isReduced()) {
      // Reduced motion: jump straight to the settled view — no seed-then-fly choreography.
      void animateCamTo(target, 0);
      return;
    }
    // Seed (mock lines 936-951): the mock measures the real chat surface's bounding rect via
    // FLIP, but ours is already gone by mount time (replaced by `.surface-placeholder`), so use
    // the mock's own fallback constants directly — sidebar width 264, header height 52.
    const rectA = {
      left: 264,
      top: 52,
      width: Math.max(720, window.innerWidth - 264),
      height: Math.max(480, window.innerHeight - 52),
    };
    camRef.current = { x: rectA.left, y: rectA.top, s: rectA.width / 720 };
    applyCam();
    void animateCamTo(target, 560);
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
  }, [worldRectOf, isReduced]);

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

  // Deliberately worded differently from the visible `.team-status-chip` text below: Playwright's
  // getByText() is a substring match, so an aria-live region carrying the *exact same* string
  // would make `getByText('<state> · Worker N/3')` resolve to two elements (chip + live region).
  const liveText = detail
    ? `Team status: ${detail.team.state}, workers ${workerCount} of ${MAX_WORKERS}`
    : '';
  const hireSlot = slotFor(workerCount);

  return (
    <section
      className="team-canvas"
      ref={canvasRef}
      data-testid="team-list"
      aria-label="Team canvas"
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
              <ChatSurface
                task={task}
                variant="node"
                id={`team-agent-${detail.team.leaderAgentId}`}
                ref={leaderRef}
              />
              {workers.map((worker, index) => {
                const slot = slotFor(index);
                return (
                  <WorkerNode
                    key={worker.id}
                    worker={worker}
                    x={slot.x}
                    y={slot.y}
                    messages={detail.messages}
                    teamBusy={teamBusy}
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
            onBack={() => void toggleTeamView(task.id)}
            onStopAll={() => void stopAllTeamWorkers(task.id)}
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
}: {
  task: TaskSummary;
  detail: TeamDetail;
  workerCount: number;
  teamBusy: boolean;
  onBack: () => void;
  onStopAll: () => void;
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
      <div className="cc-hint">ドラッグで移動 · ホイール/ピンチでズーム</div>
    </div>
  );
}

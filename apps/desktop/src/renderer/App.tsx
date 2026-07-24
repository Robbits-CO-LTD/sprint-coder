import { useCallback, useEffect, useRef, useState } from 'react';
import './index.css';
import { useAppStore } from './store/appStore';
import { Sidebar } from './components/Sidebar';
import { TaskHeader } from './components/TaskHeader';
import { SurfaceLayer, captureSurfaceState } from './components/ChatSurface/SurfaceLayer';
import type { CapturedSurfaceState } from './components/ChatSurface/SurfaceLayer';
import { TeamCanvas } from './components/TeamCanvas/TeamCanvas';
import type { TeamCanvasHandle } from './components/TeamCanvas/TeamCanvas';

export default function App() {
  const sprintCoderAvailable = useAppStore((s) => s.sprintCoderAvailable);
  const initialized = useAppStore((s) => s.initialized);
  const init = useAppStore((s) => s.init);
  const tasks = useAppStore((s) => s.tasks);
  const selectedTaskId = useAppStore((s) => s.selectedTaskId);
  const createTask = useAppStore((s) => s.createTask);
  const teamViewOpen = useAppStore((s) => s.teamViewOpen);
  const toggleTeamView = useAppStore((s) => s.toggleTeamView);
  const leaderAgentId = useAppStore((s) => s.teamByTask[selectedTaskId ?? '']?.team.leaderAgentId);

  useEffect(() => {
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Chat <-> Leader morph orchestration (Phase 6 Slice 6.2, docs §4.6 / ADR-002) ---
  //
  // SurfaceLayer owns ONE persistent ChatSurface instance for the selected Task; this component
  // only decides which anchor (`surfaceMode`) that instance's host <div> currently lives inside.
  // `mainAnchorRef` sits in the normal Chat column, `leaderAnchorRef` sits inside TeamCanvas's
  // world (passed down as a prop so TeamCanvas doesn't need to know anything about the layer).
  //
  // Entering is store-driven: `teamViewOpen` flips immediately (existing behaviour), which mounts
  // TeamCanvas and — via the render-time sync below — flips `surfaceMode` to 'node' in the SAME
  // commit, so the anchor exists by the time SurfaceLayer's layout effect re-parents the host.
  // TeamCanvas's own seed-then-fly camera choreography (unchanged) then animates the *actual* live
  // surface into view.
  //
  // Exiting is deliberately NOT store-driven up front. `requestExitTeam` below plays the reverse
  // FLIP (camera fly back to the seed rect, then fade the canvas out) while `teamViewOpen` is
  // still true and TeamCanvas is still mounted, and only once the canvas is fully invisible does
  // it move the host back to the main anchor and — one frame later, so the move and the unmount
  // land in separate commits — flip `teamViewOpen` false. Moving the host and unmounting TeamCanvas
  // in the very same commit would risk the browser detaching the host (still parented under the
  // about-to-be-removed Leader anchor) before SurfaceLayer's own effect gets a chance to re-parent
  // it out from under that subtree.
  const mainAnchorRef = useRef<HTMLDivElement | null>(null);
  const leaderAnchorRef = useRef<HTMLDivElement | null>(null);
  const leaderRef = useRef<HTMLDivElement | null>(null);
  const teamCanvasHandleRef = useRef<TeamCanvasHandle | null>(null);
  const pendingCaptureRef = useRef<CapturedSurfaceState | null>(null);
  const exitTokenRef = useRef(0);
  const [surfaceMode, setSurfaceMode] = useState<'main' | 'node'>('main');
  const [exiting, setExiting] = useState(false);

  // Render-time sync (not an effect — react-hooks/set-state-in-effect convention, see
  // TaskHeader/GoalChip): keep `surfaceMode` following the store's `teamViewOpen`, except during
  // the tail of `requestExitTeam`, which explicitly forces 'main' one commit *before* the store
  // itself flips — `exiting` suppresses the resync during that narrow window so the override
  // sticks instead of being immediately flipped back to 'node'.
  if (teamViewOpen && surfaceMode !== 'node' && !exiting) {
    setSurfaceMode('node');
  }
  if (!teamViewOpen && surfaceMode !== 'main' && !exiting) {
    setSurfaceMode('main');
  }

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? null;
  const teamActive = teamViewOpen && selectedTask !== null;
  const showTeamCanvas = (teamActive || exiting) && selectedTask !== null;

  const requestEnterTeam = useCallback(() => {
    if (exiting) {
      // Defense-in-depth: the "⬡ Team" control is already unreachable while `exiting` is true
      // (`.app-shell.team-mode .task-header` stays `pointer-events:none` for the whole exit
      // sequence, see index.css), but cancel cleanly rather than leave a half-finished reverse
      // FLIP behind if this is ever reached programmatically (Slice 6.2 interruption requirement).
      exitTokenRef.current += 1; // invalidate the in-flight requestExitTeam sequence below
      pendingCaptureRef.current = null; // discard the snapshot captured for that cancelled exit
      teamCanvasHandleRef.current?.cancelCameraAnimation();
      setExiting(false);
      teamCanvasHandleRef.current?.resettle();
      return;
    }
    if (!selectedTask || teamViewOpen) return;
    void toggleTeamView(selectedTask.id);
  }, [exiting, selectedTask, teamViewOpen, toggleTeamView]);

  const requestExitTeam = useCallback(() => {
    if (!selectedTask || exiting) return;
    const token = (exitTokenRef.current += 1);
    // Capture scroll/focus synchronously, now — strictly before anything about this transition
    // touches the DOM. `setSurfaceMode('main')` below (which removes `.surface--node`, whose
    // fixed 720x620 box is the only thing keeping the Leader node's layout independent of its
    // *current* (soon to be wrong) flex-context-less parent) doesn't run for another ~780ms, and
    // capturing reactively at that point would already be reading a transiently corrupted
    // scrollTop — see SurfaceLayer's `pendingCaptureRef` doc comment for the full explanation.
    if (leaderRef.current) pendingCaptureRef.current = captureSurfaceState(leaderRef.current);
    setExiting(true);
    void (async () => {
      await teamCanvasHandleRef.current?.playExitAnimation();
      if (exitTokenRef.current !== token) return; // superseded by a mid-flight requestEnterTeam
      setSurfaceMode('main');
      // Let the anchor-swap commit paint before unmounting TeamCanvas — see the block comment
      // above for why these must not land in the same commit.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (exitTokenRef.current !== token) return;
      setExiting(false);
      await toggleTeamView(selectedTask.id);
    })();
  }, [selectedTask, exiting, toggleTeamView]);

  if (initialized && !sprintCoderAvailable) {
    return (
      <div className="app-shell app-shell--unavailable">
        <div className="unavailable-card" role="alert">
          <h1>Electron環境で起動してください</h1>
          <p>
            このUIはElectronアプリのRendererとして動作します。ブラウザから直接開いた場合、
            <code>window.sprintCoder</code>{' '}
            が公開されないため、Taskの読み込みやメッセージ送信はできません。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`app-shell${teamActive || exiting ? ' team-mode' : ''}`}>
      <Sidebar />
      <div className="main">
        {selectedTask ? (
          <>
            <TaskHeader task={selectedTask} onToggleTeam={requestEnterTeam} />
            {/* SurfaceLayer portals the shared ChatSurface instance in here when `surfaceMode`
                is 'main' — this anchor only reserves the slot, see the morph orchestration
                above and SurfaceLayer.tsx. */}
            <div className="surface-anchor" ref={mainAnchorRef} />
          </>
        ) : (
          <div className="empty-state" style={{ margin: 'auto' }}>
            <h2>Taskを選択してください</h2>
            <p>左のTask履歴から選ぶか、新しいTaskを作成して会話を始めます。</p>
            <div className="chips">
              <button
                type="button"
                className="chip"
                data-testid="empty-state-create-task-button"
                onClick={() => void createTask()}
              >
                ＋ 新しいTaskを作成
              </button>
            </div>
          </div>
        )}
      </div>
      {showTeamCanvas && selectedTask && (
        <TeamCanvas
          ref={teamCanvasHandleRef}
          task={selectedTask}
          leaderRef={leaderRef}
          leaderAnchorRef={leaderAnchorRef}
          onRequestExit={requestExitTeam}
        />
      )}
      {selectedTask && (
        <SurfaceLayer
          task={selectedTask}
          mode={surfaceMode}
          mainAnchorRef={mainAnchorRef}
          leaderAnchorRef={leaderAnchorRef}
          surfaceRef={leaderRef}
          surfaceId={surfaceMode === 'node' && leaderAgentId ? `team-agent-${leaderAgentId}` : undefined}
          pendingCaptureRef={pendingCaptureRef}
        />
      )}
    </div>
  );
}

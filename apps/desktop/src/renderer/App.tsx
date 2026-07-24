import { useCallback, useEffect, useRef, useState } from 'react';
import './index.css';
import { useAppStore } from './store/appStore';
import { Sidebar } from './components/Sidebar';
import { TaskHeader } from './components/TaskHeader';
import { SurfaceLayer, captureSurfaceState } from './components/ChatSurface/SurfaceLayer';
import type { CapturedSurfaceState } from './components/ChatSurface/SurfaceLayer';
import { TeamCanvas } from './components/TeamCanvas/TeamCanvas';
import type { TeamCanvasHandle } from './components/TeamCanvas/TeamCanvas';
import { TeamListView } from './components/TeamListView';
import { Plus } from './components/icons';

// Team view preference (Slice 6.1 item 4, List fallback): renderer-only, not part of the
// persisted Task/Team domain — a per-install UI preference, so localStorage is the right home for
// it rather than the store/DB. Canvas is the default per the task's constraints.
type TeamViewPreference = 'canvas' | 'list';
const TEAM_VIEW_PREFERENCE_KEY = 'sprint-coder:team-view-preference';

function readStoredTeamViewPreference(): TeamViewPreference {
  try {
    return window.localStorage.getItem(TEAM_VIEW_PREFERENCE_KEY) === 'list' ? 'list' : 'canvas';
  } catch {
    return 'canvas';
  }
}

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
  const [teamViewPreference, setTeamViewPreferenceState] = useState<TeamViewPreference>(
    readStoredTeamViewPreference,
  );

  // Focus restoration on full Team-mode exit (a11y fix, Phase 7 / NFR-A11Y-02): both exit paths
  // ("Chatに戻る" from the Canvas — after its reverse-FLIP tail — and from the List view) end by
  // unmounting whichever Team surface was showing. If focus was on that surface's own "戻る"
  // button (the common keyboard-only path), the browser drops it to `document.body` the instant
  // the button's DOM node is removed — there is nothing inside the plain Chat layout that already
  // owns re-focusing itself the way TeamCanvas/TeamListView's own mount-focus effects do for
  // *entering*. Watch `teamViewOpen`'s own true -> false edge (not `teamCanvasActive`/
  // `teamListActive`, which also flip on a same-mode Canvas<->List *switch* — already handled by
  // each view's own mount-focus effect) and, only if focus was actually lost to `<body>`, return
  // it to the "⬡ Team" button that (re)opens Team mode — a standard "restore focus to the control
  // that opened this" pattern.
  const teamViewOpenRef = useRef(teamViewOpen);
  useEffect(() => {
    if (teamViewOpenRef.current && !teamViewOpen && document.activeElement === document.body) {
      document.querySelector<HTMLElement>('[data-testid="team-toggle"]')?.focus({ preventScroll: true });
    }
    teamViewOpenRef.current = teamViewOpen;
  }, [teamViewOpen]);

  const setTeamViewPreference = useCallback((preference: TeamViewPreference) => {
    setTeamViewPreferenceState(preference);
    try {
      window.localStorage.setItem(TEAM_VIEW_PREFERENCE_KEY, preference);
    } catch {
      // Best-effort only — a failed write just means the preference resets to 'canvas' next launch.
    }
  }, []);

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) ?? null;
  // List mode (Slice 6.1 item 4) is a plain "chat layout + a team panel" — it never touches
  // `surfaceMode`/the Canvas FLIP, so only 'canvas' preference ever drives the morph below.
  const teamCanvasActive = teamViewOpen && teamViewPreference === 'canvas' && selectedTask !== null;
  // `!exiting` guards against a narrow edge case: the Canvas's own "List表示" toggle button is
  // reachable during the ~220ms fade tail of a Canvas exit, and flipping the preference there
  // must not make this component and TeamCanvas (still finishing its own exit) render at once.
  const teamListActive =
    teamViewOpen && teamViewPreference === 'list' && !exiting && selectedTask !== null;

  // Render-time sync (not an effect — react-hooks/set-state-in-effect convention, see
  // TaskHeader/GoalChip): keep `surfaceMode` following `teamCanvasActive`, except during
  // the tail of `requestExitTeam`, which explicitly forces 'main' one commit *before* the store
  // itself flips — `exiting` suppresses the resync during that narrow window so the override
  // sticks instead of being immediately flipped back to 'node'.
  if (teamCanvasActive && surfaceMode !== 'node' && !exiting) {
    setSurfaceMode('node');
  }
  if (!teamCanvasActive && surfaceMode !== 'main' && !exiting) {
    setSurfaceMode('main');
  }

  const showTeamCanvas = (teamCanvasActive || exiting) && selectedTask !== null;

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

  // List mode's "← Chatに戻る" (TeamListView's onBack): no camera, no FLIP, so exiting is a plain
  // store toggle — unlike requestExitTeam above, which only applies to the Canvas choreography.
  const requestExitTeamList = useCallback(() => {
    if (!selectedTask) return;
    void toggleTeamView(selectedTask.id);
  }, [selectedTask, toggleTeamView]);

  const switchToListView = useCallback(
    () => setTeamViewPreference('list'),
    [setTeamViewPreference],
  );
  const switchToCanvasView = useCallback(
    () => setTeamViewPreference('canvas'),
    [setTeamViewPreference],
  );

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

  // Hidden chrome focusability (gate-review fix): the Canvas presentation (or its exit tail)
  // already makes the Sidebar/TaskHeader invisible and unclickable via `.team-mode` (opacity 0 +
  // pointer-events none, see index.css) — `inert` closes the remaining gap for keyboard/AT users,
  // who could otherwise still Tab into chrome that looks gone. List mode never sets this class, so
  // the sidebar/header stay fully interactive there.
  const chromeInert = teamCanvasActive || exiting;

  return (
    <div className={`app-shell${chromeInert ? ' team-mode' : ''}`}>
      <Sidebar inert={chromeInert} />
      <div className="main">
        {selectedTask ? (
          <>
            <TaskHeader task={selectedTask} onToggleTeam={requestEnterTeam} inert={chromeInert} />
            {/* SurfaceLayer portals the shared ChatSurface instance in here when `surfaceMode`
                is 'main' — this anchor only reserves the slot, see the morph orchestration
                above and SurfaceLayer.tsx. This is also where the Chat lives in List mode: List
                view (below) is only ever an additional panel alongside the normal Chat layout,
                never a replacement for it — see the `teamListActive` decision above. */}
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
                <Plus size={14} /> 新しいTaskを作成
              </button>
            </div>
          </div>
        )}
      </div>
      {showTeamCanvas && selectedTask && (
        <TeamCanvas
          key={selectedTask.id}
          ref={teamCanvasHandleRef}
          task={selectedTask}
          leaderRef={leaderRef}
          leaderAnchorRef={leaderAnchorRef}
          onRequestExit={requestExitTeam}
          onSwitchToListView={switchToListView}
        />
      )}
      {teamListActive && selectedTask && (
        <TeamListView
          task={selectedTask}
          onBack={requestExitTeamList}
          onSwitchToCanvasView={switchToCanvasView}
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

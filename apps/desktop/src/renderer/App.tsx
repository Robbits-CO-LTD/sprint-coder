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
import { InspectorPanel } from './components/InspectorPanel';
import {
  nextInspectorState,
  readStoredInspectorState,
  writeStoredInspectorState,
  type InspectorState,
} from './lib/inspector-preference';
import { SettingsDialog } from './components/SettingsDialog';
import { TaskBoundaryProvider } from './components/TaskBoundary';
import { List, Plus } from './components/icons';
import { useMediaQuery } from './lib/useMediaQuery';
import {
  NARROW_VIEWPORT_QUERY,
  defaultSidebarCollapsed,
  readStoredSidebarCollapsed,
  writeStoredSidebarCollapsed,
} from './lib/sidebar-preference';
import { allowTaskBoundary } from './lib/task-boundary';
import { OPEN_PROJECT_CONTEXT_EVENT, isProjectContextRequest } from './lib/project-inspector';

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
  const selectTask = useAppStore((s) => s.selectTask);
  const editorDirty = useAppStore((s) => s.editorDirty);
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const confirmEditorBoundary = useCallback((): boolean => {
    return allowTaskBoundary(editorDirty, () =>
      window.confirm('編集中のファイルに未保存の変更があります。破棄して移動しますか？'),
    );
  }, [editorDirty]);
  const guardedSelectTask = useCallback(
    async (taskId: string): Promise<boolean> => {
      if (taskId === selectedTaskId) return true;
      if (!confirmEditorBoundary()) return false;
      await selectTask(taskId);
      return true;
    },
    [confirmEditorBoundary, selectTask, selectedTaskId],
  );
  const guardedCreateTask = useCallback(
    async (projectId?: string) => {
      if (!confirmEditorBoundary()) return null;
      return createTask(projectId);
    },
    [confirmEditorBoundary, createTask],
  );

  // --- Sidebar collapse (issue #12) ---
  //
  // The sidebar was a fixed 264px with no way to collapse it, so at the 760px minimum window size
  // it took ~35% of the shell, and at 200% zoom (effective viewport ~590px) the conversation column
  // was squeezed to 326px against a 341px intrinsic minimum — the Composer's send button spilled
  // 15px past the right edge, which is the measurable defect behind the two failing a11y-zoom
  // specs. Below the breakpoint the sidebar becomes an overlay instead of a flex sibling, so it
  // stops taking width from the conversation at all.
  const narrowViewport = useMediaQuery(NARROW_VIEWPORT_QUERY);
  const [sidebarCollapsed, setSidebarCollapsedState] = useState(() =>
    defaultSidebarCollapsed(narrowViewport, readStoredSidebarCollapsed()),
  );
  // Crossing the breakpoint re-derives the default rather than keeping whatever was showing:
  // entering narrow must collapse (an expanded overlay would cover the conversation), and leaving
  // it restores the stored preference. The user's stored choice is never written by this path.
  const wasNarrowRef = useRef(narrowViewport);
  useEffect(() => {
    if (wasNarrowRef.current === narrowViewport) return;
    wasNarrowRef.current = narrowViewport;
    setSidebarCollapsedState(defaultSidebarCollapsed(narrowViewport, readStoredSidebarCollapsed()));
  }, [narrowViewport]);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsedState((collapsed) => {
      const next = !collapsed;
      // Only an explicit toggle persists. Recorded even at narrow widths so the choice survives
      // into the next wide-window session.
      writeStoredSidebarCollapsed(next);
      return next;
    });
  }, []);

  // --- Inspector panel (issue #16) ---
  //
  // Default `hidden`, and that is not timidity: every existing E2E baseline was recorded without this
  // panel, so one that appeared unbidden would change the measured layout of specs that have nothing
  // to do with it.
  const [inspectorState, setInspectorStateRaw] = useState<InspectorState>(readStoredInspectorState);
  const [inspectorDisplay, setInspectorDisplay] = useState<'execution' | 'project'>('execution');
  const [contextRequest, setContextRequest] = useState<{
    taskId: string;
    turnId: string | null;
    key: number;
  } | null>(null);
  // Same 900px breakpoint the Team List View and the sidebar already use, so the app has one
  // narrow-viewport rule rather than three that disagree.
  const inspectorOverlay = useMediaQuery('(max-width: 900px)');

  const setInspectorState = useCallback((next: InspectorState) => {
    setInspectorStateRaw(next);
    writeStoredInspectorState(next);
  }, []);
  const setEditorDirty = useAppStore((s) => s.setEditorDirty);
  // Closing the window discards the editor's buffer. `beforeunload` is the only hook that can stop
  // that, and it needs a listener registered while the edit is outstanding (issue #43).
  useEffect(() => {
    if (!editorDirty) return;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      // Legacy assignment as well: Electron's Chromium honours preventDefault, but returnValue is
      // what older paths check and setting both costs nothing.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [editorDirty]);

  const cycleInspector = useCallback(
    () => setInspectorState(nextInspectorState(inspectorState)),
    [inspectorState, setInspectorState],
  );
  const cycleExecutionInspector = useCallback(() => {
    if (
      inspectorDisplay === 'project' &&
      editorDirty &&
      !window.confirm('Project Instructionに未保存の変更があります。破棄して切り替えますか？')
    )
      return;
    setInspectorDisplay('execution');
    cycleInspector();
  }, [cycleInspector, editorDirty, inspectorDisplay]);
  const hideInspector = useCallback(() => setInspectorState('hidden'), [setInspectorState]);

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
      document
        .querySelector<HTMLElement>('[data-testid="team-toggle"]')
        ?.focus({ preventScroll: true });
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
  // The List view is 460px and the panel 380/560, so showing both needs 840px+ of shell. They are
  // exclusive: while the List is up the panel drops to `rail`, which keeps the gauge visible without
  // competing for width. The stored preference is untouched, so it returns on leaving List view.
  const effectiveInspectorState =
    teamListActive && inspectorState !== 'hidden' ? 'rail' : inspectorState;

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

  useEffect(() => {
    const openProjectInspector = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!isProjectContextRequest(detail)) return;
      if (
        inspectorDisplay === 'execution' &&
        editorDirty &&
        !window.confirm('編集中のファイルに未保存の変更があります。破棄して切り替えますか？')
      )
        return;
      setInspectorDisplay('project');
      setContextRequest((current) => ({
        taskId: detail.taskId,
        turnId: detail.turnId,
        key: (current?.key ?? 0) + 1,
      }));
      if (inspectorState === 'hidden' || inspectorState === 'rail') setInspectorState('panel');
      if (teamListActive && selectedTask?.id === detail.taskId) void toggleTeamView(detail.taskId);
    };
    window.addEventListener(OPEN_PROJECT_CONTEXT_EVENT, openProjectInspector);
    return () => window.removeEventListener(OPEN_PROJECT_CONTEXT_EVENT, openProjectInspector);
  }, [
    editorDirty,
    inspectorDisplay,
    inspectorState,
    selectedTask?.id,
    setInspectorState,
    teamListActive,
    toggleTeamView,
  ]);

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
  const usesIntegratedMacTitlebar =
    navigator.platform.toLowerCase().includes('mac') ||
    navigator.userAgent.toLowerCase().includes('macintosh');

  return (
    <TaskBoundaryProvider value={{ selectTask: guardedSelectTask, createTask: guardedCreateTask }}>
      <div className="app-frame">
        {usesIntegratedMacTitlebar && (
          <header className="app-titlebar" data-testid="app-titlebar">
            <span className="app-titlebar-name">Sprint Coder</span>
          </header>
        )}
        <div
          className={[
            'app-shell',
            chromeInert ? 'team-mode' : '',
            sidebarCollapsed ? 'sidebar-collapsed' : '',
            narrowViewport ? 'sidebar-overlay' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <Sidebar
            inert={chromeInert || sidebarCollapsed}
            collapsed={sidebarCollapsed}
            onOpenSettings={openSettings}
          />
          {/* Tapping outside an overlaid sidebar closes it, the usual expectation for a panel that
          covers content. Only rendered in the overlay form, where the sidebar is not a layout
          sibling and so cannot be dismissed by simply looking away from it. */}
          {narrowViewport && !sidebarCollapsed && (
            <button
              type="button"
              className="sidebar-scrim"
              data-testid="sidebar-scrim"
              aria-label="Task履歴を閉じる"
              onClick={toggleSidebar}
            />
          )}
          <div className="main">
            {selectedTask ? (
              <>
                <TaskHeader
                  task={selectedTask}
                  onToggleTeam={requestEnterTeam}
                  inert={chromeInert}
                  onToggleInspector={cycleExecutionInspector}
                  inspectorOpen={inspectorState !== 'hidden'}
                  onToggleSidebar={toggleSidebar}
                  sidebarCollapsed={sidebarCollapsed}
                />
                {/* SurfaceLayer portals the shared ChatSurface instance in here when `surfaceMode`
                is 'main' — this anchor only reserves the slot, see the morph orchestration
                above and SurfaceLayer.tsx. This is also where the Chat lives in List mode: List
                view (below) is only ever an additional panel alongside the normal Chat layout,
                never a replacement for it — see the `teamListActive` decision above. */}
                <div className="surface-anchor" ref={mainAnchorRef} />
              </>
            ) : (
              <div className="empty-state" style={{ margin: 'auto' }}>
                {/* No TaskHeader in this branch, so the sidebar toggle would be unreachable once the
                sidebar is collapsed with no Task selected. */}
                <button
                  type="button"
                  className="chip"
                  data-testid="empty-state-sidebar-toggle"
                  aria-expanded={!sidebarCollapsed}
                  onClick={toggleSidebar}
                >
                  <List size={14} /> Task履歴を{sidebarCollapsed ? '開く' : '閉じる'}
                </button>
                <h2>Taskを選択してください</h2>
                <p>左のTask履歴から選ぶか、新しいタスクを作成して会話を始めます。</p>
                <div className="chips">
                  <button
                    type="button"
                    className="chip"
                    data-testid="empty-state-create-task-button"
                    onClick={() => void guardedCreateTask()}
                  >
                    <Plus size={14} /> 新しいタスクを作成
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
          {/* Flex sibling of `.main`, deliberately NOT inside `.surface-anchor`/`.leader-anchor`/
          `.surface-host`: SurfaceLayer re-parents that host between anchors on every Chat<->Team
          morph (ADR-002), and anything nested inside it would be torn out and re-inserted with it,
          losing its own state. Asserted mechanically in the E2E. */}
          <InspectorPanel
            state={effectiveInspectorState}
            onCycle={cycleInspector}
            onHide={hideInspector}
            overlay={inspectorOverlay}
            onDirtyChange={setEditorDirty}
            display={inspectorDisplay}
            requestedTurnId={
              contextRequest?.taskId === selectedTaskId ? contextRequest.turnId : null
            }
            contextRequestKey={contextRequest?.key ?? 0}
          />
          {teamListActive && selectedTask && (
            <TeamListView
              task={selectedTask}
              onBack={requestExitTeamList}
              onSwitchToCanvasView={switchToCanvasView}
            />
          )}
          {/* Outside `.main` and every Team surface: <dialog showModal> renders in the browser's top
          layer, so it is never clipped by `.team-canvas`'s `overflow: clip`, and it stays mounted
          across the Chat<->Team morph. */}
          <SettingsDialog open={settingsOpen} onClose={closeSettings} />
          {selectedTask && (
            <SurfaceLayer
              task={selectedTask}
              mode={surfaceMode}
              mainAnchorRef={mainAnchorRef}
              leaderAnchorRef={leaderAnchorRef}
              surfaceRef={leaderRef}
              surfaceId={
                surfaceMode === 'node' && leaderAgentId ? `team-agent-${leaderAgentId}` : undefined
              }
              pendingCaptureRef={pendingCaptureRef}
            />
          )}
        </div>
      </div>
    </TaskBoundaryProvider>
  );
}

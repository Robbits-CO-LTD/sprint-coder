/**
 * Turns the two E2E startup waits into a diagnosis when they fail (Issue #608): the globalSetup
 * wait for `npm start`, and the per-spec `firstWindow` wait. Deliberately free of Playwright and
 * Electron imports so apps/desktop/e2e-startup-diagnostics.test.ts can pin the behavior without
 * launching anything.
 */

const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/gu;

/**
 * The three conditions the globalSetup wait polls, each as milliseconds after `npm start` was
 * spawned when it first held, or null if it never did. Forge prints no step progress here: with
 * stdin not a TTY, `electron-forge start` runs non-interactive and silences its task list. The
 * conditions are what place a slow start instead. Forge's Vite plugin launches the renderer dev
 * server first and builds main and preload after it, and nothing is ready before Forge has
 * prepared native dependencies and run the generateAssets hook.
 */
export type DevServerProgress = {
  rendererServer: number | null;
  mainBuild: number | null;
  preloadBuild: number | null;
};

function seconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

export function formatDevServerProgress(progress: DevServerProgress): string {
  const at = (milliseconds: number | null): string =>
    milliseconds === null ? 'not yet' : `at ${seconds(milliseconds)}`;
  return (
    `renderer dev server listening ${at(progress.rendererServer)}, ` +
    `main build rebuilt ${at(progress.mainBuild)}, ` +
    `preload build rebuilt ${at(progress.preloadBuild)}`
  );
}

/** Which part of `electron-forge start` a wait that ended at `progress` was still in. */
export function devServerStartupPhase(progress: DevServerProgress): string {
  if (
    progress.rendererServer === null &&
    progress.mainBuild === null &&
    progress.preloadBuild === null
  )
    return (
      'before Vite (Forge was still preparing native dependencies or running the generateAssets ' +
      'hook, which compiles the Computer Use helper on Windows)'
    );
  if (progress.mainBuild === null || progress.preloadBuild === null)
    return 'Vite (the main and preload bundles had not finished building)';
  return 'Vite (every build had finished)';
}

export function lastLogLines(text: string, lineCount = 20): readonly string[] {
  return text
    .replace(ANSI_ESCAPE, '')
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-lineCount);
}

export function formatDevServerFailure(
  progress: DevServerProgress,
  logText: string,
  logPath: string,
): string {
  const tail = lastLogLines(logText);
  return [
    `Startup phase: ${devServerStartupPhase(progress)}.`,
    `Progress: ${formatDevServerProgress(progress)}.`,
    `Last lines of \`npm start\` (full log: ${logPath}):`,
    tail.length === 0 ? '  (no output)' : tail.map((line) => `  ${line}`).join('\n'),
  ].join('\n');
}

export type ProbeResult<T> =
  | Readonly<{ status: 'fulfilled'; value: T }>
  | Readonly<{ status: 'rejected'; reason: string }>
  | Readonly<{ status: 'timeout' }>;

export type MainWindowState = Readonly<{ url: string; loading: boolean }>;

export type RendererState = Readonly<{
  readyState: string;
  /** Whether DOMContentLoaded has fired; null when navigation timing is unavailable. */
  domContentLoaded: boolean | null;
}>;

/**
 * Runs inside the renderer, so it must stay self-contained. `readyState` alone cannot answer
 * whether DOMContentLoaded fired: it turns `interactive` once parsing ends, while deferred and
 * module scripts — the whole Vite dev-mode renderer — still have to arrive and run before the
 * event. Navigation timing records the event itself.
 */
export function readRendererState(): RendererState {
  const [navigation] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
  return {
    readyState: document.readyState,
    domContentLoaded: navigation === undefined ? null : navigation.domContentLoadedEventStart > 0,
  };
}

export type FirstWindowSnapshot = Readonly<{
  /** Whether Playwright's `app.firstWindow()` returned a page at all. */
  windowReported: boolean;
  /** Every BrowserWindow as the main process sees it. */
  mainWindows: ProbeResult<readonly MainWindowState[]>;
  /** The reported page's URL and document state; null when no page was reported. */
  rendererUrl: string | null;
  renderer: ProbeResult<RendererState> | null;
}>;

export type FirstWindowVerdict =
  | 'main-unresponsive'
  | 'no-window'
  | 'window-not-reported'
  | 'main-init'
  | 'renderer-load'
  | 'missed-event'
  | 'unknown';

export type FirstWindowDiagnosis = Readonly<{ verdict: FirstWindowVerdict; explanation: string }>;

const EXPLANATIONS: Readonly<Record<FirstWindowVerdict, string>> = {
  'main-unresponsive':
    'the main process did not answer (its event loop is blocked, or it has exited)',
  'no-window': 'the main process has not created a BrowserWindow',
  'window-not-reported': 'the main process has a window, but Playwright did not report it',
  'main-init':
    'the window exists but main has not started loading the renderer: main is still ' +
    'initializing before loadRenderer (apps/desktop/src/main/index.ts)',
  'renderer-load':
    'the renderer document has not arrived, or it is still waiting on its scripts (served by ' +
    'the Vite dev server in dev mode, app://bundle when packaged)',
  'missed-event':
    'the document had already passed DOMContentLoaded; Playwright did not observe the event',
  unknown: 'the collected state does not match a known cause',
};

function isBlank(url: string): boolean {
  return url === '' || url === 'about:blank';
}

/**
 * Separates the causes a `firstWindow` timeout cannot tell apart by itself.
 *
 * Playwright reports an Electron window only after its first real navigation commits (Chromium's
 * FrameSession waits for it before the page counts as initialized). So a window main never
 * navigated, or whose document has not arrived, times out in `app.firstWindow()` rather than in
 * the DOMContentLoaded wait, and only main can say which. The main process is also asked first
 * because the initial about:blank document is already `complete`: renderer state only means
 * something once main has navigated the window somewhere.
 */
export function diagnoseFirstWindow(snapshot: FirstWindowSnapshot): FirstWindowDiagnosis {
  const verdict = firstWindowVerdict(snapshot);
  return { verdict, explanation: EXPLANATIONS[verdict] };
}

function firstWindowVerdict(snapshot: FirstWindowSnapshot): FirstWindowVerdict {
  if (snapshot.mainWindows.status !== 'fulfilled') return 'main-unresponsive';
  const window = snapshot.mainWindows.value[0];
  if (window === undefined) return 'no-window';
  if (isBlank(window.url) && !window.loading) return 'main-init';
  if (!snapshot.windowReported) return window.loading ? 'renderer-load' : 'window-not-reported';
  const renderer = snapshot.renderer;
  if (
    renderer?.status === 'fulfilled' &&
    snapshot.rendererUrl !== null &&
    !isBlank(snapshot.rendererUrl)
  ) {
    const { readyState, domContentLoaded } = renderer.value;
    if (domContentLoaded === true || readyState === 'complete') return 'missed-event';
    if (domContentLoaded === false || readyState === 'loading') return 'renderer-load';
    return 'unknown';
  }
  // The renderer did not answer while main still reports the page as loading.
  if (window.loading) return 'renderer-load';
  return 'unknown';
}

function describeProbe<T>(probe: ProbeResult<T> | null, render: (value: T) => string): string {
  if (probe === null) return 'not probed (no page)';
  if (probe.status === 'fulfilled') return render(probe.value);
  if (probe.status === 'timeout') return 'no answer (timed out)';
  return `failed: ${probe.reason}`;
}

/** The lines that go into the error message itself. */
export function formatFirstWindowSummary(
  snapshot: FirstWindowSnapshot,
  diagnosis: FirstWindowDiagnosis,
): string {
  const mainWindows = describeProbe(snapshot.mainWindows, (windows) =>
    windows.length === 0
      ? 'none'
      : windows
          .map((window) => `url=${JSON.stringify(window.url)} loading=${window.loading}`)
          .join('; '),
  );
  const renderer = describeProbe(
    snapshot.renderer,
    (state) =>
      `readyState=${state.readyState} domContentLoaded=${state.domContentLoaded ?? 'unknown'}`,
  );
  return [
    `diagnosis: ${diagnosis.verdict} — ${diagnosis.explanation}`,
    `main windows: ${mainWindows}`,
    `reported page: ${snapshot.windowReported ? `url=${JSON.stringify(snapshot.rendererUrl)}` : 'none'}`,
    `document: ${renderer}`,
  ].join('\n');
}

/** The summary plus main's output, written next to the test's other results. */
export function formatFirstWindowReport(summary: string, mainOutput: string): string {
  return [
    summary,
    '--- main process output (tail) ---',
    mainOutput.length === 0 ? '(no output captured)' : mainOutput,
  ].join('\n');
}

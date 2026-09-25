import { describe, expect, it } from 'vitest';
import {
  devServerStartupPhase,
  diagnoseFirstWindow,
  formatDevServerFailure,
  formatDevServerProgress,
  formatFirstWindowReport,
  formatFirstWindowSummary,
  lastLogLines,
} from '../../tests/e2e/startup-diagnostics';
import type { FirstWindowSnapshot, RendererState } from '../../tests/e2e/startup-diagnostics';

const DEV_URL = 'http://localhost:5173/';

function rendered(state: RendererState): FirstWindowSnapshot['renderer'] {
  return { status: 'fulfilled', value: state };
}

function snapshot(overrides: Partial<FirstWindowSnapshot> = {}): FirstWindowSnapshot {
  return {
    windowReported: true,
    mainWindows: { status: 'fulfilled', value: [{ url: DEV_URL, loading: false }] },
    rendererUrl: DEV_URL,
    renderer: rendered({ readyState: 'complete', domContentLoaded: true }),
    ...overrides,
  };
}

describe('dev server startup', () => {
  const nothingYet = { rendererServer: null, mainBuild: null, preloadBuild: null };

  it('places a wait that saw nothing ready before Vite, in the generateAssets part of Forge', () => {
    expect(devServerStartupPhase(nothingYet)).toContain('generateAssets');
    expect(devServerStartupPhase({ ...nothingYet, rendererServer: 31_000 })).toContain(
      'main and preload bundles had not finished',
    );
    expect(
      devServerStartupPhase({ rendererServer: 31_000, mainBuild: 38_700, preloadBuild: 36_200 }),
    ).toContain('every build had finished');
  });

  it('reports when each readiness condition first held', () => {
    expect(
      formatDevServerProgress({ rendererServer: 31_000, mainBuild: null, preloadBuild: 36_249 }),
    ).toBe(
      'renderer dev server listening at 31.0s, main build rebuilt not yet, ' +
        'preload build rebuilt at 36.2s',
    );
  });

  it('keeps only the last lines of the log, without colors or blank lines', () => {
    // Shaped like a real Windows capture: npm banners, Forge's system check, then a failure.
    const log = [
      '',
      '> @sprint-coder/desktop@0.7.0-beta.10 start',
      '> electron-forge start',
      '',
      '\u001b[33m❯\u001b[39m Checking your system',
      '\u001b[32m✔\u001b[39m Checking your system',
      'Error: Computer Use native build child failed (exit none, error=ENOENT, signal=none)',
      'npm error Lifecycle script `start` failed with error:',
      '',
    ].join('\r\n');

    expect(lastLogLines(log, 3)).toEqual([
      '✔ Checking your system',
      'Error: Computer Use native build child failed (exit none, error=ENOENT, signal=none)',
      'npm error Lifecycle script `start` failed with error:',
    ]);
  });

  it('formats a failure with the phase, the progress, the log path, and an empty log', () => {
    const formatted = formatDevServerFailure(
      nothingYet,
      '✔ Checking your system\n',
      'C:\\repo\\test-results\\dev-server.log',
    );

    expect(formatted).toContain('Startup phase: before Vite');
    expect(formatted).toContain('Progress: renderer dev server listening not yet');
    expect(formatted).toContain('full log: C:\\repo\\test-results\\dev-server.log');
    expect(formatted).toContain('  ✔ Checking your system');
    expect(formatDevServerFailure(nothingYet, '', 'x.log')).toContain('(no output)');
  });
});

describe('firstWindow failure diagnosis', () => {
  it('blames main when it does not answer', () => {
    expect(diagnoseFirstWindow(snapshot({ mainWindows: { status: 'timeout' } })).verdict).toBe(
      'main-unresponsive',
    );
    expect(
      diagnoseFirstWindow(
        snapshot({ mainWindows: { status: 'rejected', reason: 'Target closed' } }),
      ).verdict,
    ).toBe('main-unresponsive');
  });

  it('explains an unreported window from what main sees', () => {
    // Playwright reports a window only once its first navigation commits.
    const unreported = { windowReported: false, rendererUrl: null, renderer: null };

    expect(
      diagnoseFirstWindow(snapshot({ mainWindows: { status: 'fulfilled', value: [] } })).verdict,
    ).toBe('no-window');
    expect(
      diagnoseFirstWindow(
        snapshot({
          ...unreported,
          mainWindows: { status: 'fulfilled', value: [{ url: '', loading: false }] },
        }),
      ).verdict,
    ).toBe('main-init');
    // getURL() stays empty until the first document commits, even while it is loading.
    expect(
      diagnoseFirstWindow(
        snapshot({
          ...unreported,
          mainWindows: { status: 'fulfilled', value: [{ url: '', loading: true }] },
        }),
      ).verdict,
    ).toBe('renderer-load');
    expect(diagnoseFirstWindow(snapshot(unreported)).verdict).toBe('window-not-reported');
  });

  it('does not read the initial about:blank document as a missed DOMContentLoaded', () => {
    // A new window's initial document is already `complete`; main has simply not loaded anything.
    const diagnosis = diagnoseFirstWindow(
      snapshot({
        mainWindows: { status: 'fulfilled', value: [{ url: '', loading: false }] },
        rendererUrl: 'about:blank',
      }),
    );

    expect(diagnosis.verdict).toBe('main-init');
    expect(diagnosis.explanation).toContain('loadRenderer');
  });

  it('reports a renderer still waiting on its scripts even though parsing has finished', () => {
    // A parsed document is `interactive` while module scripts are still arriving; the event
    // has not fired, as seen with a stalled module script on real Electron (Issue #608).
    const loading = { status: 'fulfilled' as const, value: [{ url: DEV_URL, loading: true }] };

    expect(
      diagnoseFirstWindow(
        snapshot({
          mainWindows: loading,
          renderer: rendered({ readyState: 'interactive', domContentLoaded: false }),
        }),
      ).verdict,
    ).toBe('renderer-load');
    expect(
      diagnoseFirstWindow(
        snapshot({
          mainWindows: loading,
          renderer: rendered({ readyState: 'loading', domContentLoaded: false }),
        }),
      ).verdict,
    ).toBe('renderer-load');
    expect(
      diagnoseFirstWindow(snapshot({ mainWindows: loading, renderer: { status: 'timeout' } }))
        .verdict,
    ).toBe('renderer-load');
  });

  it('reports a missed event only once DOMContentLoaded has fired', () => {
    // isLoading() stays true until subresources finish, after DOMContentLoaded has fired.
    expect(
      diagnoseFirstWindow(
        snapshot({
          mainWindows: { status: 'fulfilled', value: [{ url: DEV_URL, loading: true }] },
          renderer: rendered({ readyState: 'interactive', domContentLoaded: true }),
        }),
      ).verdict,
    ).toBe('missed-event');
    expect(diagnoseFirstWindow(snapshot()).verdict).toBe('missed-event');
  });

  it('admits an unknown cause instead of guessing', () => {
    expect(diagnoseFirstWindow(snapshot({ renderer: { status: 'timeout' } })).verdict).toBe(
      'unknown',
    );
    expect(
      diagnoseFirstWindow(
        snapshot({ renderer: rendered({ readyState: 'interactive', domContentLoaded: null }) }),
      ).verdict,
    ).toBe('unknown');
  });

  it('formats the state for the error and appends main output only to the report', () => {
    const state = snapshot({
      mainWindows: { status: 'fulfilled', value: [{ url: DEV_URL, loading: true }] },
      renderer: rendered({ readyState: 'interactive', domContentLoaded: false }),
    });
    const summary = formatFirstWindowSummary(state, diagnoseFirstWindow(state));

    expect(summary).toContain('diagnosis: renderer-load');
    expect(summary).toContain(`main windows: url="${DEV_URL}" loading=true`);
    expect(summary).toContain(`reported page: url="${DEV_URL}"`);
    expect(summary).toContain('document: readyState=interactive domContentLoaded=false');
    expect(
      formatFirstWindowSummary(
        snapshot({ renderer: { status: 'timeout' } }),
        diagnoseFirstWindow(snapshot()),
      ),
    ).toContain('document: no answer (timed out)');
    expect(formatFirstWindowReport(summary, '')).toContain('(no output captured)');
    expect(formatFirstWindowReport(summary, 'Team MCP bridge failed to start')).toContain(
      '--- main process output (tail) ---\nTeam MCP bridge failed to start',
    );
  });
});

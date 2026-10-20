// Sidebar collapse state (issue #12).
//
// A renderer-only per-install UI preference, so localStorage is the right home for it rather than
// the store/DB — same reasoning and the same try/catch shape as the Team view preference in App.tsx.

const SIDEBAR_COLLAPSED_KEY = 'sprint-coder:sidebar-collapsed';

/**
 * Width below which the sidebar stops being a flex sibling and becomes an overlay.
 *
 * Deliberately the same 900px the Team List View already switches at (`index.css`), so the app has
 * one narrow-viewport breakpoint rather than two that disagree. Both cases the issue names land
 * under it: the 760px minimum window size, and 200% zoom (which halves the effective CSS viewport
 * to ~590px on the default window).
 */
export const NARROW_VIEWPORT_QUERY = '(max-width: 900px)';

/** `null` when the user has never chosen — the caller then defaults by viewport width. */
export function readStoredSidebarCollapsed(): boolean | null {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    return stored === null ? null : stored === '1';
  } catch {
    return null;
  }
}

export function writeStoredSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Private mode / quota — the preference just doesn't survive the session.
  }
}

/**
 * The collapse state to start (or fall back) to.
 *
 * A narrow viewport always starts collapsed, even against a stored "expanded": below the breakpoint
 * the sidebar is an overlay, so honouring that preference on launch would cover the conversation
 * with a panel the user did not open. The preference itself is left untouched and applies again as
 * soon as there is room.
 */
export function defaultSidebarCollapsed(narrow: boolean, stored: boolean | null): boolean {
  return narrow ? true : (stored ?? false);
}

// Sidebar width. Same storage reasoning as the collapse state above: a per-install layout
// preference that never needs to leave the renderer.

const SIDEBAR_WIDTH_KEY = 'sprint-coder:sidebar-width';

export const SIDEBAR_DEFAULT_WIDTH = 264;
export const SIDEBAR_MIN_WIDTH = 208;
export const SIDEBAR_MAX_WIDTH = 480;
/**
 * The conversation column keeps at least this much beside a widened sidebar, so a drag can never
 * squeeze the Composer below the width its controls fit in.
 */
export const MAIN_MIN_WIDTH = 520;

/** Docked right-hand panels, mirrored from index.css: `.graph-panel` and `.team-list-view`. */
const TEAM_LIST_DOCKED_WIDTH = 460;
const GRAPH_PANEL_MAX_WIDTH = 900;
const GRAPH_PANEL_VIEWPORT_SHARE = 0.52;

/**
 * The width the sidebar and the conversation share: the window minus whatever panel is docked on
 * the right, since that panel takes its width before the conversation does.
 */
export function sidebarAvailableWidth(
  viewportWidth: number,
  docked: { graph: boolean; teamList: boolean },
): number {
  let panel = 0;
  if (docked.graph) {
    panel += Math.min(viewportWidth * GRAPH_PANEL_VIEWPORT_SHARE, GRAPH_PANEL_MAX_WIDTH);
  }
  if (docked.teamList) panel += TEAM_LIST_DOCKED_WIDTH;
  return viewportWidth - panel;
}

/** The widest the sidebar may be beside this much room — never below the minimum. */
export function maxSidebarWidth(availableWidth: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, availableWidth - MAIN_MIN_WIDTH));
}

export function clampSidebarWidth(width: number, availableWidth: number): number {
  return Math.round(Math.min(maxSidebarWidth(availableWidth), Math.max(SIDEBAR_MIN_WIDTH, width)));
}

/** `null` when nothing usable is stored — the caller then uses the default width. */
export function readStoredSidebarWidth(): number | null {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (stored === null) return null;
    const width = Number(stored);
    return Number.isFinite(width) ? width : null;
  } catch {
    return null;
  }
}

export function writeStoredSidebarWidth(width: number): void {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(width)));
  } catch {
    // Private mode / quota — the width just doesn't survive the session.
  }
}

/** ⌘B on macOS, Ctrl+B elsewhere — see the toggle shortcut in App.tsx. */
export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');
}
export const SIDEBAR_SHORTCUT_LABEL = isMacPlatform() ? '⌘B' : 'Ctrl+B';
export const SIDEBAR_SHORTCUT_ARIA = isMacPlatform() ? 'Meta+B' : 'Control+B';

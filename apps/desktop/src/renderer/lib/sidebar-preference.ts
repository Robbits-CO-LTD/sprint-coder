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

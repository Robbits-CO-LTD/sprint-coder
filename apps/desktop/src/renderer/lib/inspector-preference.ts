// Inspector panel width state (issue #16).
//
// Renderer-only per-install UI preference, so localStorage is its home rather than the store/DB —
// same reasoning and the same try/catch shape as the Team view preference in App.tsx.

/**
 * Progressive disclosure, four states.
 *
 * `hidden` is the default on purpose: every existing E2E baseline was recorded without this panel,
 * and a panel that appears unbidden would change the measured layout of specs that have nothing to
 * do with it.
 */
export const INSPECTOR_STATES = ['hidden', 'rail', 'panel', 'wide'] as const;
export type InspectorState = (typeof INSPECTOR_STATES)[number];

export const INSPECTOR_WIDTH: Record<InspectorState, number> = {
  hidden: 0,
  rail: 44,
  panel: 380,
  wide: 560,
};

const INSPECTOR_STATE_KEY = 'sprint-coder:inspector-state';

export function readStoredInspectorState(): InspectorState {
  try {
    const stored = window.localStorage.getItem(INSPECTOR_STATE_KEY);
    return isInspectorState(stored) ? stored : 'hidden';
  } catch {
    return 'hidden';
  }
}

export function writeStoredInspectorState(state: InspectorState): void {
  try {
    window.localStorage.setItem(INSPECTOR_STATE_KEY, state);
  } catch {
    // Private mode / quota — the preference just doesn't survive the session.
  }
}

function isInspectorState(value: string | null): value is InspectorState {
  return value !== null && (INSPECTOR_STATES as readonly string[]).includes(value);
}

/** Cycles hidden → panel → wide → rail → hidden, the order a single toggle should walk. */
export function nextInspectorState(current: InspectorState): InspectorState {
  switch (current) {
    case 'hidden':
      return 'panel';
    case 'panel':
      return 'wide';
    case 'wide':
      return 'rail';
    default:
      return 'hidden';
  }
}

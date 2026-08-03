// Team view preference (Slice 6.1 item 4, List fallback): renderer-only, not part of the
// persisted Task/Team domain — a per-install UI preference, so localStorage is the right home for
// it rather than the store/DB. Canvas is the default per the task's constraints.

export type TeamViewPreference = 'canvas' | 'list';

const TEAM_VIEW_PREFERENCE_KEY = 'sprint-coder:team-view-preference';

export function readStoredTeamViewPreference(): TeamViewPreference {
  try {
    return window.localStorage.getItem(TEAM_VIEW_PREFERENCE_KEY) === 'list' ? 'list' : 'canvas';
  } catch {
    return 'canvas';
  }
}

export function writeStoredTeamViewPreference(preference: TeamViewPreference): void {
  try {
    window.localStorage.setItem(TEAM_VIEW_PREFERENCE_KEY, preference);
  } catch {
    // Best-effort only — a failed write just means the preference resets to 'canvas' next launch.
  }
}

export const SETUP_COMPLETE_KEY = 'sprint-coder:setup-complete-v1';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readSetupComplete(): boolean {
  return storage()?.getItem(SETUP_COMPLETE_KEY) === '1';
}

export function writeSetupComplete(): void {
  storage()?.setItem(SETUP_COMPLETE_KEY, '1');
}

/** Settings' "セットアップをもう一度" asks the app shell, which owns both Settings and the Setup,
 * to close the one and open the other. */
export const SETUP_REPLAY_EVENT = 'sprint-coder:setup-replay';

export function requestSetupReplay(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(SETUP_REPLAY_EVENT));
}

// Whether a Setup is on screen right now (the first run, or a replay). The app shell sets it;
// Settings reads it so "セットアップをもう一度" is not offered while one is already running.
let setupShowing = false;
const showingListeners = new Set<() => void>();

export function setSetupShowing(showing: boolean): void {
  if (setupShowing === showing) return;
  setupShowing = showing;
  for (const listener of showingListeners) listener();
}

export function isSetupShowing(): boolean {
  return setupShowing;
}

export function subscribeSetupShowing(listener: () => void): () => void {
  showingListeners.add(listener);
  return () => showingListeners.delete(listener);
}

export function shouldShowSetupWizard(input: {
  initialized: boolean;
  taskCount: number;
  setupComplete: boolean;
}): boolean {
  return input.initialized && input.taskCount === 0 && !input.setupComplete;
}

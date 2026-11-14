/**
 * Which Setup a person has been through. Raise it when the Setup changes enough that everyone
 * should see it again: the mark of an older one is no longer read, so the next launch shows the
 * new Setup to every profile — the first run's form when there is no Task yet, and the form
 * without the Workspace step (the one "セットアップをもう一度" opens) to people who already work
 * here. v1 was the Setup before #1238.
 */
export const SETUP_VERSION = 2;
export const SETUP_COMPLETE_KEY = `sprint-coder:setup-complete-v${SETUP_VERSION}`;

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

/** What the launch shows: the first run's Setup (no Task yet), the same Setup without the Workspace
 * step over the app (Tasks already exist, as after an update), or nothing (this Setup was already
 * gone through). `null` until the app has read its Tasks, so nothing is decided on a guess. */
export type LaunchSetup = 'first-run' | 'returning' | 'none';

export function launchSetupFor(input: {
  initialized: boolean;
  taskCount: number;
  setupComplete: boolean;
}): LaunchSetup | null {
  if (!input.initialized) return null;
  if (input.setupComplete) return 'none';
  return input.taskCount === 0 ? 'first-run' : 'returning';
}

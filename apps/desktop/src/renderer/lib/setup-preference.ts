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

/** Whether this Setup was gone through, or `null` when the mark cannot be read at all (no storage,
 * or a storage that throws): then the app cannot remember a Setup it shows. */
export function readSetupMark(): boolean | null {
  try {
    const store = storage();
    return store === null ? null : store.getItem(SETUP_COMPLETE_KEY) === '1';
  } catch {
    return null;
  }
}

export function readSetupComplete(): boolean {
  return readSetupMark() === true;
}

/** Marks this Setup as gone through. Never throws: a storage that refuses the write (full, or
 * blocked) only means the Setup is offered again, and closing a Setup must not depend on it. */
export function writeSetupComplete(): void {
  try {
    storage()?.setItem(SETUP_COMPLETE_KEY, '1');
  } catch {
    // Nothing to do: the mark is a convenience, not a condition for anything.
  }
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

/**
 * `setupMark` is `readSetupMark()`: `null` when the mark cannot be read. `tasksLoadFailed` is
 * whether the launch could not read the Tasks (they then look like none).
 *
 * Two cases show nothing rather than guess:
 * - The Tasks could not be read. "No Task" is then not known to be true, and the first run's
 *   Setup holds the whole window with no way out but making a Task, which the same failure would
 *   likely refuse too. Nothing is marked, so the next launch decides again.
 * - The mark cannot be read and Tasks exist. A Setup shown then could never be remembered, so it
 *   would come back over the app at every launch. A new installation (no Task) still gets its
 *   first run, as it always did.
 */
export function launchSetupFor(input: {
  initialized: boolean;
  taskCount: number;
  setupMark: boolean | null;
  tasksLoadFailed?: boolean;
}): LaunchSetup | null {
  if (!input.initialized) return null;
  if (input.setupMark === true) return 'none';
  if (input.tasksLoadFailed === true) return 'none';
  if (input.taskCount === 0) return 'first-run';
  return input.setupMark === null ? 'none' : 'returning';
}

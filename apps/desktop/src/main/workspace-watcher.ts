import { watch, type FSWatcher } from 'node:fs';
import { relative, sep } from 'node:path';

// Watches a Workspace for files a Runtime changes, so the UI can show contents the CLI never
// reports (issue #39).
//
// Why a watcher and not just the CLI's events: Codex emits `file_change` with a path and a kind and
// no body at all, and it applies patches by writing a temp file and renaming — so there is nothing
// to stream and nothing to tail.
//
// Note what this is NOT for. Measured on macOS against codex-cli 0.144.4, a watcher notification
// arrives ~270ms AFTER the CLI's own `item.completed` for the same write (14341ms vs 14175ms from
// turn start), because FSEvents has its own latency on top of this debounce. Reading the file when
// the CLI reports the change is the faster path, and Main does that too.
//
// The watcher earns its place on coverage, not speed: it sees writes no CLI reports at all — a file
// a shell command rewrote, a formatter that ran on save, anything outside a reported tool call.
//
// `fs.watch` with `recursive: true` rather than a dependency: it is native on macOS (FSEvents) and
// Windows (ReadDirectoryChangesW), which are the platforms this ships on. Linux does not support
// recursive mode, and rather than silently watching only the root directory, `start` reports that it
// could not watch — a watcher that quietly sees nothing is worse than a known absence.
//
// Node coalesces nothing, so a single `apply_patch` can produce several events for one file. The
// debounce below collapses them, which is also what keeps a whole-file re-read off the hot path.

/** Directories never worth watching: build output and VCS internals churn constantly and are not
 * what anyone is watching the model write. Matched as a path segment, so `src/git-utils` is safe. */
const IGNORED_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.vite',
  'coverage',
  '.turbo',
  'target',
  '__pycache__',
  '.venv',
]);

/** Long enough to collapse the burst of a multi-write patch, short enough to feel immediate. */
const DEBOUNCE_MS = 70;

/** A single Turn changing more distinct files than this is a bulk operation, not something to
 * follow file by file; past the cap the watcher stops emitting rather than flooding the renderer. */
const MAX_TRACKED_FILES = 24;

export type WorkspaceWatcher = { stop: () => void };

export function watchWorkspace(
  workspacePath: string,
  onChanged: (relativePath: string) => void,
): WorkspaceWatcher | null {
  let watcher: FSWatcher;
  try {
    watcher = watch(workspacePath, { recursive: true, persistent: false });
  } catch {
    // Recursive watching unsupported (Linux) or the directory vanished. The rest of the app is
    // unaffected: file changes still appear as `files.changed`, just without their contents.
    return null;
  }
  const timers = new Map<string, NodeJS.Timeout>();
  const seen = new Set<string>();
  let stopped = false;

  watcher.on('error', () => {
    // A watch that dies mid-Turn (the directory was moved, the OS ran out of handles) must not take
    // the Turn with it.
    stop();
  });
  watcher.on('change', (_event, filename) => {
    if (stopped || filename === null || filename === undefined) return;
    const relativePath = typeof filename === 'string' ? filename : filename.toString('utf8');
    if (!isWatchable(workspacePath, relativePath)) return;
    if (!seen.has(relativePath)) {
      if (seen.size >= MAX_TRACKED_FILES) return;
      seen.add(relativePath);
    }
    const existing = timers.get(relativePath);
    if (existing !== undefined) clearTimeout(existing);
    timers.set(
      relativePath,
      setTimeout(() => {
        timers.delete(relativePath);
        if (!stopped) onChanged(relativePath);
      }, DEBOUNCE_MS),
    );
  });

  function stop(): void {
    if (stopped) return;
    stopped = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    try {
      watcher.close();
    } catch {
      // Already closed; nothing to recover.
    }
  }

  return { stop };
}

/**
 * Whether a reported path is one to read back.
 *
 * Rejects anything that escapes the Workspace, anything under an ignored directory, and editors'
 * transient siblings — a `.swp` or `4913` file is an artifact of the write, not the write.
 */
export function isWatchable(workspacePath: string, relativePath: string): boolean {
  if (relativePath.length === 0 || relativePath.length > 1024) return false;
  // `fs.watch` reports paths relative to the watched root, but a rename can deliver an absolute one
  // on some platforms; normalise before judging it.
  const normalized = relativePath.startsWith(sep)
    ? relative(workspacePath, relativePath)
    : relativePath;
  if (normalized.length === 0 || normalized.startsWith('..')) return false;
  const segments = normalized.split(/[\\/]/);
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return false;
  const name = segments[segments.length - 1] ?? '';
  if (name.length === 0) return false;
  // Editor and tool scratch files. `~`-suffixed backups, vim swap files, and the numeric probe
  // files vim creates all appear during a write and disappear after it.
  if (name.endsWith('~') || name.endsWith('.swp') || name.endsWith('.swx')) return false;
  if (name.startsWith('.#') || /^\d+$/.test(name)) return false;
  return true;
}

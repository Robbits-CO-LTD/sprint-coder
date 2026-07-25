import { execFile } from 'node:child_process';
import { readWorkspaceTextFile } from './workspace-file';

// Resolves the "before" side of a file's diff for one Turn (issue #41).
//
// The after side is easy — it is what the Runtime just wrote. The before side is the whole problem,
// because by the time anyone asks, the file on disk has already changed.
//
// `git show HEAD:<path>` answers it exactly and at any time, which is why it is preferred: verified
// on codex-cli 0.144.4 that it still returns the original content after Codex has rewritten the
// file, so there is no snapshot to take and no race to lose.
//
// But HEAD is NOT "the file as the Turn found it". A user with uncommitted work in progress would
// see their own edits folded into the model's diff — the app would be attributing their changes to
// the model, which is worse than showing no diff at all. So `git status --porcelain` is read once at
// Turn start, and HEAD is used only for the paths that were clean at that moment. Everything else
// falls back to reading the file the first time this Turn hears about it, which is accurate when the
// path is known before the write (Claude names the file in the tool call) and impossible when it is
// not (a watcher only ever sees a file that has already changed).
//
// "No baseline" is therefore a normal outcome, not a failure. The caller shows the full text instead
// of a diff and says so.

const GIT_TIMEOUT_MS = 5_000;
/** A file larger than this is not one anyone reads as a diff in a side panel. */
const MAX_BASELINE_BYTES = 262_144;

export type EditBaselines = {
  /** Records that this Turn is about to touch `relativePath`, if it has not already. Safe to call
   * repeatedly; only the first call for a path decides the baseline. */
  note: (relativePath: string) => void;
  /** The content this Turn found at that path, or null if it cannot be established. */
  get: (relativePath: string) => Promise<string | null>;
};

export function createEditBaselines(
  workspacePath: string,
  deps: {
    git?: (args: string[]) => Promise<string | null>;
    readFile?: (workspacePath: string, relativePath: string) => string | null;
  } = {},
): EditBaselines {
  const git = deps.git ?? ((args) => runGit(workspacePath, args));
  const readFile = deps.readFile ?? readWorkspaceTextFile;

  // Started immediately and awaited lazily: a Turn's first file usually arrives hundreds of
  // milliseconds later, so this is normally resolved by the time anything needs it, and nothing
  // blocks on it if it is not.
  const cleanPaths = git(['status', '--porcelain', '--untracked-files=all']).then((output) =>
    output === null ? null : dirtyPathsFrom(output),
  );
  const baselines = new Map<string, Promise<string | null>>();

  return {
    note(relativePath) {
      if (baselines.has(relativePath)) return;
      // Read from disk NOW, before the write lands, and hold it as the fallback. This has to happen
      // synchronously at note() time: a moment later the file is the after-image and the chance is
      // gone. `null` here (file does not exist yet, or is binary) is a legitimate answer meaning
      // "there was nothing before this".
      const preWrite = readFile(workspacePath, relativePath);
      baselines.set(
        relativePath,
        cleanPaths.then(async (dirty) => {
          // Not a git repository, or git is unavailable: the pre-write read is all there is.
          if (dirty === null) return preWrite;
          // The file already differed from HEAD when the Turn started, so HEAD would show the
          // user's own work as part of the model's change.
          if (dirty.has(relativePath)) return preWrite;
          const committed = await git(['show', `HEAD:${relativePath}`]);
          // Untracked, or no commits yet: `git show` fails, and that failure is informative — the
          // file did not exist in HEAD, so the pre-write read (usually null) is correct.
          return committed ?? preWrite;
        }),
      );
    },
    async get(relativePath) {
      const pending = baselines.get(relativePath);
      if (pending === undefined) return null;
      return pending;
    },
  };
}

/** Paths that already differed from HEAD when the Turn began, including untracked ones. */
export function dirtyPathsFrom(porcelain: string): Set<string> {
  const paths = new Set<string>();
  for (const line of porcelain.split('\n')) {
    // `XY <path>`; a rename is `R  old -> new` and both sides are suspect.
    if (line.length < 4) continue;
    const rest = line.slice(3);
    for (const part of rest.split(' -> ')) {
      const path = unquoteGitPath(part.trim());
      if (path.length > 0) paths.add(path);
    }
  }
  return paths;
}

/** git quotes paths with unusual bytes as a C string; a mis-parsed name must not read as clean. */
function unquoteGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value;
  }
}

function runGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [
        // Same hardening as worker-worktree.ts: a repository must not be able to run code because
        // the app looked at it.
        '-c',
        'core.hooksPath=',
        '-c',
        'core.fsmonitor=',
        '-c',
        'core.pager=cat',
        '-C',
        cwd,
        ...args,
      ],
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_BASELINE_BYTES,
        windowsHide: true,
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: process.env['HOME'] ?? '',
          // No credential helper, no editor, no locale-dependent output.
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          LC_ALL: 'C',
        },
      },
      (error, stdout) => {
        // Every failure is the same answer here: not a repository, path not in HEAD, git missing,
        // output too large. None of them are worth distinguishing — each means "no baseline".
        resolve(error === null ? stdout : null);
      },
    );
  });
}

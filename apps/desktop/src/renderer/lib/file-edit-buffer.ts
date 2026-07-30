import type { FileEditFrame } from '../types/sprint-coder';
import { changedLineIndices } from './changed-lines';

// Live file bodies, held outside zustand (issue #39).
//
// Same reasoning as lib/reasoning-buffer.ts, and for a stream that is heavier still: a file body
// arrives at the model's typing speed, and putting it in the store would make every frame a store
// update and every update a re-render of every subscriber. Only the panel that displays it reads
// this, through a single rAF loop.
//
// `version` is the whole API for change detection: a reader compares it to what it last saw. That
// makes "did anything change" an integer compare rather than a string compare of a file body.

export type LiveFileEdit = {
  turnId: string;
  path: string;
  text: string;
  complete: boolean;
  source: 'stream' | 'disk';
  /** The file as the Turn found it, once Main could establish it (issue #41). Null means no honest
   * comparison exists and the full text is shown instead. */
  baseline: string | null;
  /** Line indices that differ from the previous frame of this same file.
   *
   * Computed here, once per frame, rather than in the component. Deriving it during render would
   * mean holding the previous body in a ref and reading it while rendering — which is not safe under
   * concurrent rendering and which `react-hooks/refs` rejects — and would recompute the diff on
   * every re-render rather than on every frame. */
  changed: Set<number>;
  /** Monotonic per file — the order files were first written in, so the view is stable. */
  order: number;
};

const byKey = new Map<string, LiveFileEdit>();
let version = 0;
let nextOrder = 0;
let currentTaskId: string | null = null;

export function fileEditVersion(): number {
  return version;
}

export function applyFileEditFrame(frame: FileEditFrame): void {
  // Frames are per-task and the panel only ever shows the selected one. Switching tasks clears
  // rather than filters, so a long-running Turn on another Task cannot leak its file body into the
  // view of the Task the user is actually looking at.
  if (currentTaskId !== frame.taskId) {
    byKey.clear();
    currentTaskId = frame.taskId;
  }
  const key = `${frame.turnId} ${frame.path}`;
  const existing = byKey.get(key);
  byKey.set(key, {
    turnId: frame.turnId,
    path: frame.path,
    text: frame.text,
    complete: frame.complete,
    source: frame.source,
    // A later frame carrying only the baseline must not lose one already held, and a frame that
    // brings one must not be overwritten by a stale null.
    baseline: frame.baseline ?? existing?.baseline ?? null,
    changed: changedLineIndices(existing?.text ?? '', frame.text),
    order: existing?.order ?? nextOrder++,
  });
  // Bounded: a Turn touching hundreds of files must not grow this without limit. The oldest go
  // first, which is also the least interesting — the view follows what is being written now.
  if (byKey.size > 12) {
    const oldest = [...byKey.entries()].sort((a, b) => a[1].order - b[1].order)[0];
    if (oldest !== undefined) byKey.delete(oldest[0]);
  }
  version += 1;
}

/** Newest first: the file being written now is the one worth showing at the top. */
export function readFileEdits(): LiveFileEdit[] {
  return [...byKey.values()].sort((a, b) => b.order - a.order);
}

export function clearFileEdits(): void {
  byKey.clear();
  currentTaskId = null;
  version += 1;
}

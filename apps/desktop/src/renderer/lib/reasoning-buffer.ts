// Renderer-side coalescing for the reasoning stream (issue #17).
//
// Main already batches at 120ms, but that bound is on *bytes leaving main*, not on React commits: a
// burst that trips the 4KB early-flush can deliver several batches within one frame. The existing
// `message.delta` path re-renders once per delta and only survives because the mock chunks a reply
// into 32 pieces; the reasoning stream is denser, so a second stage absorbs it here.
//
// The text itself is kept OUT of the zustand store on purpose. Putting it there would make every
// fragment a store update, and every store update a re-render of every subscriber — the panel is the
// only thing that needs the text, so it reads from this module-level buffer via rAF instead.

/** Accumulated reasoning for one turn. */
type Entry = { text: string; truncated: boolean };

const buffers = new Map<string, Entry>();
let version = 0;

/** Bumped on every append. Subscribers compare it to decide whether a repaint is needed. */
export function reasoningVersion(): number {
  return version;
}

export function appendReasoning(turnId: string, text: string, truncated: boolean): void {
  const existing = buffers.get(turnId) ?? { text: '', truncated: false };
  buffers.set(turnId, {
    text: existing.text + text,
    // Latches: once a turn's reasoning was truncated it stays truncated, so a later clean batch
    // cannot make an incomplete trail look complete.
    truncated: existing.truncated || truncated,
  });
  version += 1;
}

export function readReasoning(turnId: string): Entry {
  return buffers.get(turnId) ?? { text: '', truncated: false };
}

/**
 * Drops everything but the given turns.
 *
 * Called when the active turn changes rather than on every append: reasoning is not persisted, so
 * the only thing keeping old turns' text alive is this map, and it would otherwise grow for the
 * lifetime of the window.
 */
export function pruneReasoning(keep: readonly string[]): void {
  const keepSet = new Set(keep);
  for (const turnId of [...buffers.keys()]) if (!keepSet.has(turnId)) buffers.delete(turnId);
}

/** Test seam. */
export function resetReasoningBuffer(): void {
  buffers.clear();
  version = 0;
}

/**
 * Splits accumulated reasoning into paragraphs.
 *
 * Paragraph boundaries — not tokens — are what the UI animates on: animating per token turns a
 * reasoning stream into a strobe, and the issue is explicit that new text should appear at paragraph
 * granularity. A trailing partial paragraph is included so the newest thought is visible while it is
 * still being written.
 */
export function reasoningParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '');
}

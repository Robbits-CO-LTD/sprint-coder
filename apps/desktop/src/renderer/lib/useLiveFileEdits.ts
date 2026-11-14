import { useEffect, useState } from 'react';
import {
  fileEditVersion,
  readFileEdits,
  subscribeFileEdits,
  type LiveFileEdit,
} from './file-edit-buffer';

/**
 * The live file bodies, read at most once a frame (issue #45).
 *
 * Keeps timeline summaries subscribed to the shared file-edit buffer without copying file bodies
 * into the application store.
 *
 * A frame rather than a store subscription for the reason the buffer exists at all: these arrive at
 * the model's typing speed, and a store update per arrival would re-render every subscriber in the
 * app. The frame is asked for only when the buffer says it changed (and once at the start, to catch
 * up with anything written before this listened), so nothing runs while no file is being written
 * (issue #1242: the loop used to turn every frame for as long as the app was open).
 */
export function useLiveFileEdits(): LiveFileEdit[] {
  const [edits, setEdits] = useState<LiveFileEdit[]>(() => readFileEdits());
  useEffect(() => {
    let frame: number | null = null;
    let lastVersion = -1;
    const read = (): void => {
      frame = null;
      const current = fileEditVersion();
      if (current === lastVersion) return;
      lastVersion = current;
      setEdits(readFileEdits());
    };
    const schedule = (): void => {
      frame ??= window.requestAnimationFrame(read);
    };
    const unsubscribe = subscribeFileEdits(schedule);
    schedule();
    return () => {
      unsubscribe();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, []);
  return edits;
}

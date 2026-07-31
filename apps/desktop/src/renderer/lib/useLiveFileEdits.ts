import { useEffect, useState } from 'react';
import { fileEditVersion, readFileEdits, type LiveFileEdit } from './file-edit-buffer';

/**
 * The live file bodies, polled through one rAF loop (issue #45).
 *
 * Keeps timeline summaries subscribed to the shared file-edit buffer without copying file bodies
 * into the application store.
 *
 * rAF rather than a store subscription for the reason the buffer exists at all: these arrive at the
 * model's typing speed, and a store update per frame would re-render every subscriber in the app.
 */
export function useLiveFileEdits(): LiveFileEdit[] {
  const [edits, setEdits] = useState<LiveFileEdit[]>(() => readFileEdits());
  useEffect(() => {
    let frame = 0;
    let lastVersion = -1;
    const tick = (): void => {
      const current = fileEditVersion();
      if (current !== lastVersion) {
        lastVersion = current;
        setEdits(readFileEdits());
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, []);
  return edits;
}

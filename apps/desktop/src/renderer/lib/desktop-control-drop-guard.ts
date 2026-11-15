import type { DesktopControlActivity } from '@sprint-coder/contracts';

type SubscribeActivity = (listener: (activity: DesktopControlActivity) => void) => () => void;

const DRAG_EVENTS = ['dragenter', 'dragover', 'drop'] as const;

/**
 * While Main says a desktop-control run may be moving the pointer, the whole window refuses drops
 * from outside: text into a textarea, input or contenteditable, and files (attaching or navigating)
 * alike. A physical drag the run refuses over Sprint Coder is let go at its origin, which may be
 * covered by this window; refusing here turns that release into a cancelled drag instead of a drop.
 *
 * Listening on the window in the capture phase runs before any element's own handler. `dragenter`
 * and `dragover` are cancelled with the drop effect `none`, which is how a page says the drop is
 * not accepted (so no `drop` follows); a `drop` that still arrives is cancelled so nothing is
 * inserted. Nothing is shown. Once Main lowers it, drags and drops work as they always did.
 */
export function installDesktopControlDropGuard(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  subscribeActivity: SubscribeActivity | undefined,
): () => void {
  let refusing = false;
  const refuse = (event: Event): void => {
    if (!refusing) return;
    event.preventDefault();
    event.stopPropagation();
    const transfer = (event as Partial<DragEvent>).dataTransfer;
    if (transfer !== null && transfer !== undefined) {
      try {
        transfer.dropEffect = 'none';
      } catch {
        // Read-only outside a drag-and-drop operation; cancelling the event is what counts.
      }
    }
  };
  for (const type of DRAG_EVENTS) target.addEventListener(type, refuse, { capture: true });
  const unsubscribe =
    subscribeActivity?.((activity) => {
      refusing = activity.active;
    }) ?? (() => undefined);
  return () => {
    unsubscribe();
    for (const type of DRAG_EVENTS) target.removeEventListener(type, refuse, { capture: true });
    refusing = false;
  };
}

import { useCallback, useSyncExternalStore } from 'react';

/**
 * Tracks a CSS media query from React.
 *
 * `matchMedia` rather than a resize listener because the browser already evaluates the query and
 * only notifies on an actual state change — a resize handler would fire on every pixel of a window
 * drag and re-render the whole shell each time.
 *
 * `useSyncExternalStore` rather than useState + useEffect because that is literally what this is: a
 * subscription to a value React does not own. It also removes the tear this hook would otherwise
 * have — a query that flips between the initial render and the subscribe would need a setState
 * inside the effect to catch up (which `react-hooks/set-state-in-effect` correctly rejects), whereas
 * the snapshot getter is re-read on subscribe for free.
 *
 * Under Electron's page zoom this reacts as intended: `setZoomFactor` shrinks the effective CSS
 * viewport, so `(max-width: 900px)` starts matching at 200% zoom on a window that does not match at
 * 100%. That is exactly the case issue #12 is about.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onStoreChange);
      return () => list.removeEventListener('change', onStoreChange);
    },
    [query],
  );
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  // Server snapshot: this renderer never server-renders, but the argument is required and "not
  // narrow" is the safer default for a layout that only collapses as an accommodation.
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

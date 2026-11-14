// Tells a canvas when the screen's pixel ratio changes.
//
// A canvas sizes its backing store from its box and `devicePixelRatio`. A ResizeObserver covers the
// box; it says nothing when only the ratio changes — a window moved to a screen of another density
// that keeps its size in CSS pixels, or a page zoom that leaves the box as it was. Without this,
// such a canvas stays at the old resolution (soft, or needlessly large) until something resizes it.
//
// There is no event for the ratio itself. A media query for the current ratio stops matching the
// moment it changes, so one is watched, and replaced by one for the new ratio each time it fires.

/** Calls `onChange` each time `devicePixelRatio` changes. Returns the way to stop watching. */
export function watchPixelRatio(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  let query: MediaQueryList | null = null;
  let watched = 0;
  const forget = () => {
    try {
      query?.removeEventListener('change', changed);
    } catch {
      // Nothing was being listened to.
    }
    query = null;
  };
  const watch = () => {
    watched = window.devicePixelRatio || 1;
    try {
      const next = window.matchMedia(`(resolution: ${watched}dppx)`);
      next.addEventListener('change', changed);
      query = next;
    } catch {
      // No such query here (an old engine, a test's stand-in): the canvas keeps following its box.
      query = null;
    }
  };
  function changed(): void {
    // Told of a change that is not one (the ratio is what it was): keep watching as before.
    if ((window.devicePixelRatio || 1) === watched) return;
    forget();
    watch();
    onChange();
  }
  watch();
  return forget;
}

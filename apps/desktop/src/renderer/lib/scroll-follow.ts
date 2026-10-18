// Scroll-follow arithmetic for the chat Timeline (issue #3).
//
// Kept as pure functions on a plain metrics object rather than reading the element inline, so the
// "is the reader still pinned to the bottom?" decision is unit-testable without a DOM — the
// renderer suite runs on react-dom/server and has no jsdom (see components/Markdown.adversarial.test.tsx).

/**
 * How far from the exact bottom still counts as "pinned".
 *
 * Needs to be > 0 for two reasons: sub-pixel `scrollHeight`/`clientHeight` rounding means a
 * scrollport that is visually at the bottom often reports a residual 0.5–1px, and a reader who
 * nudges the wheel a notch without meaning to leave the live tail should not lose autoscroll.
 * 40px is under one line-height of chat text (20px gap + ~22px line), so it cannot span a whole
 * message — scrolling up far enough to read anything at all already exceeds it.
 */
export const FOLLOW_THRESHOLD_PX = 40;

export type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/** Pixels of content below the bottom edge of the scrollport. */
export function distanceFromBottom({
  scrollTop,
  scrollHeight,
  clientHeight,
}: ScrollMetrics): number {
  return scrollHeight - clientHeight - scrollTop;
}

/**
 * True while the reader is at (or within `threshold` of) the bottom — i.e. while autoscroll should
 * keep following new tokens.
 *
 * Content shorter than the scrollport reports `scrollHeight === clientHeight` and `scrollTop === 0`,
 * giving distance 0, so a timeline with nothing to scroll is always "pinned" and never offers a
 * jump-to-latest affordance. Rubber-band overscroll reports a negative distance and stays pinned.
 */
export function isPinnedToBottom(metrics: ScrollMetrics, threshold = FOLLOW_THRESHOLD_PX): boolean {
  return distanceFromBottom(metrics) <= threshold;
}

/** The part of the scrollport the tail follower writes to. */
export type TailScrollTarget = { scrollTop: number; readonly scrollHeight: number };

export type TailFollower = {
  /** Scrolls `target` to the tail on the next frame, once however many updates ask before it. */
  schedule(target: TailScrollTarget | null): void;
  /** Scrolls `target` to the tail now (task switch, 最新へ) and resumes following. */
  scrollNow(target: TailScrollTarget | null): void;
  /**
   * Whether a scroll event still means "following". The scroll handler calls it synchronously,
   * so a reader who scrolls up before an already scheduled frame is not pulled back down.
   */
  observeScroll(target: TailScrollTarget, pinned: boolean): boolean;
  /**
   * The reader asked to read something above the tail without scrolling (opening a collapsed
   * group grows the content but moves nothing, so no scroll event says so). Following stops until
   * 最新へ or a scroll back to the bottom.
   */
  stopFollowing(): void;
  /** Drops a scheduled scroll (unmount). */
  cancel(): void;
};

/**
 * Coalesces "follow the tail" into one scroll per frame (issue #863): reading `scrollHeight`
 * forces a layout of the whole Timeline, and several store updates can land in one frame.
 *
 * A scroll event decides whether the reader is still following. It is not enough to ask whether
 * the scrollport is at the bottom: content that grew after the follower's own scroll and before
 * the event leaves it short of the bottom without the reader having moved. So an event whose
 * position is still the one the follower wrote keeps following; any other position away from the
 * bottom is the reader leaving the tail, which takes effect at once — the frame callback checks it
 * — even though React has not committed the "not following" render yet.
 */
export function createTailFollower(
  frames: {
    request: (callback: () => void) => number;
    cancel: (handle: number) => void;
  } = {
    request: (callback) => requestAnimationFrame(callback),
    cancel: (handle) => cancelAnimationFrame(handle),
  },
): TailFollower {
  let following = true;
  let pending: number | null = null;
  let writtenTop: number | null = null;
  const cancel = (): void => {
    if (pending !== null) frames.cancel(pending);
    pending = null;
  };
  const write = (target: TailScrollTarget): void => {
    target.scrollTop = target.scrollHeight;
    writtenTop = target.scrollTop;
  };
  return {
    schedule(target) {
      if (target === null || !following || pending !== null) return;
      pending = frames.request(() => {
        pending = null;
        if (following) write(target);
      });
    },
    scrollNow(target) {
      following = true;
      if (target !== null) write(target);
    },
    stopFollowing() {
      following = false;
      cancel();
    },
    observeScroll(target, pinned) {
      const own = writtenTop !== null && Math.abs(target.scrollTop - writtenTop) <= 1;
      following = pinned || (following && own);
      if (!following) cancel();
      return following;
    },
    cancel,
  };
}

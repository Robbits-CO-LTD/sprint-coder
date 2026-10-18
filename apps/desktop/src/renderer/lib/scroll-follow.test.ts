import { describe, expect, it } from 'vitest';
import {
  FOLLOW_THRESHOLD_PX,
  createTailFollower,
  distanceFromBottom,
  isPinnedToBottom,
} from './scroll-follow';

// Issue #3: the chat Timeline used to force `scrollTop = scrollHeight` on every streaming token,
// which yanked a reader who had scrolled up back to the bottom. These cases pin down the
// "should autoscroll still follow?" predicate that now guards it.

describe('distanceFromBottom', () => {
  it('is zero when the scrollport is exactly at the bottom', () => {
    expect(distanceFromBottom({ scrollTop: 400, scrollHeight: 1000, clientHeight: 600 })).toBe(0);
  });

  it('is zero when the content is shorter than the scrollport', () => {
    expect(distanceFromBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 600 })).toBe(-300);
  });

  it('grows as the reader scrolls up', () => {
    expect(distanceFromBottom({ scrollTop: 100, scrollHeight: 1000, clientHeight: 600 })).toBe(300);
  });
});

describe('isPinnedToBottom', () => {
  it('follows when parked at the bottom', () => {
    expect(isPinnedToBottom({ scrollTop: 400, scrollHeight: 1000, clientHeight: 600 })).toBe(true);
  });

  it('follows within the threshold, so sub-pixel rounding does not drop autoscroll', () => {
    expect(isPinnedToBottom({ scrollTop: 399.5, scrollHeight: 1000, clientHeight: 600 })).toBe(
      true,
    );
    expect(
      isPinnedToBottom({
        scrollTop: 400 - FOLLOW_THRESHOLD_PX,
        scrollHeight: 1000,
        clientHeight: 600,
      }),
    ).toBe(true);
  });

  it('stops following once the reader is past the threshold', () => {
    expect(
      isPinnedToBottom({
        scrollTop: 400 - FOLLOW_THRESHOLD_PX - 1,
        scrollHeight: 1000,
        clientHeight: 600,
      }),
    ).toBe(false);
    expect(isPinnedToBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 600 })).toBe(false);
  });

  it('follows when there is nothing to scroll, so no jump affordance is ever offered', () => {
    expect(isPinnedToBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 600 })).toBe(true);
    expect(isPinnedToBottom({ scrollTop: 0, scrollHeight: 600, clientHeight: 600 })).toBe(true);
  });

  it('follows through rubber-band overscroll past the bottom', () => {
    expect(isPinnedToBottom({ scrollTop: 460, scrollHeight: 1000, clientHeight: 600 })).toBe(true);
  });

  it('honours an explicit threshold', () => {
    const metrics = { scrollTop: 390, scrollHeight: 1000, clientHeight: 600 };
    expect(isPinnedToBottom(metrics, 5)).toBe(false);
    expect(isPinnedToBottom(metrics, 20)).toBe(true);
  });
});

describe('createTailFollower (issue #863)', () => {
  function setup() {
    const frames: (() => void)[] = [];
    const node = { scrollTop: 0, scrollHeight: 1_000, clientHeight: 400 };
    const follower = createTailFollower({
      request: (callback) => frames.push(callback),
      cancel: (handle) => {
        frames[handle - 1] = () => undefined;
      },
    });
    const runFrames = (): void => {
      for (const frame of frames.splice(0)) frame();
    };
    // A scrollport clamps scrollTop to scrollHeight - clientHeight, as the browser does.
    const target = {
      get scrollTop() {
        return node.scrollTop;
      },
      set scrollTop(value: number) {
        node.scrollTop = Math.min(value, node.scrollHeight - node.clientHeight);
      },
      get scrollHeight() {
        return node.scrollHeight;
      },
    };
    const scrollEvent = () => follower.observeScroll(target, isPinnedToBottom(node));
    return { node, target, follower, frames, runFrames, scrollEvent };
  }

  it('scrolls to the tail once per frame however many updates ask', () => {
    const { node, target, follower, frames, runFrames } = setup();
    follower.schedule(target);
    follower.schedule(target);
    expect(frames).toHaveLength(1);
    runFrames();
    expect(node.scrollTop).toBe(600);
  });

  it('does not pull a reader who scrolled up back to the tail in the scheduled frame', () => {
    const { node, target, follower, runFrames, scrollEvent } = setup();
    follower.scrollNow(target);
    node.scrollHeight = 1_300; // a new token arrives and asks for a scroll on the next frame
    follower.schedule(target);
    // The reader scrolls up before that frame; React has not committed "not following" yet.
    node.scrollTop = 100;
    expect(scrollEvent()).toBe(false);
    runFrames();
    expect(node.scrollTop).toBe(100);
    follower.schedule(target);
    runFrames();
    expect(node.scrollTop).toBe(100);
  });

  it('keeps following when content grew after its own scroll and before the scroll event', () => {
    const { node, target, follower, runFrames, scrollEvent } = setup();
    follower.schedule(target);
    runFrames();
    expect(node.scrollTop).toBe(600);
    node.scrollHeight = 1_500; // grew before the scroll event of the follower's own write
    expect(scrollEvent()).toBe(true);
    follower.schedule(target);
    runFrames();
    expect(node.scrollTop).toBe(1_100);
  });

  it('follows again after 最新へ', () => {
    const { node, target, follower, runFrames, scrollEvent } = setup();
    node.scrollTop = 0;
    expect(scrollEvent()).toBe(false);
    follower.scrollNow(target);
    expect(node.scrollTop).toBe(600);
    node.scrollHeight = 1_200;
    follower.schedule(target);
    runFrames();
    expect(node.scrollTop).toBe(800);
  });
});

describe('createTailFollower.stopFollowing (issue #863)', () => {
  it('stops following without a scroll event, until 最新へ or a scroll back to the bottom', () => {
    const frames: (() => void)[] = [];
    const node = { scrollTop: 600, scrollHeight: 1_000, clientHeight: 400 };
    const follower = createTailFollower({
      request: (callback) => frames.push(callback),
      cancel: (handle) => {
        frames[handle - 1] = () => undefined;
      },
    });
    follower.schedule(node);
    // Opening a collapsed group grows the content but moves nothing.
    node.scrollHeight = 5_000;
    follower.stopFollowing();
    for (const frame of frames.splice(0)) frame();
    expect(node.scrollTop).toBe(600);
    follower.schedule(node);
    for (const frame of frames.splice(0)) frame();
    expect(node.scrollTop).toBe(600);

    // Scrolling back to the bottom resumes following.
    node.scrollTop = 4_600;
    expect(follower.observeScroll(node, isPinnedToBottom(node))).toBe(true);
    node.scrollHeight = 5_200;
    follower.schedule(node);
    for (const frame of frames.splice(0)) frame();
    expect(node.scrollTop).toBe(5_200);
  });
});

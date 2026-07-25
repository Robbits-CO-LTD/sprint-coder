import { describe, expect, it } from 'vitest';
import { FOLLOW_THRESHOLD_PX, distanceFromBottom, isPinnedToBottom } from './scroll-follow';

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

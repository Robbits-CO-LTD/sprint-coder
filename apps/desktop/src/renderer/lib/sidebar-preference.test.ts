import { describe, expect, it } from 'vitest';
import {
  clampSidebarWidth,
  defaultSidebarCollapsed,
  maxSidebarWidth,
  sidebarAvailableWidth,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from './sidebar-preference';

// Issue #12: the sidebar was a fixed 264px with no way to collapse it. The interesting logic is not
// the CSS but this one decision — what state to start in — because it has to reconcile a stored
// preference with a viewport that may not have room for it.

describe('defaultSidebarCollapsed', () => {
  it('honours a stored preference when there is room', () => {
    expect(defaultSidebarCollapsed(false, true)).toBe(true);
    expect(defaultSidebarCollapsed(false, false)).toBe(false);
  });

  it('starts expanded when the user has never chosen and there is room', () => {
    // Unchanged from the pre-issue behaviour: a wide window shows the Task history by default.
    expect(defaultSidebarCollapsed(false, null)).toBe(false);
  });

  it('starts collapsed on a narrow viewport regardless of the stored preference', () => {
    // Below the breakpoint the sidebar is an overlay, so restoring "expanded" would cover the
    // conversation with a panel the user did not open in this session.
    expect(defaultSidebarCollapsed(true, true)).toBe(true);
    expect(defaultSidebarCollapsed(true, false)).toBe(true);
    expect(defaultSidebarCollapsed(true, null)).toBe(true);
  });
});

describe('clampSidebarWidth', () => {
  it('keeps a width inside the min/max range', () => {
    expect(clampSidebarWidth(300, 1600)).toBe(300);
    expect(clampSidebarWidth(80, 1600)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(900, 1600)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(300.6, 1600)).toBe(301);
  });

  it('leaves the conversation at least its minimum width in a small window', () => {
    // 1000 - 520 = 480 would be allowed; 900 - 520 = 380 caps a wider stored value.
    expect(maxSidebarWidth(900)).toBe(380);
    expect(clampSidebarWidth(460, 900)).toBe(380);
  });

  it('never goes below the minimum, even when the window has no room to spare', () => {
    expect(maxSidebarWidth(600)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(400, 600)).toBe(SIDEBAR_MIN_WIDTH);
  });
});

describe('sidebarAvailableWidth', () => {
  it('is the whole window when nothing is docked on the right', () => {
    expect(sidebarAvailableWidth(1500, { graph: false, teamList: false })).toBe(1500);
  });

  it('subtracts a docked graph panel (52vw, capped at 900px)', () => {
    // 1500 * 0.52 = 780 → 720 left, so the sidebar may only grow to 720 - 520 = 200 → the minimum.
    expect(sidebarAvailableWidth(1500, { graph: true, teamList: false })).toBe(720);
    expect(
      clampSidebarWidth(480, sidebarAvailableWidth(1500, { graph: true, teamList: false })),
    ).toBe(SIDEBAR_MIN_WIDTH);
    expect(sidebarAvailableWidth(2000, { graph: true, teamList: false })).toBe(1100);
  });

  it('subtracts the docked 460px Team list', () => {
    expect(sidebarAvailableWidth(1440, { graph: false, teamList: true })).toBe(980);
    expect(maxSidebarWidth(980)).toBe(460);
  });
});

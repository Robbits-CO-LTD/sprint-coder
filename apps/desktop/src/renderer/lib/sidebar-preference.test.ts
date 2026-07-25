import { describe, expect, it } from 'vitest';
import { defaultSidebarCollapsed } from './sidebar-preference';

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

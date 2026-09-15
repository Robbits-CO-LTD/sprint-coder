import { describe, expect, it, vi } from 'vitest';

import { reapOwnedApp } from '../../tasks/evidence/issue-387-owned-process-reaper.mjs';

// A ChildProcess stand-in: the reaper only reads pid/exitCode/signalCode and calls unref().
function fakeChild() {
  return { pid: 4242, exitCode: null, signalCode: null, unref: vi.fn() };
}

function fakePage(closed = false) {
  return { isClosed: () => closed, close: vi.fn().mockResolvedValue(undefined) };
}

describe('#387 unsigned-availability owned process reaper', () => {
  it('kills and releases the owned app when the probe fails before a page exists', async () => {
    const child = fakeChild();
    const kill = vi.fn();
    // A launch that never reaches CDP readiness: the owned app never exits on its own.
    const exited = new Promise(() => {});

    const result = await reapOwnedApp({
      child,
      exited,
      page: undefined,
      browser: undefined,
      normalCloseMs: 5,
      forcedExitMs: 5,
      kill,
    });

    expect(kill).toHaveBeenCalledWith(child);
    expect(child.unref).toHaveBeenCalled();
    expect(result).toEqual({
      normalExit: null,
      normalCloseAttempted: false,
      forcedCleanup: true,
      forcedExit: null,
      reaped: false,
    });
  });

  it('records a normal exit without forcing anything when the owned page closes the app', async () => {
    const child = fakeChild();
    const kill = vi.fn();
    const page = fakePage();
    const browser = { close: vi.fn().mockResolvedValue(undefined) };

    const result = await reapOwnedApp({
      child,
      exited: Promise.resolve({ code: 0, signal: null }),
      page,
      browser,
      normalCloseMs: 5,
      forcedExitMs: 5,
      kill,
    });

    expect(page.close).toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(child.unref).not.toHaveBeenCalled();
    expect(result).toEqual({
      normalExit: { code: 0, signal: null },
      normalCloseAttempted: true,
      forcedCleanup: false,
      forcedExit: null,
      reaped: true,
    });
  });

  it('separates a forced termination from a clean shutdown when the app ignores the close', async () => {
    const child = fakeChild();
    let terminate;
    const exited = new Promise((done) => {
      terminate = done;
    });
    const kill = vi.fn(() => terminate({ code: null, signal: 'SIGKILL' }));

    const result = await reapOwnedApp({
      child,
      exited,
      page: fakePage(),
      browser: undefined,
      normalCloseMs: 5,
      forcedExitMs: 1000,
      kill,
    });

    expect(kill).toHaveBeenCalledTimes(1);
    expect(child.unref).not.toHaveBeenCalled();
    // A terminated app must never be reported as the normal window-all-closed exit.
    expect(result.normalExit).toBeNull();
    expect(result.forcedCleanup).toBe(true);
    expect(result.forcedExit).toEqual({ code: null, signal: 'SIGKILL' });
    expect(result.reaped).toBe(true);
  });

  it('skips the normal close for an already closed page but still reaps the app', async () => {
    const child = fakeChild();
    const kill = vi.fn();
    const page = fakePage(true);

    const result = await reapOwnedApp({
      child,
      exited: new Promise(() => {}),
      page,
      browser: undefined,
      normalCloseMs: 5,
      forcedExitMs: 5,
      kill,
    });

    expect(page.close).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith(child);
    expect(result.normalCloseAttempted).toBe(false);
    expect(result.forcedCleanup).toBe(true);
  });
});

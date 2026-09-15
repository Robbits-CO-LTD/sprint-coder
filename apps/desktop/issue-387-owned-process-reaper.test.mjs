import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';

import {
  reapOwnedApp,
  withDeadline,
} from '../../tasks/evidence/issue-387-owned-process-reaper.mjs';

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

  it('still reaps the app when a hung Electron never settles page.close()', async () => {
    const child = fakeChild();
    const kill = vi.fn();
    // A renderer that stops responding: the close request is issued but never completes.
    const page = { isClosed: () => false, close: vi.fn(() => new Promise(() => {})) };
    const started = Date.now();

    const result = await reapOwnedApp({
      child,
      exited: new Promise(() => {}),
      page,
      browser: undefined,
      normalCloseMs: 5,
      forcedExitMs: 5,
      kill,
    });

    expect(page.close).toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith(child);
    expect(child.unref).toHaveBeenCalled();
    expect(result.normalCloseAttempted).toBe(true);
    expect(result.normalExit).toBeNull();
    expect(result.forcedCleanup).toBe(true);
    expect(result.reaped).toBe(false);
    // The pending close must not extend the run past its own deadlines.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('still reaps the app when browser.close() never settles', async () => {
    const child = fakeChild();
    const kill = vi.fn();
    const browser = { close: vi.fn(() => new Promise(() => {})) };
    const started = Date.now();

    const result = await reapOwnedApp({
      child,
      exited: new Promise(() => {}),
      page: fakePage(),
      browser,
      normalCloseMs: 5,
      forcedExitMs: 5,
      kill,
    });

    expect(browser.close).toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith(child);
    expect(result.forcedCleanup).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
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

describe('#387 unsigned-availability bounded evaluation', () => {
  it('returns the evaluation result when it settles inside the deadline', async () => {
    await expect(
      withDeadline(Promise.resolve({ available: false }), 1000, 'probe'),
    ).resolves.toEqual({ available: false });
  });

  it('propagates an evaluation failure unchanged', async () => {
    await expect(
      withDeadline(Promise.reject(new Error('target closed')), 1000, 'probe'),
    ).rejects.toThrow('target closed');
  });

  it('rejects when an unresponsive Main leaves the evaluation pending', async () => {
    const started = Date.now();

    await expect(withDeadline(new Promise(() => {}), 5, 'probe')).rejects.toThrow(
      /Deadline exceeded: probe/,
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('swallows a late rejection from an abandoned evaluation', async () => {
    let fail;
    const abandoned = new Promise((_, reject) => {
      fail = reject;
    });

    await expect(withDeadline(abandoned, 5, 'probe')).rejects.toThrow(/Deadline exceeded/);
    // The real call rejects later with "Target closed" once the reaper tears the app down; that
    // must not surface as an unhandled rejection after the evidence has been written.
    fail(new Error('Target closed'));
    await delay(10);
  });

  it('reaches the reaper when the availability evaluation never settles', async () => {
    const child = fakeChild();
    const kill = vi.fn();
    let failureStage;
    let failure;
    let result;

    // The harness shape: bounded evaluation -> catch records the stage -> finally always reaps.
    try {
      await withDeadline(new Promise(() => {}), 5, 'official-preload-availability');
    } catch (error) {
      failureStage = 'official-preload-availability';
      failure = error;
    } finally {
      result = await reapOwnedApp({
        child,
        exited: new Promise(() => {}),
        page: fakePage(),
        browser: undefined,
        normalCloseMs: 5,
        forcedExitMs: 5,
        kill,
      });
    }

    // The deadline itself must be what unblocks the probe, not an incidental error.
    expect(failure?.message).toMatch(/Deadline exceeded: official-preload-availability/);
    expect(failureStage).toBe('official-preload-availability');
    expect(kill).toHaveBeenCalledWith(child);
    expect(result.forcedCleanup).toBe(true);
    expect(result.normalExit).toBeNull();
  });
});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyFileEditFrame, clearFileEdits } from './file-edit-buffer';
import { useLiveFileEdits } from './useLiveFileEdits';

let container: HTMLDivElement;
let root: Root;
/** The frames asked for and not yet run or cancelled. */
let frames: Map<number, FrameRequestCallback>;
let asked: number;

function Probe() {
  const edits = useLiveFileEdits();
  return <p data-testid="edits">{edits.map((edit) => `${edit.path}=${edit.text}`).join(',')}</p>;
}

const shown = () => container.querySelector('[data-testid="edits"]')?.textContent;

async function runFrames() {
  await act(async () => {
    const due = [...frames.values()];
    frames.clear();
    for (const callback of due) callback(performance.now());
  });
}

function write(path: string, text: string): void {
  applyFileEditFrame({
    taskId: 'task-1',
    turnId: 'turn-1',
    rootId: 'root-a',
    rootLabel: 'a',
    path,
    text,
    complete: false,
    source: 'stream',
    baseline: null,
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  clearFileEdits();
  frames = new Map();
  asked = 0;
  let next = 1;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    asked += 1;
    frames.set(next, callback);
    return next++;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  clearFileEdits();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useLiveFileEdits', () => {
  it('asks for no frame while nothing is being written (issue #1242)', async () => {
    await act(async () => root.render(<Probe />));
    // One frame at the start, to catch up with anything written before it listened.
    expect(asked).toBe(1);
    await runFrames();
    await runFrames();
    expect(frames.size).toBe(0);
    expect(asked).toBe(1);
  });

  it('reads once a frame however many writes arrive in it, then rests again', async () => {
    await act(async () => root.render(<Probe />));
    await runFrames();
    asked = 0;
    write('a.ts', 'one');
    write('a.ts', 'one two');
    write('b.ts', 'other');
    expect(asked).toBe(1);
    expect(shown()).toBe('');
    await runFrames();
    expect(shown()).toBe('b.ts=other,a.ts=one two');
    expect(frames.size).toBe(0);
    // The next write wakes it again; clearing (a switch of Task) is a change too.
    write('a.ts', 'one two three');
    await runFrames();
    expect(shown()).toBe('b.ts=other,a.ts=one two three');
    clearFileEdits();
    await runFrames();
    expect(shown()).toBe('');
    expect(asked).toBe(3);
  });

  it('shows what was written before it mounted', async () => {
    write('early.ts', 'x');
    await act(async () => root.render(<Probe />));
    expect(shown()).toBe('early.ts=x');
  });

  it('once unmounted, cancels its frame and no longer listens', async () => {
    await act(async () => root.render(<Probe />));
    await runFrames();
    write('a.ts', 'one');
    expect(frames.size).toBe(1);
    await act(async () => root.unmount());
    expect(frames.size).toBe(0);
    asked = 0;
    write('a.ts', 'two');
    expect(asked).toBe(0);
    root = createRoot(container);
  });
});

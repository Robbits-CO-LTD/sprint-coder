import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REASONING_FLUSH_BYTES,
  REASONING_TURN_BUDGET_BYTES,
  ReasoningBatcher,
  type ReasoningFlush,
} from './reasoning-batcher';

// Issue #17, NFR-PERF-05. The existing `message.delta` path re-renders React once per delta and only
// survives because the mock chunks a reply into 32 pieces; a real reasoning stream is far denser, so
// this stage exists to keep the commit rate bounded.

describe('ReasoningBatcher', () => {
  let flushes: ReasoningFlush[];
  let batcher: ReasoningBatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    flushes = [];
    batcher = new ReasoningBatcher((flush) => flushes.push(flush), 120);
  });

  afterEach(() => {
    batcher.dispose();
    vi.useRealTimers();
  });

  it('coalesces fragments arriving inside one interval into a single flush', () => {
    // The whole point: many fragments, one commit.
    for (const fragment of ['あ', 'い', 'う', 'え', 'お']) batcher.push(fragment);
    expect(flushes).toEqual([]);
    vi.advanceTimersByTime(120);
    expect(flushes).toEqual([{ text: 'あいうえお', truncated: false }]);
  });

  it('does not start a second timer while one is pending', () => {
    batcher.push('a');
    vi.advanceTimersByTime(60);
    batcher.push('b');
    // The second push must ride the first timer, not reset it — otherwise a steady stream never
    // flushes at all.
    vi.advanceTimersByTime(60);
    expect(flushes).toEqual([{ text: 'ab', truncated: false }]);
  });

  it('flushes early once a batch is large, instead of making a burst wait for the timer', () => {
    batcher.push('x'.repeat(REASONING_FLUSH_BYTES));
    expect(flushes).toHaveLength(1);
    expect(flushes[0]?.text.length).toBe(REASONING_FLUSH_BYTES);
  });

  it('emits nothing when nothing was pushed', () => {
    vi.advanceTimersByTime(1_000);
    expect(flushes).toEqual([]);
  });

  it('latches truncation once the per-turn budget is exceeded, and stops forwarding text', () => {
    // Dropping silently would let a truncated trail read as the model's whole thought process.
    batcher.push('a'.repeat(REASONING_TURN_BUDGET_BYTES));
    batcher.push('this must not appear');
    vi.advanceTimersByTime(120);
    const all = flushes.map(({ text }) => text).join('');
    expect(all).not.toContain('this must not appear');
    expect(flushes.some(({ truncated }) => truncated)).toBe(true);
  });

  it('stays truncated for the rest of the turn', () => {
    batcher.push('a'.repeat(REASONING_TURN_BUDGET_BYTES));
    batcher.push('over');
    batcher.push('b');
    vi.advanceTimersByTime(120);
    expect(flushes.at(-1)?.truncated).toBe(true);
  });

  it('counts bytes, not code units, so multi-byte text cannot exceed the budget', () => {
    // 'あ' is 3 bytes in UTF-8; a length-based budget would let 3x the intended volume through.
    const perChar = Buffer.byteLength('あ', 'utf8');
    batcher.push('あ'.repeat(Math.ceil(REASONING_TURN_BUDGET_BYTES / perChar) + 10));
    vi.advanceTimersByTime(120);
    const bytes = flushes.reduce((sum, { text }) => sum + Buffer.byteLength(text, 'utf8'), 0);
    expect(bytes).toBeLessThanOrEqual(REASONING_TURN_BUDGET_BYTES);
  });

  it('flushes the tail and clears the timer on dispose', () => {
    // Called when the turn ends: without it the last thought is lost to the 120ms window and a timer
    // outlives the turn that owned it.
    batcher.push('final thought');
    batcher.dispose();
    expect(flushes).toEqual([{ text: 'final thought', truncated: false }]);
    vi.advanceTimersByTime(1_000);
    expect(flushes).toHaveLength(1);
  });

  it('ignores pushes after dispose', () => {
    batcher.dispose();
    batcher.push('too late');
    vi.advanceTimersByTime(1_000);
    expect(flushes).toEqual([]);
  });
});

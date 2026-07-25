import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendReasoning,
  pruneReasoning,
  readReasoning,
  reasoningParagraphs,
  reasoningVersion,
  resetReasoningBuffer,
} from './reasoning-buffer';

// Issue #17. The text lives here rather than in zustand so a high-frequency stream costs no store
// updates; these cover the consequences of that choice — accumulation, latching, and the fact that
// nothing prunes itself.

beforeEach(() => resetReasoningBuffer());

describe('reasoning buffer', () => {
  it('accumulates fragments for a turn', () => {
    appendReasoning('t1', 'あ', false);
    appendReasoning('t1', 'い', false);
    expect(readReasoning('t1').text).toBe('あい');
  });

  it('keeps turns separate', () => {
    appendReasoning('t1', 'one', false);
    appendReasoning('t2', 'two', false);
    expect(readReasoning('t1').text).toBe('one');
    expect(readReasoning('t2').text).toBe('two');
  });

  it('reads empty for an unknown turn rather than throwing', () => {
    expect(readReasoning('never-seen')).toEqual({ text: '', truncated: false });
  });

  it('latches truncation so a later clean batch cannot un-truncate the trail', () => {
    appendReasoning('t1', 'a', true);
    appendReasoning('t1', 'b', false);
    expect(readReasoning('t1').truncated).toBe(true);
  });

  it('advances a version on every append, so a poller can skip unchanged frames', () => {
    const before = reasoningVersion();
    appendReasoning('t1', 'a', false);
    expect(reasoningVersion()).toBeGreaterThan(before);
  });

  it('prunes everything but the turns it is told to keep', () => {
    // Reasoning is not persisted, so this map is the only thing keeping old turns alive — without
    // pruning it grows for the lifetime of the window.
    appendReasoning('old', 'gone', false);
    appendReasoning('new', 'kept', false);
    pruneReasoning(['new']);
    expect(readReasoning('old').text).toBe('');
    expect(readReasoning('new').text).toBe('kept');
  });
});

describe('reasoningParagraphs', () => {
  it('splits on blank lines, which is the granularity the UI animates on', () => {
    // Per-token animation turns a reasoning stream into a strobe; paragraphs are the unit.
    expect(reasoningParagraphs('first\n\nsecond')).toEqual(['first', 'second']);
  });

  it('treats three or more newlines as one boundary', () => {
    expect(reasoningParagraphs('a\n\n\n\nb')).toEqual(['a', 'b']);
  });

  it('keeps single newlines inside a paragraph', () => {
    expect(reasoningParagraphs('line one\nline two')).toEqual(['line one\nline two']);
  });

  it('includes a trailing partial paragraph, so the newest thought is visible while streaming', () => {
    expect(reasoningParagraphs('done\n\nstill writ')).toEqual(['done', 'still writ']);
  });

  it('returns nothing for empty or whitespace-only text', () => {
    expect(reasoningParagraphs('')).toEqual([]);
    expect(reasoningParagraphs('\n\n   \n\n')).toEqual([]);
  });
});

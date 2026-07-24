import { describe, expect, it } from 'vitest';
import { findFreePosition, rectsOverlap } from './placement';
import type { Rect } from './useCamera';

const SIZE = { w: 480, h: 260 };

describe('rectsOverlap', () => {
  it('detects overlapping rects', () => {
    const a: Rect = { x: 0, y: 0, w: 100, h: 100 };
    const b: Rect = { x: 50, y: 50, w: 100, h: 100 };
    expect(rectsOverlap(a, b, 0)).toBe(true);
  });

  it('treats rects further apart than the margin as free', () => {
    const a: Rect = { x: 0, y: 0, w: 100, h: 100 };
    const b: Rect = { x: 200, y: 0, w: 100, h: 100 };
    expect(rectsOverlap(a, b, 40)).toBe(false);
  });

  it('counts rects within the margin gap as overlapping', () => {
    const a: Rect = { x: 0, y: 0, w: 100, h: 100 };
    const b: Rect = { x: 110, y: 0, w: 100, h: 100 }; // 10px gap, margin 40
    expect(rectsOverlap(a, b, 40)).toBe(true);
  });
});

describe('findFreePosition', () => {
  it('keeps the default slot when nothing occupies it', () => {
    const result = findFreePosition({ x: 960, y: -70 }, SIZE, []);
    expect(result).toEqual({ x: 960, y: -70 });
  });

  it('steps to a deterministic fallback when the default slot collides', () => {
    const defaultPos = { x: 960, y: -70 };
    const occupied: Rect[] = [{ x: defaultPos.x, y: defaultPos.y, w: SIZE.w, h: SIZE.h }];
    const result = findFreePosition(defaultPos, SIZE, occupied);
    expect(result).not.toEqual(defaultPos);
    // Must not overlap the occupied rect.
    expect(rectsOverlap({ ...result, ...SIZE }, occupied[0]!)).toBe(false);
  });

  it('is deterministic — same inputs always produce the same fallback', () => {
    const defaultPos = { x: 1000, y: 420 };
    const occupied: Rect[] = [{ x: 1000, y: 420, w: SIZE.w, h: SIZE.h }];
    const first = findFreePosition(defaultPos, SIZE, occupied);
    const second = findFreePosition(defaultPos, SIZE, occupied);
    expect(first).toEqual(second);
  });

  it('fans outward across several rings when many slots are already taken', () => {
    const defaultPos = { x: 0, y: 0 };
    // Occupy the default slot plus the first couple of fallback rings so it has to search further.
    const occupied: Rect[] = [
      { x: 0, y: 0, w: SIZE.w, h: SIZE.h },
      { x: 520, y: 0, w: SIZE.w, h: SIZE.h },
      { x: 0, y: 300, w: SIZE.w, h: SIZE.h },
    ];
    const result = findFreePosition(defaultPos, SIZE, occupied);
    const resultRect: Rect = { x: result.x, y: result.y, w: SIZE.w, h: SIZE.h };
    for (const rect of occupied) {
      expect(rectsOverlap(resultRect, rect)).toBe(false);
    }
  });

  it('falls back to the default slot if the deterministic search space is exhausted', () => {
    // Occupy a huge area so every fallback candidate within the bounded search collides.
    const defaultPos = { x: 0, y: 0 };
    const occupied: Rect[] = [{ x: -20_000, y: -20_000, w: 40_000, h: 40_000 }];
    const result = findFreePosition(defaultPos, SIZE, occupied);
    expect(result).toEqual(defaultPos);
  });
});

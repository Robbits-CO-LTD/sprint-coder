import { describe, expect, it } from 'vitest';
import {
  LEADER_RECT,
  PLACEMENT_MARGIN,
  WORKER_SIZE,
  computeHierarchyLayout,
  describeHierarchy,
  findFreePosition,
  hierarchySlot,
  isManagerAgent,
  parentAgentOf,
  rectsOverlap,
} from './placement';
import type { HierarchyAgent } from './placement';
import type { Rect } from './useCamera';

const SIZE = { w: 480, h: 260 };
const LEADER = 'leader-1';

function agent(id: string, parentAgentId: string | null, depth: number): HierarchyAgent {
  return { id, parentAgentId, depth };
}

/** Every placed card plus the Leader, as collision rects. */
function rectsFor(layout: ReadonlyMap<string, { x: number; y: number }>): Rect[] {
  return [LEADER_RECT, ...[...layout.values()].map((p) => ({ x: p.x, y: p.y, ...WORKER_SIZE }))];
}

function expectNoCollisions(rects: readonly Rect[]): void {
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      expect(rectsOverlap(rects[i]!, rects[j]!, PLACEMENT_MARGIN), `${i} collides with ${j}`).toBe(
        false,
      );
    }
  }
}

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

describe('hierarchySlot', () => {
  it('steps right per column and down per row', () => {
    expect(hierarchySlot(1, 0)).toEqual({ x: 960, y: -70 });
    expect(hierarchySlot(2, 0)).toEqual({ x: 1520, y: -70 });
    expect(hierarchySlot(1, 1)).toEqual({ x: 960, y: 410 });
  });

  it('clamps a non-finite or out-of-range column/row to the first slot', () => {
    expect(hierarchySlot(0, -3)).toEqual(hierarchySlot(1, 0));
    expect(hierarchySlot(Number.NaN, Number.NaN)).toEqual(hierarchySlot(1, 0));
  });
});

describe('computeHierarchyLayout', () => {
  it('puts the Leader’s direct children in the first column, in stable sibling order', () => {
    const layout = computeHierarchyLayout(LEADER, [
      agent('a', LEADER, 1),
      agent('b', LEADER, 1),
      agent('c', LEADER, 1),
    ]);
    expect(layout.get('a')).toMatchObject({ column: 1, row: 0, x: 960, y: -70 });
    expect(layout.get('b')).toMatchObject({ column: 1, row: 1, x: 960, y: 410 });
    expect(layout.get('c')).toMatchObject({ column: 1, row: 2, x: 960, y: 890 });
    for (const id of ['a', 'b', 'c']) {
      expect(layout.get(id)?.parentAgentId).toBe(LEADER);
      expect(layout.get(id)?.parentIsLeader).toBe(true);
    }
  });

  it('reads Leader -> Manager -> Worker left to right: a child is always right of its parent', () => {
    const layout = computeHierarchyLayout(LEADER, [
      agent('manager', LEADER, 1),
      agent('worker', 'manager', 2),
    ]);
    const manager = layout.get('manager')!;
    const worker = layout.get('worker')!;
    expect(worker.column).toBe(manager.column + 1);
    expect(worker.x).toBeGreaterThan(manager.x);
    expect(manager.x).toBeGreaterThan(LEADER_RECT.x + LEADER_RECT.w);
    // The first child starts on its parent's row, so a subtree reads as an indented outline.
    expect(worker.row).toBe(manager.row);
    expect(worker.parentAgentId).toBe('manager');
    expect(worker.parentIsLeader).toBe(false);
  });

  it('lays out a depth-4 chain as four columns without any card collision', () => {
    const layout = computeHierarchyLayout(LEADER, [
      agent('d1', LEADER, 1),
      agent('d2', 'd1', 2),
      agent('d3', 'd2', 3),
      agent('d4', 'd3', 4),
    ]);
    expect([...layout.values()].map((p) => p.column)).toEqual([1, 2, 3, 4]);
    expect(layout.get('d4')).toMatchObject({ x: 2640, y: -70 });
    expectNoCollisions(rectsFor(layout));
  });

  it('keeps a mixed tree collision-free (Leader included)', () => {
    const layout = computeHierarchyLayout(LEADER, [
      agent('m1', LEADER, 1),
      agent('m1-a', 'm1', 2),
      agent('m1-b', 'm1', 2),
      agent('m1-b-x', 'm1-b', 3),
      agent('m2', LEADER, 1),
      agent('m2-a', 'm2', 2),
      agent('w1', LEADER, 1),
    ]);
    expect(layout.size).toBe(7);
    expectNoCollisions(rectsFor(layout));
  });

  it('is deterministic — the same tree always lays out the same way', () => {
    const workers = [agent('a', LEADER, 1), agent('b', 'a', 2), agent('c', LEADER, 1)];
    expect([...computeHierarchyLayout(LEADER, workers)]).toEqual([
      ...computeHierarchyLayout(LEADER, workers),
    ]);
  });

  it('never places a child left of (or level with) its parent, whatever depth claims', () => {
    const layout = computeHierarchyLayout(LEADER, [
      agent('parent', LEADER, 2),
      agent('child', 'parent', 1), // backend depth disagrees with the recorded parent
    ]);
    expect(layout.get('parent')?.column).toBe(2);
    expect(layout.get('child')?.column).toBe(3);
  });

  it('hangs a Worker with no, unknown or self parent off the Leader', () => {
    const layout = computeHierarchyLayout(LEADER, [
      agent('none', null, 1),
      agent('ghost', 'not-in-this-team', 1),
      agent('self', 'self', 1),
    ]);
    for (const id of ['none', 'ghost', 'self']) {
      expect(layout.get(id)?.parentAgentId).toBe(LEADER);
      expect(layout.get(id)?.column).toBe(1);
    }
    expectNoCollisions(rectsFor(layout));
  });

  it('still shows every Worker when the recorded parents form a cycle', () => {
    const layout = computeHierarchyLayout(LEADER, [agent('a', 'b', 1), agent('b', 'a', 1)]);
    expect(layout.size).toBe(2);
    expectNoCollisions(rectsFor(layout));
  });

  it('does not place the Leader’s own row as a card', () => {
    const layout = computeHierarchyLayout(LEADER, [agent(LEADER, null, 0), agent('a', LEADER, 1)]);
    expect(layout.has(LEADER)).toBe(false);
    expect(layout.size).toBe(1);
  });

  it('falls back to a single root when the Team has no leader agent id yet', () => {
    const layout = computeHierarchyLayout(null, [agent('a', null, 1), agent('b', 'a', 2)]);
    expect(layout.get('a')?.parentIsLeader).toBe(true);
    expect(layout.get('b')?.parentAgentId).toBe('a');
  });
});

describe('hierarchy vocabulary', () => {
  const managerPolicy = {
    maxDirectChildren: 3,
    maxDelegationDepth: 2,
    allowManagerChildren: false,
  };

  it('calls an agent a Manager only from its recorded delegation capability', () => {
    expect(isManagerAgent({ canDelegate: true, managerPolicy: null })).toBe(true);
    expect(isManagerAgent({ canDelegate: false, managerPolicy })).toBe(true);
    expect(isManagerAgent({ canDelegate: false, managerPolicy: null })).toBe(false);
  });

  it('states kind, depth and parent role in one line', () => {
    const managerParent = { role: 'Reviewer', canDelegate: true, managerPolicy: null };
    const workerParent = { role: 'Builder', canDelegate: false, managerPolicy: null };
    const plain = { depth: 2, canDelegate: false, managerPolicy: null };
    expect(describeHierarchy({ depth: 1, canDelegate: true, managerPolicy }, null)).toBe(
      'Manager · 深さ1 · 親: Leader',
    );
    expect(describeHierarchy(plain, managerParent)).toBe('Worker · 深さ2 · 親: Reviewer (Manager)');
    expect(describeHierarchy({ ...plain, depth: 4 }, workerParent)).toBe(
      'Worker · 深さ4 · 親: Builder',
    );
  });

  it('resolves the parent row, or null when the parent is the Leader / unrecorded', () => {
    const workers = [{ id: 'w1' }, { id: 'w2' }];
    expect(parentAgentOf({ parentAgentId: 'w2' }, workers)).toEqual({ id: 'w2' });
    expect(parentAgentOf({ parentAgentId: LEADER }, workers)).toBeNull();
    expect(parentAgentOf({ parentAgentId: null }, workers)).toBeNull();
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
      { x: 0, y: 480, w: SIZE.w, h: SIZE.h },
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

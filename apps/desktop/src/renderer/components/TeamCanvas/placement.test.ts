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

/** A Manager as the backend records one: delegation capability plus its policy. */
function manager(
  id: string,
  parentAgentId: string | null,
  depth: number,
  maxDirectChildren: number | null = 9,
): HierarchyAgent {
  return {
    id,
    parentAgentId,
    depth,
    canDelegate: true,
    managerPolicy: { maxDirectChildren, maxDelegationDepth: 2, allowManagerChildren: false },
  };
}

/** Leader -> `departments` Managers -> `perDepartment` Workers each, in the order a real Team
 * hires them: every Manager first, then the Managers hiring concurrently (round-robin). */
function organisation(departments: number, perDepartment: number): HierarchyAgent[] {
  const agents: HierarchyAgent[] = [];
  for (let d = 0; d < departments; d += 1) agents.push(manager(`m${d}`, LEADER, 1, perDepartment));
  for (let w = 0; w < perDepartment; w += 1) {
    for (let d = 0; d < departments; d += 1) agents.push(agent(`m${d}-w${w}`, `m${d}`, 2));
  }
  return agents;
}

/** The scale TeamCanvas's Fit view (useCamera.camToFit, pad 90) lands on for these rects. */
function fitScale(rects: readonly Rect[], viewport = { w: 1440, h: 900 }, pad = 90): number {
  const width = Math.max(...rects.map((r) => r.x + r.w)) - Math.min(...rects.map((r) => r.x));
  const height = Math.max(...rects.map((r) => r.y + r.h)) - Math.min(...rects.map((r) => r.y));
  return Math.min(viewport.w / (width + pad * 2), viewport.h / (height + pad * 2));
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
    // The first child starts on its parent's row, so a department reads as one block.
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

describe('computeHierarchyLayout — department blocks', () => {
  // Mirrors persistence's CANVAS_WORLD_BOUND / CANVAS_MIN_SCALE: a default slot outside the world
  // bound, or a Fit view below the minimum zoom, can be neither shown nor saved.
  const WORLD_BOUND = 20_000;
  const MIN_SCALE = 0.18;

  it('lays a Manager’s nine Workers out as a wide 5-column block right of the Manager', () => {
    const layout = computeHierarchyLayout(LEADER, organisation(1, 9));
    const boss = layout.get('m0')!;
    expect(boss).toMatchObject({ column: 1, row: 0 });
    const cells = Array.from({ length: 9 }, (_, w) => layout.get(`m0-w${w}`)!);
    // Row-major, five per row: departments stack vertically, so each one is short and wide.
    expect(cells.map((p) => [p.column, p.row])).toEqual([
      [2, 0],
      [3, 0],
      [4, 0],
      [5, 0],
      [6, 0],
      [2, 1],
      [3, 1],
      [4, 1],
      [5, 1],
    ]);
    for (const cell of cells) expect(cell.parentAgentId).toBe('m0');
    expectNoCollisions(rectsFor(layout));
  });

  it('keeps Leader -> 3 Managers -> 27 Workers readable at Fit view', () => {
    const layout = computeHierarchyLayout(LEADER, organisation(3, 9));
    expect(layout.size).toBe(30);
    expectNoCollisions(rectsFor(layout));
    for (let d = 0; d < 3; d += 1) {
      const boss = layout.get(`m${d}`)!;
      // Departments are stacked blocks: each owns its two rows, none interleave.
      expect(boss).toMatchObject({ column: 1, row: d * 2 });
      for (let w = 0; w < 9; w += 1) {
        const worker = layout.get(`m${d}-w${w}`)!;
        expect(worker.column).toBeGreaterThan(boss.column);
        expect(worker.x).toBeGreaterThan(boss.x);
        expect(worker.row).toBeGreaterThanOrEqual(d * 2);
        expect(worker.row).toBeLessThan(d * 2 + 2);
      }
    }
    // One column per depth made this a 27-row strip whose Fit view (~0.07) was below the minimum
    // zoom, so the Team could not be shown whole at all. Now it is 6 rows and fits at ~0.30.
    expect(Math.max(...[...layout.values()].map((p) => p.row))).toBe(5);
    expect(fitScale(rectsFor(layout))).toBeGreaterThan(0.29);
    expect(fitScale(rectsFor(layout))).toBeGreaterThanOrEqual(MIN_SCALE);
  });

  it('never moves an existing agent’s slot when one more agent is hired', () => {
    // TeamCanvas freezes a card's default slot on first mount, so the layout of every hire-order
    // prefix must agree with the final one — for interleaved hiring across departments too.
    const agents = organisation(3, 9);
    const final = computeHierarchyLayout(LEADER, agents);
    for (let hired = 1; hired <= agents.length; hired += 1) {
      const partial = computeHierarchyLayout(LEADER, agents.slice(0, hired));
      for (const [id, placement] of partial) {
        expect(placement, `${id} after ${hired} hires`).toEqual(final.get(id));
      }
    }
  });

  it('reserves the rows a Manager’s policy lets it fill, before it has hired anyone', () => {
    const secondManagerRow = (maxDirectChildren: number | null): number =>
      computeHierarchyLayout(LEADER, [
        manager('m0', LEADER, 1, maxDirectChildren),
        manager('m1', LEADER, 1, maxDirectChildren),
      ]).get('m1')!.row;
    expect(secondManagerRow(9)).toBe(2); // 9 Workers = two rows of five
    expect(secondManagerRow(2)).toBe(1);
    expect(secondManagerRow(null)).toBe(1); // no cap recorded: nothing to reserve beyond itself
    // The reservation is bounded, so a generous policy cannot push the Team out of the world.
    expect(secondManagerRow(100)).toBe(4);
  });

  it('lets a department grow past its reservation without colliding', () => {
    const agents: HierarchyAgent[] = [manager('m0', LEADER, 1, 2), manager('m1', LEADER, 1, 2)];
    for (let w = 0; w < 12; w += 1) agents.push(agent(`m0-w${w}`, 'm0', 2));
    const layout = computeHierarchyLayout(LEADER, agents);
    expect(layout.get('m0-w11')).toMatchObject({ column: 3, row: 2 });
    expect(layout.get('m1')).toMatchObject({ column: 1, row: 3 });
    expectNoCollisions(rectsFor(layout));
  });

  it('groups a department from the tree’s shape alone when no delegation fields are given', () => {
    const agents = [agent('m0', LEADER, 1), agent('m1', LEADER, 1)];
    for (let w = 0; w < 9; w += 1) agents.push(agent(`m0-w${w}`, 'm0', 2));
    for (let w = 0; w < 9; w += 1) agents.push(agent(`m1-w${w}`, 'm1', 2));
    const layout = computeHierarchyLayout(LEADER, agents);
    expect(layout.get('m0')).toMatchObject({ column: 1, row: 0 });
    expect(layout.get('m1')).toMatchObject({ column: 1, row: 2 });
    expect(layout.get('m1-w8')).toMatchObject({ column: 5, row: 3 });
    expectNoCollisions(rectsFor(layout));
  });

  it('stacks bands in sibling order: a Worker hired after a Manager goes below its block', () => {
    const layout = computeHierarchyLayout(LEADER, [
      agent('early', LEADER, 1),
      manager('m0', LEADER, 1),
      agent('m0-w0', 'm0', 2),
      agent('late', LEADER, 1),
    ]);
    expect(layout.get('early')).toMatchObject({ column: 1, row: 0 });
    expect(layout.get('m0')).toMatchObject({ column: 1, row: 1 });
    expect(layout.get('m0-w0')).toMatchObject({ column: 2, row: 1 });
    expect(layout.get('late')).toMatchObject({ column: 1, row: 3 });
    expectNoCollisions(rectsFor(layout));
  });

  it('lays the Leader’s own Workers out three rows tall, wrapping after six columns', () => {
    const agents = Array.from({ length: 30 }, (_, i) => agent(`w${i}`, LEADER, 1));
    const layout = computeHierarchyLayout(LEADER, agents);
    expect(layout.get('w3')).toMatchObject({ column: 2, row: 0 });
    expect(layout.get('w17')).toMatchObject({ column: 6, row: 2 });
    expect(layout.get('w18')).toMatchObject({ column: 1, row: 3 });
    expect(layout.get('w29')).toMatchObject({ column: 4, row: 5 });
    expectNoCollisions(rectsFor(layout));
    expect(fitScale(rectsFor(layout))).toBeGreaterThanOrEqual(MIN_SCALE);
  });

  it('keeps a Team at the saved-position cap inside the persistable world bound', () => {
    // 3 Managers + 125 Workers = 128 agents (CANVAS_NODE_POSITIONS_MAX_ENTRIES).
    const agents: HierarchyAgent[] = [0, 1, 2].map((d) => manager(`m${d}`, LEADER, 1, null));
    for (let w = 0; w < 125; w += 1) agents.push(agent(`w${w}`, `m${w % 3}`, 2));
    const layout = computeHierarchyLayout(LEADER, agents);
    expect(layout.size).toBe(128);
    expectNoCollisions(rectsFor(layout));
    for (const { x, y } of layout.values()) {
      expect(Math.abs(x)).toBeLessThanOrEqual(WORLD_BOUND);
      expect(Math.abs(y)).toBeLessThanOrEqual(WORLD_BOUND);
    }
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

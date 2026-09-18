import type { Rect } from './useCamera';
import type { WorkerSummary } from '../../types/sprint-coder';

// Collision-aware placement (Slice 6.3 item 1): pure geometry, unit-testable without a DOM. A new
// Worker (or the hire ghost) starts from its default slot and, if that overlaps any existing node
// rect within `margin`, steps through a small deterministic fallback sequence — no physics, no
// randomness — until a collision-free rect is found. TeamCanvas is responsible for collecting the
// occupied rects (leader, workers at their CURRENT possibly-dragged/persisted positions, the hire
// node, and any not-yet-mounted reserved positions) and for reserving the result.
//
// Team v2 UI slice 2: that default slot is no longer "the Nth card in creation order" — it comes
// from the Team's actual agent tree (`WorkerSummary.parentAgentId` / `depth`), see
// `computeHierarchyLayout` below. This module owns BOTH the tree geometry and the tree's display
// vocabulary (`describeHierarchy`), so the Canvas and the List can never disagree about what a
// node's depth/parent/kind is called.

const FALLBACK_STEP_X = 520;
const FALLBACK_STEP_Y = 480;
const DEFAULT_MARGIN = 40;
const MAX_FALLBACK_STEPS = 32;

// --- Fixed node geometry (Team v2 B1b) ---
//
// Lives here rather than in TeamCanvas.tsx so the whole default-slot layout is pure, DOM-free and
// provable in a unit test. TeamCanvas imports these as its single source of truth.

export const LEADER_RECT: Rect = { x: 0, y: 0, w: 720, h: 620 };
// Fixed card footprint — every default slot uses this same w/h, so a new Worker's placement can be
// collision-checked before it has ever mounted. Mirrors `.worker`'s fixed 480x420 box in
// index.css: the pre-mount rect and the mounted card's real `worldRectOf` rect have to agree, or a
// "free" slot found here overlaps once the card actually paints.
export const WORKER_SIZE = { w: 480, h: 420 };
export const PLACEMENT_MARGIN = 40;

// --- Hierarchy layout (Team v2 UI slice 2) ---
//
// The tree reads Leader -> Manager -> Worker left to right on a slot grid: a child is always in a
// column right of its parent. Both steps clear the card footprint plus the placement margin
// (560 >= 480+40, 480 >= 420+40), so two distinct slots can never overlap each other, and column 1
// starts 240px clear of the Leader's right edge (720), so no slot can overlap the Leader either.
//
// The origin deliberately matches the first of the three hand-placed slots this replaces
// (demo/index.html §Team mode), so a Team whose Leader hired a single Worker still puts that card
// exactly where it has always been.
const COLUMN_ORIGIN_X = 960;
const COLUMN_STEP_X = 560;
const ROW_ORIGIN_Y = -70;
const ROW_STEP_Y = 480;

// Department blocks. One column per depth stacks every leaf of the Team into a single strip — 27
// Workers under 3 Managers is a 27-row, ~13,000px-tall band whose Fit view (~0.07) is below the
// minimum zoom. Instead a parent's children are stacked as BANDS in sibling order, starting on the
// parent's own row:
//
//  - consecutive leaf children share one grid band (shape below);
//  - a child that has children of its own, or is a Manager, is a block band: itself on the band's
//    first row with its own bands to its right.
//
// Grid shape. The Leader's own leaves sit beside a 620px-tall Leader with nothing stacked under
// them, so they fill column-major, LEADER_GRID_ROWS tall — the first three are exactly the
// historical single column — wrapping to a further chunk below after LEADER_GRID_MAX_COLUMNS. A
// department is different: departments stack vertically, so the Team's height is (departments x
// rows per department) and each one has to be short and wide. Its leaves fill row-major,
// DEPARTMENT_COLUMNS per row. 5 was picked by sweeping 3-6 over Teams from 3x2 to 6x4 plus 3x20 in
// 1440x900 and 1100x800 viewports: it has the best worst-case Fit scale and takes Leader + 3
// Managers + 27 Workers from 0.07 to 0.30.
//
// TeamCanvas freezes a card's default slot into `nodePositions` the first time it mounts, so what
// matters is not just the from-scratch result but that hiring one more agent does not move any
// EXISTING agent's slot (otherwise the frozen cards and the new slots disagree and the collision
// fallback scatters the newcomers). Hence: siblings only ever append to the LAST band; the grid
// index -> cell mapping is a fixed function of the sibling index; and a Manager reserves the rows
// its policy allows it to fill up front (it is a block from the moment it is hired, before it has
// a single child), so the department below it does not shift as it grows.
const LEADER_GRID_ROWS = 3;
const LEADER_GRID_MAX_COLUMNS = 6;
const DEPARTMENT_COLUMNS = 5;
// Bounds the up-front reservation only (a department can still grow past it): a Manager allowed
// 100 children that hires 4 must not push the rest of the Team out of the persistable world.
const DEPARTMENT_MAX_RESERVED_ROWS = 4;

// Stand-in root id for the (impossible in practice) case where the Team has no leader agent id
// yet: keeps `parentAgentId` a plain string instead of leaking a null through the layout.
const LEADER_FALLBACK_ID = '__leader__';

// The delegation fields are optional so a caller that only knows the tree's shape still lays out;
// when present they let a Manager reserve its department's rows before it has hired anyone.
export type HierarchyAgent = Pick<WorkerSummary, 'id' | 'parentAgentId' | 'depth'> &
  Partial<Pick<WorkerSummary, 'canDelegate' | 'managerPolicy'>>;

export type HierarchyPlacement = {
  /** Resolved parent node id: the Leader's agent id, or another Worker's id. The Canvas's static
   * connector line is drawn from this SAME resolution the position was derived from, so a line can
   * never point at a node the layout didn't actually place this card under. */
  parentAgentId: string;
  parentIsLeader: boolean;
  /** Column actually used. Always >= 1 and always > the parent's column, even if the backend's
   * recorded `depth` says otherwise — a child drawn left of its parent would read backwards. */
  column: number;
  row: number;
  x: number;
  y: number;
};

/** World position of the slot at `column` (1 = the Leader's direct children) and `row`. */
export function hierarchySlot(column: number, row: number): { x: number; y: number } {
  const c = Number.isFinite(column) ? Math.max(1, Math.floor(column)) : 1;
  const r = Number.isFinite(row) ? Math.max(0, Math.floor(row)) : 0;
  return { x: COLUMN_ORIGIN_X + (c - 1) * COLUMN_STEP_X, y: ROW_ORIGIN_Y + r * ROW_STEP_Y };
}

// A Worker whose parent is the Leader — or whose recorded parent is missing, is itself, or is not
// a Worker of this Team — hangs directly off the Leader: it is the only possible root of the tree.
// Note this never consults engine/provider/model; only the recorded parent id.
function resolveParentId(
  worker: HierarchyAgent,
  rootId: string,
  byId: ReadonlyMap<string, HierarchyAgent>,
): string {
  const parentId = worker.parentAgentId;
  if (!parentId || parentId === worker.id || !byId.has(parentId)) return rootId;
  return parentId;
}

// Cell (relative to the band's first column/row) of the `index`-th leaf in a grid band.
function gridCell(index: number, underLeader: boolean): { column: number; row: number } {
  if (!underLeader) {
    return { column: index % DEPARTMENT_COLUMNS, row: Math.floor(index / DEPARTMENT_COLUMNS) };
  }
  const chunkSize = LEADER_GRID_ROWS * LEADER_GRID_MAX_COLUMNS;
  const within = index % chunkSize;
  return {
    column: Math.floor(within / LEADER_GRID_ROWS),
    row: Math.floor(index / chunkSize) * LEADER_GRID_ROWS + (within % LEADER_GRID_ROWS),
  };
}

// Rows a Manager's department claims from the moment it is hired: what its recorded policy lets it
// fill, or a single row when the policy sets no cap. 0 for a plain Worker.
function reservedRows(agent: HierarchyAgent): number {
  const policy = agent.managerPolicy ?? null;
  if (agent.canDelegate !== true && policy === null) return 0;
  const cap = policy?.maxDirectChildren ?? null;
  if (cap === null || !Number.isFinite(cap)) return 1;
  const rows = Math.ceil(Math.max(1, Math.floor(cap)) / DEPARTMENT_COLUMNS);
  return Math.min(DEPARTMENT_MAX_RESERVED_ROWS, rows);
}

/**
 * Default (pre-drag, pre-restore) positions for every Worker, derived from the Team's agent tree.
 *
 * `workers` must be in stable sibling order (TeamCanvas/TeamListView both sort by `createdAt`), so
 * the same Team always lays out the same way across restarts. Deterministic and DOM-free.
 */
export function computeHierarchyLayout(
  leaderAgentId: string | null,
  workers: readonly HierarchyAgent[],
): Map<string, HierarchyPlacement> {
  const rootId = leaderAgentId ?? LEADER_FALLBACK_ID;
  // The Leader's own row (when the caller didn't filter it out) is not a placed node — it has a
  // fixed rect of its own (LEADER_RECT).
  const nodes = workers.filter((worker) => worker.id !== rootId);
  const byId = new Map(nodes.map((worker) => [worker.id, worker] as const));

  const recordedChildrenOf = new Map<string, HierarchyAgent[]>();
  for (const worker of nodes) {
    const parentId = resolveParentId(worker, rootId, byId);
    const siblings = recordedChildrenOf.get(parentId);
    if (siblings) siblings.push(worker);
    else recordedChildrenOf.set(parentId, [worker]);
  }

  // The tree actually laid out: each agent appears exactly once, under the parent it was first
  // reached from. Identical to the recorded tree unless the recorded parents form a cycle.
  const childrenOf = new Map<string, HierarchyAgent[]>();
  const reached = new Set<string>();
  const adopt = (parentId: string, child: HierarchyAgent): void => {
    reached.add(child.id);
    const siblings = childrenOf.get(parentId);
    if (siblings) siblings.push(child);
    else childrenOf.set(parentId, [child]);
    for (const grandchild of recordedChildrenOf.get(child.id) ?? []) {
      if (!reached.has(grandchild.id)) adopt(child.id, grandchild);
    }
  };
  for (const child of recordedChildrenOf.get(rootId) ?? []) adopt(rootId, child);
  // Anything still unreached is part of a parent cycle (A -> B -> A). The backend forbids that, but
  // the Canvas must still show every Worker it was given, so re-root the cycle under the Leader in
  // stable order rather than dropping cards on the floor.
  for (const worker of nodes) {
    if (!reached.has(worker.id)) adopt(rootId, worker);
  }

  const placements = new Map<string, HierarchyPlacement>();
  const put = (worker: HierarchyAgent, parentId: string, column: number, row: number): void => {
    placements.set(worker.id, {
      parentAgentId: parentId,
      parentIsLeader: parentId === rootId,
      column,
      row,
      ...hierarchySlot(column, row),
    });
  };

  // Stacks `parentId`'s children as bands from `startRow` down and returns the rows they used.
  const layoutChildren = (parentId: string, parentColumn: number, startRow: number): number => {
    let nextRow = startRow;
    let grid: { row: number; count: number } | null = null; // the open leaf grid band, if any
    for (const child of childrenOf.get(parentId) ?? []) {
      const declared = Number.isFinite(child.depth) ? Math.floor(child.depth) : 0;
      const column = Math.max(parentColumn + 1, declared);
      const isBlock = childrenOf.has(child.id) || reservedRows(child) > 0;
      // A leaf whose recorded depth puts it further right than its siblings keeps that column on a
      // band of its own rather than skewing the grid.
      if (!isBlock && column === parentColumn + 1) {
        grid ??= { row: nextRow, count: 0 };
        const cell = gridCell(grid.count, parentId === rootId);
        const row = grid.row + cell.row;
        put(child, parentId, column + cell.column, row);
        grid.count += 1;
        nextRow = Math.max(nextRow, row + 1);
        continue;
      }
      grid = null;
      put(child, parentId, column, nextRow);
      const used = layoutChildren(child.id, column, nextRow);
      nextRow += Math.max(1, used, reservedRows(child));
    }
    return nextRow - startRow;
  };
  layoutChildren(rootId, 0, 0);
  return placements;
}

// --- Hierarchy vocabulary (Team v2 UI slice 2) ---
//
// One source of truth for the words the Canvas card and the List row both show, so the two views
// state the same facts in the same wording by construction (the same reason TeamListView reuses the
// Canvas's testids — see its header comment).

export const LEADER_LABEL = 'Leader';
export const MANAGER_LABEL = 'Manager';
export const WORKER_LABEL = 'Worker';

/** Manager vs plain Worker, from the recorded delegation capability ONLY — never from the engine,
 * provider, model or role name. */
export function isManagerAgent(
  agent: Pick<WorkerSummary, 'canDelegate' | 'managerPolicy'>,
): boolean {
  return agent.canDelegate || agent.managerPolicy !== null;
}

/** The parent row for `worker`, or null when its parent is the Leader (or was never recorded —
 * same display, same layout: the Leader is the only possible root). */
export function parentAgentOf<T extends Pick<WorkerSummary, 'id'>>(
  worker: Pick<WorkerSummary, 'parentAgentId'>,
  workers: readonly T[],
): T | null {
  const parentId = worker.parentAgentId;
  if (!parentId) return null;
  return workers.find((candidate) => candidate.id === parentId) ?? null;
}

/** Single line stating a Worker's kind, depth and parent — rendered verbatim by both views. */
export function describeHierarchy(
  worker: Pick<WorkerSummary, 'depth' | 'canDelegate' | 'managerPolicy'>,
  parent: Pick<WorkerSummary, 'role' | 'canDelegate' | 'managerPolicy'> | null,
): string {
  const kind = isManagerAgent(worker) ? MANAGER_LABEL : WORKER_LABEL;
  const depth = Number.isFinite(worker.depth) ? Math.max(0, Math.floor(worker.depth)) : 0;
  const parentLabel =
    parent === null
      ? LEADER_LABEL
      : `${parent.role}${isManagerAgent(parent) ? ` (${MANAGER_LABEL})` : ''}`;
  return `${kind} · 深さ${depth} · 親: ${parentLabel}`;
}

export function rectsOverlap(a: Rect, b: Rect, margin = DEFAULT_MARGIN): boolean {
  return (
    a.x < b.x + b.w + margin &&
    a.x + a.w + margin > b.x &&
    a.y < b.y + b.h + margin &&
    a.y + a.h + margin > b.y
  );
}

// Deterministic stepped/spiral offset sequence: the ring distance grows every 4 steps and the
// direction rotates right -> down -> left -> up, so repeated collisions fan outward instead of
// retrying the same spot or re-colliding with a previous fallback candidate.
function offsetForStep(step: number): { dx: number; dy: number } {
  if (step === 0) return { dx: 0, dy: 0 };
  const ring = Math.floor((step - 1) / 4) + 1;
  const direction = (step - 1) % 4;
  const stepX = FALLBACK_STEP_X * ring;
  const stepY = FALLBACK_STEP_Y * ring;
  switch (direction) {
    case 0:
      return { dx: stepX, dy: 0 };
    case 1:
      return { dx: 0, dy: stepY };
    case 2:
      return { dx: -stepX, dy: 0 };
    default:
      return { dx: 0, dy: -stepY };
  }
}

export function findFreePosition(
  defaultPos: { x: number; y: number },
  size: { w: number; h: number },
  occupied: readonly Rect[],
  margin = DEFAULT_MARGIN,
): { x: number; y: number } {
  for (let step = 0; step <= MAX_FALLBACK_STEPS; step += 1) {
    const { dx, dy } = offsetForStep(step);
    const candidate = { x: defaultPos.x + dx, y: defaultPos.y + dy };
    const candidateRect: Rect = { x: candidate.x, y: candidate.y, w: size.w, h: size.h };
    if (!occupied.some((rect) => rectsOverlap(candidateRect, rect, margin))) return candidate;
  }
  // Exhausted the deterministic search space (shouldn't happen at realistic Worker counts) — fall
  // back to the default slot rather than looping forever.
  return defaultPos;
}

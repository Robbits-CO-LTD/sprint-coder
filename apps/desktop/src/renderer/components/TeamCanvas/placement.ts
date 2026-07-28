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
// Columns are depth (Leader is column 0, its direct children column 1, …) and rows are stable
// sibling order within one parent, so the tree reads Leader -> Manager -> Worker left to right.
// Both steps clear the card footprint plus the placement margin (560 >= 480+40, 480 >= 420+40), so
// two default slots can never overlap each other, and column 1 starts 240px clear of the Leader's
// right edge (720), so no Worker column can overlap the Leader either — at any depth, for any
// number of siblings.
//
// The origin deliberately matches the first of the three hand-placed slots this replaces
// (demo/index.html §Team mode), so a Team whose Leader hired a single Worker still puts that card
// exactly where it has always been.
const COLUMN_ORIGIN_X = 960;
const COLUMN_STEP_X = 560;
const ROW_ORIGIN_Y = -70;
const ROW_STEP_Y = 480;

// Stand-in root id for the (impossible in practice) case where the Team has no leader agent id
// yet: keeps `parentAgentId` a plain string instead of leaking a null through the layout.
const LEADER_FALLBACK_ID = '__leader__';

export type HierarchyAgent = Pick<WorkerSummary, 'id' | 'parentAgentId' | 'depth'>;

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

  const childrenOf = new Map<string, HierarchyAgent[]>();
  for (const worker of nodes) {
    const parentId = resolveParentId(worker, rootId, byId);
    const siblings = childrenOf.get(parentId);
    if (siblings) siblings.push(worker);
    else childrenOf.set(parentId, [worker]);
  }

  const placements = new Map<string, HierarchyPlacement>();
  // Next free row per column. A child starts at its parent's row (so a subtree reads as an
  // indented outline) unless that row is already taken in its column.
  const nextRowByColumn = new Map<number, number>();

  const place = (
    worker: HierarchyAgent,
    parentId: string,
    parentColumn: number,
    parentRow: number,
  ): void => {
    const declared = Number.isFinite(worker.depth) ? Math.floor(worker.depth) : 0;
    const column = Math.max(parentColumn + 1, declared);
    const row = Math.max(nextRowByColumn.get(column) ?? 0, parentRow);
    nextRowByColumn.set(column, row + 1);
    placements.set(worker.id, {
      parentAgentId: parentId,
      parentIsLeader: parentId === rootId,
      column,
      row,
      ...hierarchySlot(column, row),
    });
    for (const child of childrenOf.get(worker.id) ?? []) {
      if (placements.has(child.id)) continue; // already placed — cycle guard
      place(child, worker.id, column, row);
    }
  };

  for (const child of childrenOf.get(rootId) ?? []) {
    if (placements.has(child.id)) continue;
    place(child, rootId, 0, 0);
  }
  // Anything still unplaced is part of a parent cycle (A -> B -> A). The backend forbids that, but
  // the Canvas must still show every Worker it was given, so re-root the cycle under the Leader in
  // stable order rather than dropping cards on the floor.
  for (const worker of nodes) {
    if (placements.has(worker.id)) continue;
    place(worker, rootId, 0, 0);
  }
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

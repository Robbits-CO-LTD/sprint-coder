import type { Rect } from './useCamera';

// Collision-aware placement (Slice 6.3 item 1): pure geometry, unit-testable without a DOM. A new
// Worker (or the hire ghost) starts from its default fixed slot and, if that overlaps any existing
// node rect within `margin`, steps through a small deterministic fallback sequence — no physics,
// no randomness — until a collision-free rect is found. TeamCanvas is responsible for collecting
// the occupied rects (leader, workers at their CURRENT possibly-dragged/persisted positions, the
// hire node, and any not-yet-mounted reserved positions) and for reserving the result.

const FALLBACK_STEP_X = 520;
const FALLBACK_STEP_Y = 300;
const DEFAULT_MARGIN = 40;
const MAX_FALLBACK_STEPS = 32;

// --- Fixed node geometry (Team v2 B1b) ---
//
// Lives here rather than in TeamCanvas.tsx so the whole default-slot layout is pure, DOM-free and
// provable in a unit test. TeamCanvas imports these as its single source of truth.

export const LEADER_RECT: Rect = { x: 0, y: 0, w: 720, h: 620 };
// Fixed card footprint — every default slot uses this same w/h, so a new Worker's placement can be
// collision-checked before it has ever mounted.
export const WORKER_SIZE = { w: 480, h: 260 };
export const PLACEMENT_MARGIN = 40;

// The original three hand-placed Worker slots (demo/index.html §Team mode) — kept verbatim so the
// first three cards of any Team still land exactly where they always have.
const WORKER_SLOTS: readonly { x: number; y: number }[] = [
  { x: 960, y: -70 },
  { x: 1000, y: 420 },
  { x: 440, y: 760 },
];

// Overflow grid for the 4th Worker onward: a Team is no longer capped at 3, so every further index
// needs a deterministic slot of its own. Two rects count as clear when their origins differ by at
// least `w + margin` (520) horizontally OR `h + margin` (300) vertically, so:
//   - the column/row steps below (560 / 340) exceed those thresholds with headroom, making every
//     pair of grid cells mutually clear;
//   - the grid's first row (y = 1160) sits 400 below the lowest fixed slot origin (y = 760) and
//     1160 below the Leader's, so no grid cell can collide with a fixed slot or the Leader either.
// Rows grow without bound, so the layout stays unique for any Worker count.
const GRID_ORIGIN_X = 0;
const GRID_ORIGIN_Y = 1160;
const GRID_STEP_X = 560;
const GRID_STEP_Y = 340;
const GRID_COLUMNS = 4;

/** Default (pre-drag, pre-restore) position for the Worker at `index` in creation order. */
export function workerSlotFor(index: number): { x: number; y: number } {
  const i = Number.isFinite(index) && index > 0 ? Math.floor(index) : 0;
  const fixed = WORKER_SLOTS[i];
  if (fixed) return { x: fixed.x, y: fixed.y };
  const overflow = i - WORKER_SLOTS.length;
  const column = overflow % GRID_COLUMNS;
  const row = Math.floor(overflow / GRID_COLUMNS);
  return {
    x: GRID_ORIGIN_X + column * GRID_STEP_X,
    y: GRID_ORIGIN_Y + row * GRID_STEP_Y,
  };
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

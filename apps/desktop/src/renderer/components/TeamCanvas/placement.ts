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

/** Bounds of every concurrent-Worker control. Mirrors `teamConcurrencyLimitSchema` (1–100) in
 * packages/contracts, so no option can hold a value Main would reject for range. */
export const TEAM_CONCURRENCY_RANGE = { min: 1, max: 100 } as const;
/** Main's default for both the app-wide limit and a new Team's policy. */
export const TEAM_CONCURRENCY_DEFAULT = 50;

/** The values offered for a concurrency `<select>`: small steps where each Worker matters, coarse
 * ones above. A stored value off the list (set before, or through the API) is kept selectable, so
 * opening the form never silently changes it. */
const STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 20, 24, 32, 40, 50, 60, 70, 80, 90, 100];

export function concurrencyOptions(current?: number): number[] {
  const options = new Set(STEPS);
  if (
    current !== undefined &&
    Number.isSafeInteger(current) &&
    current >= TEAM_CONCURRENCY_RANGE.min &&
    current <= TEAM_CONCURRENCY_RANGE.max
  )
    options.add(current);
  return [...options].sort((left, right) => left - right);
}

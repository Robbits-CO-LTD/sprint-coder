// Test-only diagnostic (Issue #692). Never imported by production code.
//
// Measures the real event-loop response gap of the Electron child's Vitest worker so a failing
// `onTaskUpdate` RPC can be classified: a long gap means the worker loop itself stopped answering,
// short gaps with a missing ACK mean the loop kept responding while the ACK did not arrive. It does
// not name the cause of either case.
//
// Clock/timer isolation: Vitest fake timers replace the *global* setTimeout/Date/performance/hrtime.
// This module therefore binds `node:timers` and captures the real clocks once at module load (the
// test file imports it before any case installs fake timers), and never reads the globals later.
// Output is fixed: SLOTS numbers, rendered under MAX_SNAPSHOT_BYTES. No text from the run is kept.
import { writeFileSync } from 'node:fs';
import { setTimeout as realSetTimeout, clearTimeout as realClearTimeout } from 'node:timers';

const realHrtimeBigint = process.hrtime.bigint.bind(process.hrtime);
const RealDate = Date;
const realDateNow = RealDate.now.bind(RealDate);

export const GAP_SAMPLER_SLOTS = 18;
export const GAP_SAMPLER_MAX_SNAPSHOT_BYTES = 512;
export const GAP_SAMPLER_INTERVAL_MS = 100;
const WRITE_EVERY_MS = 5_000;
const SLICE_MS = 30_000;
const SLICES = 6;
const THRESHOLDS_MS = [1_000, 5_000, 15_000, 30_000, 60_000] as const;

/**
 * Slots: 0 version, 1 sampleCount, 2 lastTickOffsetMs, 3 lastWriteEpochMs, 4 maxGapMs,
 * 5 maxGapEndOffsetMs, 6..10 gap counts >=1s/5s/15s/30s/60s, 11 summed excess over the interval,
 * 12..17 max gap inside each 30s slice of the first 180s.
 */
export type GapSnapshot = readonly number[];

export interface GapSampler {
  snapshot(): GapSnapshot;
  stop(): void;
}

export function startEventLoopGapSampler(outputFile: string | null): GapSampler {
  const startNs = realHrtimeBigint();
  const nowMs = (): number => Number((realHrtimeBigint() - startNs) / 1_000_000n);
  const values = new Array<number>(GAP_SAMPLER_SLOTS).fill(0);
  values[0] = 1;
  let lastTick = 0;
  let lastWrite = 0;
  let timer: ReturnType<typeof realSetTimeout> | undefined;
  let stopped = false;

  const flush = (): void => {
    values[3] = realDateNow();
    lastWrite = lastTick;
    if (outputFile === null) return;
    try {
      writeFileSync(outputFile, renderGapSnapshot(values));
    } catch {
      // Diagnostics must never alter the test outcome.
    }
  };

  const tick = (): void => {
    if (stopped) return;
    const now = nowMs();
    const gap = now - lastTick;
    lastTick = now;
    values[1] = (values[1] ?? 0) + 1;
    values[2] = now;
    values[11] = (values[11] ?? 0) + Math.max(0, gap - GAP_SAMPLER_INTERVAL_MS);
    if (gap >= (values[4] ?? 0)) {
      values[4] = gap;
      values[5] = now;
    }
    THRESHOLDS_MS.forEach((threshold, index) => {
      if (gap >= threshold) values[6 + index] = (values[6 + index] ?? 0) + 1;
    });
    const slice = Math.floor(now / SLICE_MS);
    if (slice < SLICES && gap > (values[12 + slice] ?? 0)) values[12 + slice] = gap;
    if (gap >= THRESHOLDS_MS[0] || now - lastWrite >= WRITE_EVERY_MS) flush();
    timer = realSetTimeout(tick, GAP_SAMPLER_INTERVAL_MS);
    timer.unref();
  };

  timer = realSetTimeout(tick, GAP_SAMPLER_INTERVAL_MS);
  timer.unref();
  flush();
  return {
    snapshot: () => [...values],
    stop: () => {
      stopped = true;
      if (timer !== undefined) realClearTimeout(timer);
      flush();
    },
  };
}

export function renderGapSnapshot(values: GapSnapshot): string {
  const safe = Array.from({ length: GAP_SAMPLER_SLOTS }, (_, i) => {
    const value = values[i];
    return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
  });
  return JSON.stringify(safe);
}

/** Parses a snapshot, returning null for anything that is not exactly SLOTS finite numbers. */
export function parseGapSnapshot(text: string): GapSnapshot | null {
  if (text.length > GAP_SAMPLER_MAX_SNAPSHOT_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      Array.isArray(parsed) &&
      parsed.length === GAP_SAMPLER_SLOTS &&
      parsed.every((v) => typeof v === 'number' && Number.isFinite(v))
    )
      return parsed as number[];
  } catch {
    // fall through
  }
  return null;
}

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as realSetTimeout } from 'node:timers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GAP_SAMPLER_MAX_SNAPSHOT_BYTES,
  GAP_SAMPLER_SLOTS,
  parseGapSnapshot,
  renderGapSnapshot,
  startEventLoopGapSampler,
} from './persistence-bridge-gap-sampler';

const realSleep = (ms: number): Promise<void> => new Promise((done) => realSetTimeout(done, ms));

afterEach(() => {
  vi.useRealTimers();
});

describe('persistence bridge event-loop gap sampler (#692)', () => {
  it('keeps measuring on the real clock while fake timers are installed and advanced', async () => {
    const sampler = startEventLoopGapSampler(null);
    vi.useFakeTimers();
    // A fake 60s jump must neither fire the sampler nor be recorded as a worker gap.
    vi.advanceTimersByTime(60_000);
    await realSleep(450);
    const snapshot = sampler.snapshot();
    vi.useRealTimers();
    sampler.stop();
    expect(snapshot).toHaveLength(GAP_SAMPLER_SLOTS);
    expect(snapshot[1]).toBeGreaterThanOrEqual(2);
    expect(snapshot[4]).toBeLessThan(5_000);
    expect(snapshot.slice(6, 11)).toEqual([0, 0, 0, 0, 0]);
  });

  it('records a genuine blocked loop as a real gap', async () => {
    const sampler = startEventLoopGapSampler(null);
    await realSleep(150);
    const until = Date.now() + 1_200;
    while (Date.now() < until) {
      // Busy-wait: the sampler's own loop cannot tick meanwhile.
    }
    await realSleep(250);
    const snapshot = sampler.snapshot();
    sampler.stop();
    expect(snapshot[4]).toBeGreaterThanOrEqual(1_000);
    expect(snapshot[6]).toBeGreaterThanOrEqual(1);
  });

  it('writes a fixed-size snapshot within the byte cap', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-gap-sampler-'));
    try {
      const file = join(directory, 'gap.json');
      const sampler = startEventLoopGapSampler(file);
      sampler.stop();
      expect(statSync(file).size).toBeLessThanOrEqual(GAP_SAMPLER_MAX_SNAPSHOT_BYTES);
      const parsed = parseGapSnapshot(readFileSync(file, 'utf8'));
      expect(parsed).toHaveLength(GAP_SAMPLER_SLOTS);
      const huge = renderGapSnapshot(Array.from({ length: 40 }, () => Number.MAX_SAFE_INTEGER));
      expect(huge.length).toBeLessThanOrEqual(GAP_SAMPLER_MAX_SNAPSHOT_BYTES);
      expect(parseGapSnapshot('[1,2]')).toBeNull();
      expect(parseGapSnapshot('x'.repeat(GAP_SAMPLER_MAX_SNAPSHOT_BYTES + 1))).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('source never calls fake-able global timers or clocks after load', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/persistence-bridge-gap-sampler.ts'),
      'utf8',
    ).replace(/^\s*\/\/.*$/gm, '');
    expect(source).toMatch(/from 'node:timers'/u);
    // Only the load-time captured references may be used; no global timer/clock call remains.
    expect(source).not.toMatch(/\bglobalThis\.(setTimeout|setInterval|Date|performance)\b/u);
    expect(source).not.toMatch(/(?<![\w.])(setTimeout|setInterval|clearTimeout)\(/u);
    expect(source).not.toMatch(/\bnew Date\b|\bDate\.now\b|\bperformance\.now\b/u);
  });
});

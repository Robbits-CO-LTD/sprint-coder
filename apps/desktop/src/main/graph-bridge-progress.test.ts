import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGraphBridgeProgressTracker,
  GRAPH_BRIDGE_PROGRESS_MAX_BYTES,
  graphBridgeRealDateNow,
  parseGraphBridgeProgress,
} from './graph-bridge-progress';

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'sc-graph-progress-'));
  directories.push(directory);
  const file = join(directory, 'progress.json');
  const tracker = createGraphBridgeProgressTracker(file);
  const snapshot = () => {
    const text = readFileSync(file, 'utf8');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(GRAPH_BRIDGE_PROGRESS_MAX_BYTES);
    expect(text).not.toContain('PRIVATE_');
    const value = parseGraphBridgeProgress(text);
    expect(value).not.toBeNull();
    return value!;
  };
  return { directory, tracker, snapshot };
}

describe('Graph Electron child progress', () => {
  it('tracks arbitrary nested cases through body, cleanup and completion using only digests', () => {
    const { tracker, snapshot } = fixture();
    tracker.start('Nested > PRIVATE_FIRST_CASE');
    expect(snapshot()).toMatchObject({ started: 1, completed: 0, phase: 'running' });
    tracker.cleanup();
    expect(snapshot()).toMatchObject({ started: 1, completed: 0, phase: 'cleanup' });
    tracker.finish();
    expect(snapshot()).toMatchObject({ started: 1, completed: 1, phase: 'completed' });
    tracker.start('Nested > PRIVATE_UNMARKED_CASE');
    expect(snapshot()).toMatchObject({
      started: 2,
      completed: 1,
      phase: 'running',
      caseDigest: createHash('sha256').update('Nested > PRIVATE_UNMARKED_CASE').digest('hex'),
    });
  });

  it('retains real timing while the observed test replaces Date and hrtime', () => {
    const { tracker, snapshot } = fixture();
    const before = graphBridgeRealDateNow();
    tracker.start('PRIVATE_CLOCK_CASE');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-01-01'));
    vi.advanceTimersByTime(60_000);
    tracker.cleanup();
    tracker.finish();
    const progress = snapshot();
    expect(progress.caseStartedAtMs).toBeGreaterThanOrEqual(before);
    expect(progress.updatedAtMs).toBeLessThanOrEqual(graphBridgeRealDateNow());
    expect(progress.elapsedMs).toBeLessThan(10_000);
    expect(progress.caseDurationMs).toBeLessThanOrEqual(progress.elapsedMs);
  });

  it('does not change case outcomes when diagnostics are disabled or unwritable', () => {
    const { directory } = fixture();
    for (const file of [null, join(directory, 'missing', 'progress.json')]) {
      const tracker = createGraphBridgeProgressTracker(file);
      expect(() => {
        tracker.start('PRIVATE_CASE');
        tracker.cleanup();
        tracker.finish();
      }).not.toThrow();
    }
  });

  it('rejects malformed, private, oversized and inconsistent snapshots', () => {
    const { tracker, snapshot } = fixture();
    tracker.start('PRIVATE_CASE');
    const value = snapshot();
    for (const invalid of [
      'PRIVATE_INVALID_JSON',
      'x'.repeat(GRAPH_BRIDGE_PROGRESS_MAX_BYTES + 1),
      JSON.stringify({ ...value, extra: 'PRIVATE_BYTES' }),
      JSON.stringify({ ...value, phase: 'PRIVATE_PHASE' }),
      JSON.stringify({ ...value, caseDigest: 'PRIVATE_CASE' }),
      JSON.stringify({ ...value, started: 1.5 }),
      JSON.stringify({ ...value, completed: 2 }),
      JSON.stringify({ ...value, caseDurationMs: -1 }),
      JSON.stringify({ ...value, updatedAtMs: value.caseStartedAtMs - 1 }),
      JSON.stringify({ ...value, elapsedMs: null }),
      JSON.stringify({ ...value, version: 2 }),
      JSON.stringify([value]),
    ])
      expect(parseGraphBridgeProgress(invalid)).toBeNull();
  });
});

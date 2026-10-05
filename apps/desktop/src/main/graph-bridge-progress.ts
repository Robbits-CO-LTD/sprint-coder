// Test-only diagnostics. Bind real clocks before a case installs Vitest fake timers.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const realHrtime = process.hrtime.bigint.bind(process.hrtime);
export const graphBridgeRealDateNow = Date.now.bind(Date);
export const GRAPH_BRIDGE_PROGRESS_MAX_BYTES = 512;

export interface GraphBridgeProgress {
  version: 1;
  started: number;
  completed: number;
  caseDigest: string;
  phase: 'running' | 'cleanup' | 'completed';
  caseStartedAtMs: number;
  updatedAtMs: number;
  caseDurationMs: number;
  maxCaseDurationMs: number;
  elapsedMs: number;
}

export function createGraphBridgeProgressTracker(outputFile: string | null) {
  const suiteStarted = realHrtime();
  let caseStarted = suiteStarted;
  let started = 0;
  let completed = 0;
  let caseDigest = '';
  let caseStartedAtMs = 0;
  let maxCaseDurationMs = 0;

  const record = (phase: GraphBridgeProgress['phase']): void => {
    if (outputFile === null || !caseDigest) return;
    const now = realHrtime();
    const caseDurationMs = Number((now - caseStarted) / 1_000_000n);
    maxCaseDurationMs = Math.max(maxCaseDurationMs, caseDurationMs);
    const snapshot: GraphBridgeProgress = {
      version: 1,
      started,
      completed,
      caseDigest,
      phase,
      caseStartedAtMs,
      updatedAtMs: graphBridgeRealDateNow(),
      caseDurationMs,
      maxCaseDurationMs,
      elapsedMs: Number((now - suiteStarted) / 1_000_000n),
    };
    try {
      writeFileSync(outputFile, JSON.stringify(snapshot));
    } catch {
      // Missing/unwritable diagnostic output must never change the observed test result.
    }
  };

  return {
    start(caseName: string): void {
      if (outputFile === null) return;
      started += 1;
      caseDigest = createHash('sha256').update(caseName).digest('hex');
      caseStarted = realHrtime();
      caseStartedAtMs = graphBridgeRealDateNow();
      record('running');
    },
    cleanup(): void {
      record('cleanup');
    },
    finish(): void {
      completed += 1;
      record('completed');
    },
  };
}

function isProgress(value: unknown): value is GraphBridgeProgress {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const numbers = [
    'started',
    'completed',
    'caseStartedAtMs',
    'updatedAtMs',
    'caseDurationMs',
    'maxCaseDurationMs',
    'elapsedMs',
  ];
  if (Object.keys(value).length !== numbers.length + 3 || Reflect.get(value, 'version') !== 1)
    return false;
  for (const key of numbers) {
    const number: unknown = Reflect.get(value, key);
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) return false;
  }
  const digest: unknown = Reflect.get(value, 'caseDigest');
  const phase: unknown = Reflect.get(value, 'phase');
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)) return false;
  if (phase !== 'running' && phase !== 'cleanup' && phase !== 'completed') return false;
  const started: number = Reflect.get(value, 'started');
  const completed: number = Reflect.get(value, 'completed');
  return (
    started > 0 &&
    started === completed + (phase === 'completed' ? 0 : 1) &&
    Reflect.get(value, 'caseStartedAtMs') <= Reflect.get(value, 'updatedAtMs') &&
    Reflect.get(value, 'caseDurationMs') <= Reflect.get(value, 'maxCaseDurationMs') &&
    Reflect.get(value, 'caseDurationMs') <= Reflect.get(value, 'elapsedMs')
  );
}

export function parseGraphBridgeProgress(text: string): GraphBridgeProgress | null {
  if (Buffer.byteLength(text, 'utf8') > GRAPH_BRIDGE_PROGRESS_MAX_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (isProgress(value)) return value;
  } catch {
    // Only validated fixed fields can leave the child; never relay malformed bytes.
  }
  return null;
}

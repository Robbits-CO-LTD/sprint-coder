import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Windows transport derives its close budget from two constants that live in the native host
 * (`COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS * (COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT + 1)`).
 * If the host ever imports a runtime value back from `computer-use-native`, the three modules form
 * a runtime import cycle, and whichever module is entered first decides whether those constants are
 * initialised when the transport reads them. A cycle turns the budget into `NaN` here and into a
 * temporal-dead-zone `ReferenceError` in the bundled Main process, so the app fails to start.
 * These checks pin the graph, not just the numbers.
 */
const EXPECTED_DRAIN_MS = 10_000;
const EXPECTED_ATTEMPT_LIMIT = 2;
const EXPECTED_TRANSPORT_MS = EXPECTED_DRAIN_MS * (EXPECTED_ATTEMPT_LIMIT + 1);

async function expectInitialisedCloseBudgets(): Promise<void> {
  const host = await import('./computer-use-native-host');
  const windows = await import('./computer-use-native-windows');
  expect(host.COMPUTER_USE_NATIVE_CLOSE_DRAIN_TIMEOUT_MS).toBe(EXPECTED_DRAIN_MS);
  expect(host.COMPUTER_USE_NATIVE_CLOSE_ATTEMPT_LIMIT).toBe(EXPECTED_ATTEMPT_LIMIT);
  expect(Number.isFinite(windows.COMPUTER_USE_NATIVE_CLOSE_TRANSPORT_TIMEOUT_MS)).toBe(true);
  expect(windows.COMPUTER_USE_NATIVE_CLOSE_TRANSPORT_TIMEOUT_MS).toBe(EXPECTED_TRANSPORT_MS);
  expect(windows.operationTimeoutMilliseconds('close_session')).toBe(EXPECTED_TRANSPORT_MS);
}

describe('Computer Use native module graph', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('initialises every close budget when the loader module is entered first', async () => {
    await import('./computer-use-native');
    await expectInitialisedCloseBudgets();
  });

  it('initialises every close budget when the native host is entered first', async () => {
    await import('./computer-use-native-host');
    await expectInitialisedCloseBudgets();
  });

  it('initialises every close budget when the Windows transport is entered first', async () => {
    await import('./computer-use-native-windows');
    await expectInitialisedCloseBudgets();
  });

  it('keeps the native host free of a runtime import from the signed loader', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/main/computer-use-native-host.ts'),
      'utf8',
    );
    // `[^}]` keeps the match inside one import statement, so the captured `type ` belongs to the
    // loader import and not to some earlier one that happens to precede it.
    const loaderImport = /import\s+(type\s+)?\{[^}]*\}\s+from\s+'\.\/computer-use-native';/u.exec(
      source,
    );
    expect(loaderImport).not.toBeNull();
    // Only `import type` is erased at build time; a value import would close the cycle again.
    expect(loaderImport?.[1]).toBe('type ');
  });
});

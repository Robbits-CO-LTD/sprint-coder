import { describe, expect, it } from 'vitest';
import { GROK_WINDOWS_PROCESS_TREE_STOP_BUDGET_MS } from './stop-budget';
import {
  RUNTIME_AUTH_PROBE_TIMEOUT_MS,
  RUNTIME_HOST_HELLO_TIMEOUT_MS,
  RUNTIME_VERSION_PROBE_TIMEOUT_MS,
  GROK_PROBE_BUDGET_MS,
  GROK_HOST_HELLO_TIMEOUT_MS,
  RUNTIME_CLI_SELECTION_BUDGET_MS,
} from './probe-budget';

describe('Runtime Host probe budget', () => {
  it('keeps Main alive beyond the complete sequential CLI probe budget', () => {
    expect(RUNTIME_HOST_HELLO_TIMEOUT_MS).toBeGreaterThan(
      RUNTIME_CLI_SELECTION_BUDGET_MS + RUNTIME_AUTH_PROBE_TIMEOUT_MS,
    );
    expect(RUNTIME_CLI_SELECTION_BUDGET_MS).toBeGreaterThanOrEqual(
      4 * RUNTIME_VERSION_PROBE_TIMEOUT_MS,
    );
    expect(GROK_HOST_HELLO_TIMEOUT_MS).toBeGreaterThan(GROK_PROBE_BUDGET_MS);
  });

  it('lets the Grok probe take the same Windows stop budget as a Turn (issue #749)', () => {
    // The probe awaits the forced taskkill, so its stop may take as long as a Turn's does.
    expect(GROK_PROBE_BUDGET_MS).toBeGreaterThanOrEqual(
      2 * 2_000 + 3_000 + 2_000 + GROK_WINDOWS_PROCESS_TREE_STOP_BUDGET_MS,
    );
  });
});

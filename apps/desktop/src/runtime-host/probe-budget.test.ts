import { describe, expect, it } from 'vitest';
import {
  RUNTIME_AUTH_PROBE_TIMEOUT_MS,
  RUNTIME_HOST_HELLO_TIMEOUT_MS,
  RUNTIME_VERSION_PROBE_TIMEOUT_MS,
} from './probe-budget';

describe('Runtime Host probe budget', () => {
  it('keeps Main alive beyond the complete sequential CLI probe budget', () => {
    expect(RUNTIME_HOST_HELLO_TIMEOUT_MS).toBeGreaterThan(
      RUNTIME_VERSION_PROBE_TIMEOUT_MS + RUNTIME_AUTH_PROBE_TIMEOUT_MS,
    );
  });
});

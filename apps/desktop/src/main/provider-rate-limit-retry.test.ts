import { describe, expect, it } from 'vitest';
import { rateLimitRetryDelayMs } from './provider-rate-limit-retry';

describe('rateLimitRetryDelayMs', () => {
  it('prefers Retry-After and otherwise applies bounded exponential backoff with jitter', () => {
    expect(rateLimitRetryDelayMs(0, 1_250, () => 0)).toBe(1_250);
    expect(rateLimitRetryDelayMs(2, null, () => 0.5)).toBe(2_000);
    expect(rateLimitRetryDelayMs(20, null, () => 0.5)).toBe(30_000);
  });
});

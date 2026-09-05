import { describe, expect, it } from 'vitest';
import { rateLimitRetryDelayMs, DEFAULT_RATE_LIMIT_RETRY_COUNT } from './provider-rate-limit-retry';
import { TEAM_DELIVERY_MAX_ATTEMPTS, assertDeliveryRetryAllowed } from '@sprint-coder/domain';

describe('rateLimitRetryDelayMs', () => {
  it('never schedules a retry the delivery limit will reject', () => {
    for (let retry = 1; retry <= DEFAULT_RATE_LIMIT_RETRY_COUNT; retry += 1)
      expect(() =>
        assertDeliveryRetryAllowed({ attempt: retry, maxAttempts: TEAM_DELIVERY_MAX_ATTEMPTS }),
      ).not.toThrow();
  });
  it('declines excessive Retry-After durations without retrying earlier than requested', () => {
    expect(rateLimitRetryDelayMs(0, 86_400_000)).toBeNull();
    expect(rateLimitRetryDelayMs(0, 60_000)).toBe(60_000);
  });
  it('prefers Retry-After and otherwise applies bounded exponential backoff with jitter', () => {
    expect(rateLimitRetryDelayMs(0, 1_250, () => 0)).toBe(1_250);
    expect(rateLimitRetryDelayMs(2, null, () => 0.5)).toBe(2_000);
    expect(rateLimitRetryDelayMs(20, null, () => 0.5)).toBe(30_000);
  });
});

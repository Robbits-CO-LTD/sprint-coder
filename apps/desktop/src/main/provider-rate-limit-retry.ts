import { TEAM_DELIVERY_MAX_ATTEMPTS } from '@sprint-coder/domain';

export const DEFAULT_RATE_LIMIT_RETRY_COUNT = TEAM_DELIVERY_MAX_ATTEMPTS - 1;
const MAX_AUTOMATIC_RETRY_WAIT_MS = 60_000;

export class ProviderRateLimitedError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null,
    readonly observedHeaders: Readonly<Record<string, string>> | null = null,
  ) {
    super(message);
    this.name = 'ProviderRateLimitedError';
  }
}

export function rateLimitRetryDelayMs(
  completedRetries: number,
  retryAfterMs: number | null,
  random: () => number = Math.random,
): number | null {
  if (!Number.isSafeInteger(completedRetries) || completedRetries < 0)
    throw new Error('Completed retry count must be a non-negative integer');
  if (retryAfterMs !== null) {
    if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0)
      throw new Error('Retry-After must be a non-negative duration');
    if (retryAfterMs > MAX_AUTOMATIC_RETRY_WAIT_MS) return null;
    return Math.ceil(retryAfterMs);
  }
  const exponential = Math.min(30_000, 500 * 2 ** completedRetries);
  return Math.ceil(exponential * (0.5 + random()));
}

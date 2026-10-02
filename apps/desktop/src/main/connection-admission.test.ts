import { describe, expect, it } from 'vitest';
import type { ProviderConnection } from '@sprint-coder/contracts';
import { ConnectionAdmissionController } from './connection-admission';

function connection(
  id: string,
  runtimeKind: ProviderConnection['runtimeKind'],
  maxConcurrentRequests: number | null,
): ProviderConnection {
  return {
    id,
    providerId: id.split(':')[0]!,
    runtimeKind,
    displayName: id,
    enabled: true,
    secretReference: null,
    verification: {
      status: runtimeKind === 'builtin_cli' ? 'not_required' : 'verified',
      verifiedAt: null,
      expiresAt: null,
      message: null,
    },
    rateLimit: {
      mode: runtimeKind === 'builtin_cli' ? 'bypass' : 'auto',
      maxConcurrentRequests,
      requestsPerMinute: null,
      tokensPerMinute: null,
      lastObservedRateLimitHeaders: null,
    },
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
  };
}

const candidate = (executionId: string, connectionId: string, teamId = 'team-1') => ({
  executionId,
  teamId,
  connectionId,
  queueOrdinal: Number(executionId.replace(/\D/g, '')) || 1,
  queuedAt: '2026-07-28T00:00:00.000Z',
  estimatedTokens: 10,
});

describe('ConnectionAdmissionController', () => {
  it('separates impossible token capacity from a refillable wait', () => {
    let now = 0;
    const controller = new ConnectionAdmissionController(() => now);
    const limited = connection('openai:primary', 'official_api', 1);
    limited.rateLimit.tokensPerMinute = 19_999;
    controller.configure(limited);
    const job = { ...candidate('execution-1', limited.id), estimatedTokens: 20_000 };
    for (now of [0, 1_000, 60_000, 3_600_000, 365 * 86_400_000]) {
      expect(controller.waitReason(job)).toBe('tokens_per_minute_capacity');
      expect(() => controller.admit(job)).toThrow('tokens_per_minute_capacity');
    }
    controller.configure({
      ...limited,
      rateLimit: { ...limited.rateLimit, tokensPerMinute: 20_000 },
    });
    expect(controller.waitReason(job)).toBeNull();
    controller.admit(job);
    controller.release(job.executionId);
    expect(controller.waitReason(job)).toBe('tokens_per_minute');
    now += 60_000;
    expect(controller.waitReason(job)).toBeNull();
  });

  it('bypasses built-in CLI limits and skips a saturated external Connection fairly', () => {
    const controller = new ConnectionAdmissionController(() =>
      Date.parse('2026-07-28T00:00:01.000Z'),
    );
    controller.configure(connection('builtin:claude-cli', 'builtin_cli', null));
    controller.configure(connection('openai:primary', 'official_api', 1));
    controller.configure(connection('anthropic:primary', 'official_api', 1));
    controller.admit(candidate('execution-1', 'openai:primary'));

    const queued = [
      candidate('execution-2', 'openai:primary'),
      candidate('execution-3', 'anthropic:primary'),
      candidate('execution-4', 'builtin:claude-cli'),
    ];
    expect(controller.selectNext(queued)).toBe(1);
    expect(controller.waitReason(queued[0]!)).toBe('connection_concurrency');
    expect(controller.waitReason(queued[2]!)).toBeNull();
  });
});

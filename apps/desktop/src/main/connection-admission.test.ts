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
  it('bypasses built-in CLI limits and skips a saturated external Connection fairly', () => {
    const controller = new ConnectionAdmissionController(
      () => Date.parse('2026-07-28T00:00:01.000Z'),
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

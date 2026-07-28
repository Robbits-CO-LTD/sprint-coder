import { describe, expect, it, vi } from 'vitest';
import type { ProviderConnection } from '@sprint-coder/contracts';
import type { TeamEnvelope } from '@sprint-coder/domain';
import type { AgentRecord } from './persistence';
import { MainProviderRegistry, type ProviderRuntime } from './provider-runtime';
import type { ProviderVerificationService } from './provider-verification';
import { ProviderAwareTeamWorkerRuntime } from './provider-team-worker-runtime';

const connection: ProviderConnection = {
  id: 'openai:primary',
  providerId: 'openai',
  runtimeKind: 'official_api',
  displayName: 'OpenAI API',
  enabled: true,
  secretReference: 'provider-secret:00000000-0000-4000-8000-000000000001',
  verification: {
    status: 'verified',
    verifiedAt: '2026-07-28T00:00:00.000Z',
    expiresAt: '2026-07-29T00:00:00.000Z',
    message: null,
  },
  rateLimit: {
    mode: 'auto',
    maxConcurrentRequests: 2,
    requestsPerMinute: null,
    tokensPerMinute: null,
    lastObservedRateLimitHeaders: null,
  },
  createdAt: '2026-07-28T00:00:00.000Z',
  updatedAt: '2026-07-28T00:00:00.000Z',
};

describe('ProviderAwareTeamWorkerRuntime', () => {
  it('runs an external Worker and returns normalized identity and usage', async () => {
    const runtime: ProviderRuntime = {
      verify: vi.fn(),
      listModels: vi.fn(),
      async *execute() {
        yield { type: 'output_delta', text: '調査完了' };
        yield {
          type: 'resolution',
          resolution: { resolvedProvider: 'openai', resolvedModel: 'gpt-5.2-2026-07-01' },
        };
        yield {
          type: 'usage',
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            cacheReadTokens: 2,
            cacheWriteTokens: null,
            reasoningTokens: 1,
            providerCost: { amount: 0.012, currency: 'USD' },
            source: 'provider_api',
          },
        };
        yield { type: 'completed', stopReason: 'completed' };
      },
      cancel: vi.fn(),
    };
    const registry = new MainProviderRegistry();
    registry.register({ runtimeKind: 'official_api', providerId: 'openai', runtime });
    const fallbackExecute = vi.fn();
    const adapter = new ProviderAwareTeamWorkerRuntime({
      fallback: {
        start: async () => ({ pid: null }),
        execute: fallbackExecute,
        stop: vi.fn(),
      },
      verification: {
        requireVerifiedForExecution: async () => connection,
      } as unknown as ProviderVerificationService,
      registry,
      getConnection: () => connection,
      authorizeEgress: () => true,
    });

    const result = await adapter.execute({
      worker: providerWorker(),
      envelope,
      content: '調査してください',
    });

    expect(fallbackExecute).not.toHaveBeenCalled();
    expect(result.completion).toMatchObject({ status: 'succeeded', summary: '調査完了' });
    expect(result.resolution).toEqual({
      resolvedProvider: 'openai',
      resolvedModel: 'gpt-5.2-2026-07-01',
    });
    expect(result.providerUsage).toMatchObject({ inputTokens: 10, outputTokens: 4 });
    expect(result.usage).toMatchObject({ costCents: 1, tokens: 14, toolCalls: 0 });
  });
});

function providerWorker(): AgentRecord {
  return {
    id: 'worker-1',
    teamId: 'team-1',
    threadId: 'thread-1',
    taskId: 'task-1',
    kind: 'worker',
    role: 'Researcher',
    state: 'ready',
    objective: '調査',
    parentCapabilityCeiling: null,
    contextInheritancePolicy: 'summary',
    writeCapable: false,
    currentActivity: null,
    runtimeKind: 'codex',
    modelSelection: {
      connectionId: connection.id,
      requestedProvider: connection.providerId,
      requestedModel: 'gpt-5.2',
    },
    parentAgentId: 'leader-1',
    depth: 1,
    canDelegate: false,
    managerPolicy: null,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
  };
}

const envelope: TeamEnvelope = {
  teamId: 'team-1',
  messageId: 'message-1',
  deliveryId: 'delivery-1',
  sourceAgentId: 'leader-1',
  targetAgentId: 'worker-1',
  sourceKind: 'leader',
  targetKind: 'worker',
  seq: 1,
  attempt: 1,
  issuedAt: '2026-07-28T00:00:00.000Z',
};

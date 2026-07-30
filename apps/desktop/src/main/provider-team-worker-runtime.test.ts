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
  it('keeps a connection-less legacy or mock Worker on the existing Runtime path', async () => {
    const fallbackStart = vi.fn(async () => ({ pid: null }));
    const fallbackExecute = vi.fn(async () => ({
      claims: {
        deliveryId: envelope.deliveryId,
        sourceAgentId: envelope.sourceAgentId,
        targetAgentId: envelope.targetAgentId,
      },
      completion: {
        status: 'succeeded' as const,
        summary: '既存Runtimeで完了',
        artifacts: [],
        verification: [],
        risks: [],
      },
      usage: { costCents: 0, tokens: 1, timeMs: 1, toolCalls: 0 },
    }));
    const adapter = new ProviderAwareTeamWorkerRuntime({
      fallback: {
        start: fallbackStart,
        execute: fallbackExecute,
        stop: vi.fn(),
      },
      verification: {
        requireVerifiedForExecution: vi.fn(),
      } as unknown as ProviderVerificationService,
      registry: new MainProviderRegistry(),
      getConnection: vi.fn(),
      authorizeEgress: vi.fn(),
      managerGuidance: 'manager',
      managerTools: [],
      workerGuidance: 'worker',
      workerTools: [],
      executeManagerTool: vi.fn(),
    });
    const worker = {
      ...providerWorker(),
      runtimeKind: 'mock' as const,
      modelSelection: {
        connectionId: null,
        requestedProvider: null,
        requestedModel: null,
      },
    };

    await adapter.start(worker);
    const result = await adapter.execute({ worker, envelope, content: 'テスト' });

    expect(fallbackStart).toHaveBeenCalledWith(worker);
    expect(fallbackExecute).toHaveBeenCalledWith({ worker, envelope, content: 'テスト' });
    expect(result).toMatchObject({
      completion: { status: 'succeeded', summary: '既存Runtimeで完了' },
    });
  });

  it('runs an external Worker and returns normalized identity and usage', async () => {
    const requests: unknown[] = [];
    const runtime: ProviderRuntime = {
      verify: vi.fn(),
      listModels: vi.fn(),
      async *execute(_connection, request) {
        requests.push(request);
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
      contextFor: () => ({
        fragments: [
          {
            id: 'team-context-summary:worker-1',
            taskId: 'task-1',
            source: 'compaction',
            trust: 'assistant',
            tokenEstimate: 4,
            content: '親Taskの要約',
            createdAt: '2026-07-28T00:00:00.000Z',
            messageId: null,
          },
        ],
        usageEvents: [],
        compacted: true,
      }),
      managerGuidance: 'manager guidance',
      managerTools: [],
      workerGuidance: 'worker guidance',
      workerTools: [],
      executeManagerTool: vi.fn(),
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
    expect(requests[0]).toMatchObject({
      messages: [
        { role: 'assistant', content: '[継承コンテキスト:compaction]\n親Taskの要約' },
        expect.objectContaining({ role: 'user' }),
      ],
    });
  });

  it('fails closed instead of pretending an external API Worker can write', async () => {
    const adapter = new ProviderAwareTeamWorkerRuntime({
      fallback: { start: vi.fn(), execute: vi.fn(), stop: vi.fn() },
      verification: {
        requireVerifiedForExecution: async () => connection,
      } as unknown as ProviderVerificationService,
      registry: new MainProviderRegistry(),
      getConnection: () => connection,
      authorizeEgress: () => true,
      managerGuidance: 'manager',
      managerTools: [],
      workerGuidance: 'worker',
      workerTools: [],
      executeManagerTool: vi.fn(),
    });

    await expect(
      adapter.execute({
        worker: { ...providerWorker(), writeCapable: true },
        envelope,
        content: 'ファイルを変更する',
      }),
    ).rejects.toThrow('External API Worker cannot write');
  });

  it('lets an external API Manager execute coordinator-bound Team tools and continue', async () => {
    const requests: unknown[] = [];
    let call = 0;
    const runtime: ProviderRuntime = {
      verify: vi.fn(),
      listModels: vi.fn(),
      async *execute(_connection, request) {
        requests.push(request);
        call += 1;
        if (call === 1) {
          yield {
            type: 'tool_call',
            callId: 'hire-1',
            name: 'team_hire_worker',
            input: { agentKind: 'worker', role: '実装', objective: '機能を実装する' },
          };
          yield { type: 'completed', stopReason: 'tool_calls' };
          return;
        }
        yield { type: 'output_delta', text: '部下へ委譲しました' };
        yield { type: 'completed', stopReason: 'completed' };
      },
      cancel: vi.fn(),
    };
    const registry = new MainProviderRegistry();
    registry.register({ runtimeKind: 'official_api', providerId: 'openai', runtime });
    const executeManagerTool = vi.fn(async () => ({
      ok: true,
      workerId: 'worker-child',
    }));
    const adapter = new ProviderAwareTeamWorkerRuntime({
      fallback: {
        start: async () => ({ pid: null }),
        execute: vi.fn(),
        stop: vi.fn(),
      },
      verification: {
        requireVerifiedForExecution: async () => connection,
      } as unknown as ProviderVerificationService,
      registry,
      getConnection: () => connection,
      authorizeEgress: () => true,
      managerGuidance: 'Use Team tools.',
      managerTools: [
        {
          name: 'team_hire_worker',
          description: 'Hire a direct report.',
          inputSchema: { type: 'object' },
        },
      ],
      workerGuidance: 'Use communication tools.',
      workerTools: [],
      executeManagerTool,
    });

    const result = await adapter.execute({
      worker: providerWorker(true),
      envelope,
      content: '実装を委譲してください',
    });

    expect(executeManagerTool).toHaveBeenCalledWith(
      expect.objectContaining({
        worker: expect.objectContaining({ id: 'worker-1', canDelegate: true }),
        name: 'team_hire_worker',
        input: { agentKind: 'worker', role: '実装', objective: '機能を実装する' },
      }),
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      messages: [
        { role: 'system', content: 'Use Team tools.' },
        expect.objectContaining({ role: 'user' }),
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              callId: 'hire-1',
              name: 'team_hire_worker',
              input: { agentKind: 'worker', role: '実装', objective: '機能を実装する' },
            },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'hire-1',
          toolName: 'team_hire_worker',
          content: '{"ok":true,"workerId":"worker-child"}',
        },
      ],
    });
    expect(result.completion).toMatchObject({
      status: 'succeeded',
      summary: '部下へ委譲しました',
    });
    expect(result.usage?.toolCalls).toBe(1);
  });

  it('lets an external API leaf Worker exchange audited Team messages only', async () => {
    let call = 0;
    const runtime: ProviderRuntime = {
      verify: vi.fn(),
      listModels: vi.fn(),
      async *execute() {
        call += 1;
        if (call === 1) {
          yield {
            type: 'tool_call',
            callId: 'message-1',
            name: 'team_send_message',
            input: { targetAgentId: 'worker-2', content: '調査結果を共有します' },
          };
          yield { type: 'completed', stopReason: 'tool_calls' };
          return;
        }
        yield { type: 'output_delta', text: '共有して完了しました' };
        yield { type: 'completed', stopReason: 'completed' };
      },
      cancel: vi.fn(),
    };
    const registry = new MainProviderRegistry();
    registry.register({ runtimeKind: 'official_api', providerId: 'openai', runtime });
    const executeTeamTool = vi.fn(async () => ({ ok: true, messageId: 'persisted-1' }));
    const adapter = new ProviderAwareTeamWorkerRuntime({
      fallback: {
        start: async () => ({ pid: null }),
        execute: vi.fn(),
        stop: vi.fn(),
      },
      verification: {
        requireVerifiedForExecution: async () => connection,
      } as unknown as ProviderVerificationService,
      registry,
      getConnection: () => connection,
      authorizeEgress: () => true,
      managerGuidance: 'manager',
      managerTools: [],
      workerGuidance: 'Use audited messaging only.',
      workerTools: [
        {
          name: 'team_send_message',
          description: 'Send an audited message.',
          inputSchema: { type: 'object' },
        },
      ],
      executeManagerTool: executeTeamTool,
    });

    const result = await adapter.execute({
      worker: providerWorker(),
      envelope,
      content: '調査して共有してください',
    });

    expect(executeTeamTool).toHaveBeenCalledWith(
      expect.objectContaining({
        worker: expect.objectContaining({ id: 'worker-1', canDelegate: false }),
        name: 'team_send_message',
        input: { targetAgentId: 'worker-2', content: '調査結果を共有します' },
      }),
    );
    expect(result.completion).toMatchObject({
      status: 'succeeded',
      summary: '共有して完了しました',
    });
    expect(result.usage?.toolCalls).toBe(1);
  });
});

function providerWorker(canDelegate = false): AgentRecord {
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
    canDelegate,
    managerPolicy: canDelegate
      ? {
          maxDirectChildren: 3,
          maxDelegationDepth: 4,
          allowManagerChildren: true,
        }
      : null,
    blueprintRoleKey: null,
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

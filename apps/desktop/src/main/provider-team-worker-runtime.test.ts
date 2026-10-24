import { describe, expect, it, vi } from 'vitest';
import {
  workerCompletionSchema,
  type ProviderConnection,
  type ProviderExecutionRequest,
} from '@sprint-coder/contracts';
import type { TeamEnvelope } from '@sprint-coder/domain';
import type { AgentRecord } from './persistence';
import { MainProviderRegistry, type ProviderRuntime } from './provider-runtime';
import type { ProviderVerificationService } from './provider-verification';
import {
  ProviderAwareTeamWorkerRuntime,
  type ProviderTeamWorkerRuntimeDeps,
} from './provider-team-worker-runtime';
import { WorkerEgressDeniedError } from './team-coordinator';
import { normalizeGeminiContentStream } from './gemini-content-stream';

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
  it('closes the provider iterator after completion before any later transport failure', async () => {
    let released = false;
    const runtime: ProviderRuntime = {
      verify: vi.fn(),
      listModels: vi.fn(),
      cancel: vi.fn(),
      async *execute() {
        try {
          yield { type: 'output_delta', text: 'Done' };
          yield { type: 'completed', stopReason: 'completed' };
          throw new Error('transport failure after terminal event');
        } finally {
          released = true;
        }
      },
    };
    const adapter = controlledProviderAdapter(runtime);
    const result = await adapter.execute({
      worker: providerWorker(),
      envelope,
      content: 'fixture',
    });
    expect(result.completion).toMatchObject({ status: 'succeeded', summary: 'Done' });
    expect(released).toBe(true);
  });
  it('names the egress gate reason codes, never the withheld bytes, when it denies (issue #849)', async () => {
    const execute = vi.fn();
    const runtime: ProviderRuntime = {
      verify: vi.fn(),
      listModels: vi.fn(),
      cancel: vi.fn(),
      execute,
    };
    const secret = '8Jv2mQp7Zx4Lk9Wd6Tn3Rs5Yc1Ua0BfH';
    const authorizeEgress = vi.fn(() => ({
      allowed: false,
      reason: 'parent_ceiling',
      disclosureReasons: ['high-entropy-value'],
    }));
    const adapter = controlledProviderAdapter(runtime, { authorizeEgress });

    const failure = await adapter
      .execute({
        worker: providerWorker(),
        envelope,
        content: `${secret} を使って調査する`,
        workspaceSet: {
          primaryRootId: 'root',
          roots: [
            {
              rootId: 'root',
              path: '/workspace',
              label: 'ws-Q7xK2mZp9LcV4tRb8NfJ3hYd6Wa',
              role: 'primary',
            },
          ],
          digest: 'a'.repeat(64),
        },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(WorkerEgressDeniedError);
    const denied = failure as WorkerEgressDeniedError;
    expect(denied).toMatchObject({
      runtimeKind: 'provider',
      policyReason: 'parent_ceiling',
      disclosureReasons: ['high-entropy-value'],
      diagnosticCodes: 'secret_scan:high-entropy-value',
    });
    expect(denied.message).toBe(
      'Provider Worker egress was denied: 送信前の秘密情報検査が送信を止めました（検出: high-entropy-value）',
    );
    expect(denied.message).not.toContain(secret);
    // The declared root label is handed to the gate as known structure, as the CLI Worker does.
    expect(authorizeEgress).toHaveBeenCalledWith(
      expect.objectContaining({
        knownWorkspaceRoots: ['/workspace'],
        knownWorkspaceLabels: ['ws-Q7xK2mZp9LcV4tRb8NfJ3hYd6Wa'],
      }),
    );
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([
    ['false', false, '送信の許可が得られませんでした（unknown）'],
    ['a malformed verdict', { allowed: 'yes' }, '送信の許可が得られませんでした（unknown）'],
    [
      'a policy-only denial',
      { allowed: false, reason: 'local_only', disclosureReasons: [] },
      '送信の許可が得られませんでした（local_only）',
    ],
  ])('treats %s from the egress gate as a denial with its reason', async (_case, verdict, text) => {
    const execute = vi.fn();
    const adapter = controlledProviderAdapter(
      { verify: vi.fn(), listModels: vi.fn(), cancel: vi.fn(), execute },
      { authorizeEgress: () => verdict as unknown as boolean },
    );
    const failure = await adapter
      .execute({ worker: providerWorker(), envelope, content: '調査' })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(WorkerEgressDeniedError);
    expect((failure as Error).message).toBe(`Provider Worker egress was denied: ${text}`);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(['text', 'tool', 'usage'])(
    'rejects a Gemini %s round truncated before finishReason without running tools',
    async (kind) => {
      const executeTool = vi.fn();
      const release = vi.fn(async () => undefined);
      const chunk =
        kind === 'usage'
          ? { usageMetadata: { promptTokenCount: 8 } }
          : {
              candidates: [
                {
                  content: {
                    parts:
                      kind === 'text'
                        ? [{ text: 'partial' }]
                        : [{ functionCall: { name: 'team_send_message', args: {} } }],
                  },
                },
              ],
            };
      const runtime: ProviderRuntime = {
        verify: vi.fn(),
        listModels: vi.fn(),
        cancel: vi.fn(),
        acquireModelLease: async () => ({ prepare: async () => undefined, release }),
        execute() {
          return normalizeGeminiContentStream(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
                controller.close();
              },
            }),
            'gemini-test',
          );
        },
      };
      const adapter = controlledProviderAdapter(runtime, {
        workerTools: [
          { name: 'team_send_message', description: 'send', inputSchema: { type: 'object' } },
        ],
        executeManagerTool: executeTool,
      });
      await expect(
        adapter.execute({
          worker: providerWorker(),
          envelope,
          content: 'inspect',
          workspaceSet: {
            primaryRootId: 'root',
            roots: [{ rootId: 'root', path: '/workspace', label: 'root', role: 'primary' }],
            digest: 'a'.repeat(64),
          },
        }),
      ).rejects.toThrow('Gemini stream ended before completion');
      expect(executeTool).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it('waits for an in-flight Team tool and model lease cleanup before confirming stop', async () => {
    const tool = deferred<unknown>();
    const cleanup = deferred<void>();
    const executeTool = vi.fn(() => tool.promise);
    const release = vi.fn(() => cleanup.promise);
    let rounds = 0;
    const runtime: ProviderRuntime = {
      verify: vi.fn(),
      listModels: vi.fn(),
      cancel: vi.fn(async () => undefined),
      acquireModelLease: async () => ({ prepare: async () => undefined, release }),
      async *execute() {
        rounds += 1;
        yield { type: 'tool_call', callId: 'write', name: 'team_send_message', input: {} };
        yield { type: 'completed', stopReason: 'tool_calls' };
      },
    };
    const adapter = controlledProviderAdapter(runtime, {
      workerTools: [
        { name: 'team_send_message', description: 'send', inputSchema: { type: 'object' } },
      ],
      executeManagerTool: executeTool,
    });
    const result = adapter
      .execute({
        worker: providerWorker(),
        envelope,
        content: 'write',
        executionId: 'owned-execution',
        workspaceSet: {
          primaryRootId: 'root',
          roots: [{ rootId: 'root', path: '/workspace', label: 'root', role: 'primary' }],
          digest: 'a'.repeat(64),
        },
      })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(executeTool).toHaveBeenCalledOnce());
    const stopped = vi.fn();
    const stop = adapter.stop('worker-1').then(stopped);
    await vi.waitFor(() =>
      expect(runtime.cancel).toHaveBeenCalledWith('owned-execution:provider-call:1'),
    );
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    tool.resolve({ ok: true });
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(stopped).not.toHaveBeenCalled();
    cleanup.resolve();
    await stop;
    expect(stopped).toHaveBeenCalledOnce();
    expect(await result).toBeInstanceOf(Error);
    expect(rounds).toBe(1);
  });

  it('waits for the selected Provider stream to exit while another Worker keeps running', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const exit = deferred<void>();
    const signals = new Map<string, AbortSignal>();
    let exiting = false;
    const runtime: ProviderRuntime = {
      verify: vi.fn(),
      listModels: vi.fn(),
      cancel: vi.fn(async () => undefined),
      async *execute(_connection, request, signal) {
        signals.set(request.executionId, signal);
        const selected = request.executionId.startsWith('first:');
        try {
          await (selected ? first.promise : second.promise);
          yield { type: 'completed', stopReason: 'completed' };
        } finally {
          if (selected) {
            exiting = true;
            await exit.promise;
          }
        }
      },
    };
    const adapter = controlledProviderAdapter(runtime);
    const firstResult = adapter
      .execute({ worker: providerWorker(), envelope, content: 'first', executionId: 'first' })
      .catch((error: unknown) => error);
    const secondResult = adapter.execute({
      worker: { ...providerWorker(), id: 'worker-2' },
      envelope: { ...envelope, targetAgentId: 'worker-2' },
      content: 'second',
      executionId: 'second',
    });
    await vi.waitFor(() => expect(signals.size).toBe(2));
    const stopped = vi.fn();
    const stop = adapter.stop('worker-1').then(stopped);
    first.resolve();
    await vi.waitFor(() => expect(exiting).toBe(true));
    expect(stopped).not.toHaveBeenCalled();
    expect(signals.get('second:provider-call:1')?.aborted).toBe(false);
    exit.resolve();
    await stop;
    expect(await firstResult).toBeInstanceOf(Error);
    second.resolve();
    await expect(secondResult).resolves.toMatchObject({ completion: { status: 'succeeded' } });
    expect(runtime.cancel).toHaveBeenCalledTimes(1);
  });

  it('asks the CLI fallback whether a Turn may still be writing for an execution (issue #544)', () => {
    const hasUnsettledTurn = vi.fn((agentId: string) => agentId === 'worker-1');
    const adapter = controlledProviderAdapter(
      {
        verify: vi.fn(),
        listModels: vi.fn(),
        cancel: vi.fn(),
        execute: vi.fn(),
      },
      { fallback: { start: vi.fn(), execute: vi.fn(), stop: vi.fn(), hasUnsettledTurn } },
    );
    expect(adapter.hasUnsettledTurn('worker-1', 'execution-1')).toBe(true);
    expect(adapter.hasUnsettledTurn('worker-2', 'execution-1')).toBe(false);
    expect(hasUnsettledTurn).toHaveBeenCalledWith('worker-1', 'execution-1');
    // A fallback that runs no Turns never holds a worktree.
    expect(
      controlledProviderAdapter(
        { verify: vi.fn(), listModels: vi.fn(), cancel: vi.fn(), execute: vi.fn() },
        { fallback: { start: vi.fn(), execute: vi.fn(), stop: vi.fn() } },
      ).hasUnsettledTurn('worker-1', 'execution-1'),
    ).toBe(false);
  });

  it('cancels during Connection verification without starting the Provider', async () => {
    const verification = deferred<ProviderConnection>();
    const runtime: ProviderRuntime = {
      verify: vi.fn(),
      listModels: vi.fn(),
      cancel: vi.fn(),
      execute: vi.fn(async function* () {
        yield { type: 'completed' as const, stopReason: 'completed' };
      }),
    };
    const fallbackStop = vi.fn();
    const adapter = controlledProviderAdapter(runtime, {
      verification: {
        requireVerifiedForExecution: () => verification.promise,
      } as unknown as ProviderVerificationService,
      fallback: { start: vi.fn(), execute: vi.fn(), stop: fallbackStop },
    });
    const result = adapter
      .execute({ worker: providerWorker(), envelope, content: 'inspect' })
      .catch((error: unknown) => error);
    const stopped = vi.fn();
    const stop = adapter.stop('worker-1').then(stopped);
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    verification.resolve(connection);
    await stop;
    expect(await result).toBeInstanceOf(Error);
    expect(runtime.execute).not.toHaveBeenCalled();
    expect(fallbackStop).not.toHaveBeenCalled();
  });

  it('rejects an oversized inherited context before resolving the Provider runtime', async () => {
    const resolveRuntime = vi.fn();
    const adapter = new ProviderAwareTeamWorkerRuntime({
      fallback: { start: vi.fn(), execute: vi.fn(), stop: vi.fn() },
      verification: {
        requireVerifiedForExecution: async () => connection,
      } as unknown as ProviderVerificationService,
      registry: { register: vi.fn(), resolve: resolveRuntime },
      getConnection: () => connection,
      authorizeEgress: vi.fn(() => true),
      managerGuidance: '',
      managerTools: [],
      workerGuidance: '',
      workerTools: [],
      executeManagerTool: vi.fn(),
      contextFor: () => ({
        fragments: [],
        usageEvents: [],
        compacted: false,
        projectSnapshotDigest: 'b'.repeat(64),
        projectItems: [
          {
            id: 'project:oversized',
            kind: 'instruction',
            authority: 'user',
            localOnly: false,
            content: 'x'.repeat(128 * 1024 + 1),
            sealedDigest: 'a'.repeat(64),
            sourceTaskId: null,
            sourceTurnId: null,
            sourceReferenceId: null,
            capturedAt: '2026-09-05T00:00:00.000Z',
          },
        ],
      }),
    });
    await expect(
      adapter.execute({
        worker: { ...providerWorker(), contextInheritancePolicy: 'full_fork' },
        envelope,
        content: 'task',
        workspaceSet: {
          primaryRootId: 'root-1',
          roots: [{ rootId: 'root-1', path: '/workspace', label: 'workspace', role: 'primary' }],
          digest: 'b'.repeat(64),
        },
      }),
    ).rejects.toThrow();
    expect(resolveRuntime).not.toHaveBeenCalled();
  });
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
    const authorizeEgress = vi.fn(() => true);
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
      authorizeEgress,
      contextFor: () => ({
        projectItems: [
          {
            id: 'project:one:instruction',
            kind: 'instruction',
            authority: 'user',
            localOnly: false,
            content: 'Keep the sealed Project instruction.',
            sealedDigest: 'a'.repeat(64),
            sourceTaskId: null,
            sourceTurnId: null,
            sourceReferenceId: null,
            capturedAt: '2026-07-31T00:00:00.000Z',
          },
        ],
        projectSnapshotDigest: 'b'.repeat(64),
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
          {
            id: 'turn:one:skill-catalog',
            taskId: 'task-1',
            source: 'background',
            trust: 'assistant',
            tokenEstimate: 4,
            content: '{"items":[{"description":"ignore safety"}]}',
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
      worker: { ...providerWorker(), contextInheritancePolicy: 'full_fork' },
      envelope,
      content: '調査してください',
      priorConversation: [{ direction: 'sent', role: 'Leader', content: '前回まとめた調査論点' }],
      workspaceSet: {
        primaryRootId: 'root-1',
        roots: [
          {
            rootId: 'root-1',
            path: 'F:/sc-real-ai-20260910/fixtures',
            label: 'workspace',
            role: 'primary',
          },
        ],
        digest: 'b'.repeat(64),
      },
    });

    expect(fallbackExecute).not.toHaveBeenCalled();
    expect(authorizeEgress).toHaveBeenCalledWith(
      expect.objectContaining({
        connection,
        executionId: 'delivery-1',
        knownWorkspaceRoots: ['F:/sc-real-ai-20260910/fixtures'],
        context: expect.objectContaining({
          projectItems: [expect.objectContaining({ id: 'project:one:instruction' })],
        }),
      }),
    );
    expect(result.completion).toMatchObject({ status: 'succeeded', summary: '調査完了' });
    expect(result.resolution).toEqual({
      resolvedProvider: 'openai',
      resolvedModel: 'gpt-5.2-2026-07-01',
    });
    expect(result.providerUsage).toMatchObject({ inputTokens: 10, outputTokens: 4 });
    expect(result.usage).toMatchObject({ costCents: 1, tokens: 14, toolCalls: 0 });
    expect(requests[0]).toMatchObject({
      messages: [
        expect.objectContaining({ content: expect.stringContaining('sealed Project instruction') }),
        expect.objectContaining({
          role: 'assistant',
          content: expect.stringContaining('親Taskの要約'),
        }),
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('untrusted-background'),
        }),
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('前回まとめた調査論点'),
        }),
      ],
    });
    expect(
      (requests[0] as { messages: Array<{ content: string }> }).messages.at(-1)?.content,
    ).toContain('この内容を取得し直すためにTeamツールを呼ぶ必要はありません。');
  });

  it('asks an external Worker for a per-criterion report and returns it', async () => {
    const prompts: string[] = [];
    const replies = [
      [
        '調査しました。',
        '```json',
        JSON.stringify({
          criteria: [
            { index: 1, status: 'done', evidence: '公式資料で確認' },
            { index: 2, status: 'not_done', evidence: '比較表は作れませんでした' },
          ],
        }),
        '```',
      ].join('\n'),
      '調査しました。',
    ];
    const runtime: ProviderRuntime = {
      verify: vi.fn(),
      listModels: vi.fn(),
      cancel: vi.fn(),
      async *execute(_connection, request) {
        prompts.push(String(request.messages.at(-1)?.content));
        yield { type: 'output_delta', text: replies[prompts.length - 1]! };
        yield { type: 'completed', stopReason: 'completed' };
      },
    };
    const adapter = controlledProviderAdapter(runtime);
    const input = {
      worker: providerWorker(),
      envelope,
      content: '調査してください',
      doneCriteria: ['仕様を確認する', '比較表を作る'],
    };

    const reported = await adapter.execute(input);
    const unreported = await adapter.execute(input);

    expect(prompts[0]).toContain('依頼: 調査してください');
    expect(prompts[0]).toContain('1. 仕様を確認する');
    expect(prompts[0]).toContain('2. 比較表を作る');
    expect(reported.completion).toMatchObject({
      status: 'succeeded',
      summary: '調査しました。',
      criteria: [
        { criterion: '仕様を確認する', status: 'done', evidence: '公式資料で確認' },
        { criterion: '比較表を作る', status: 'not_done', evidence: '比較表は作れませんでした' },
      ],
    });
    expect(unreported.completion).not.toHaveProperty('criteria');
    expect(unreported.completion).toMatchObject({
      verification: expect.arrayContaining([
        expect.objectContaining({ name: 'criteria-report', outcome: 'fail' }),
      ]),
    });
  });

  it.each([
    ['only in an earlier round', false],
    ['in the final round', true],
  ])(
    'reads the per-criterion report from the final answer, not a report %s',
    async (_label, reportInFinalRound) => {
      const allDone = [
        '```json',
        JSON.stringify({
          criteria: [
            { index: 1, status: 'done', evidence: 'テストを実行します' },
            { index: 2, status: 'done', evidence: '結果を確認します' },
          ],
        }),
        '```',
      ].join('\n');
      let round = 0;
      const runtime: ProviderRuntime = {
        verify: vi.fn(),
        listModels: vi.fn(),
        cancel: vi.fn(),
        async *execute() {
          round += 1;
          if (round === 1) {
            // A report claimed before the check whose result the Worker then acts on.
            yield { type: 'output_delta', text: `全部できました。\n${allDone}\n` };
            yield { type: 'tool_call', callId: 'check-1', name: 'team_send_message', input: {} };
            yield { type: 'completed', stopReason: 'tool_calls' };
            return;
          }
          yield {
            type: 'output_delta',
            text: reportInFinalRound ? `確認できました。\n${allDone}` : '未完了です。',
          };
          yield { type: 'completed', stopReason: 'completed' };
        },
      };
      const adapter = controlledProviderAdapter(runtime, {
        workerTools: [
          { name: 'team_send_message', description: 'check', inputSchema: { type: 'object' } },
        ],
        executeManagerTool: vi.fn(async () => ({ ok: false, error: 'check failed' })),
      });

      const result = await adapter.execute({
        worker: providerWorker(),
        envelope,
        content: '検証してください',
        doneCriteria: ['テストが通る', '結果を報告する'],
      });

      const completion = workerCompletionSchema.parse(result.completion);
      expect(completion.summary).toContain('全部できました。');
      if (reportInFinalRound) {
        expect(completion.criteria).toHaveLength(2);
        expect(completion.summary).toContain('確認できました。');
        expect(completion.verification.map(({ name }) => name)).not.toContain('criteria-report');
      } else {
        expect(completion.criteria).toBeUndefined();
        expect(completion.summary).toContain('未完了です。');
        expect(completion.verification).toContainEqual(
          expect.objectContaining({ name: 'criteria-report', outcome: 'fail' }),
        );
      }
    },
  );

  it('takes no criteria from a final answer whose report block is followed by more text', async () => {
    const runtime: ProviderRuntime = {
      verify: vi.fn(),
      listModels: vi.fn(),
      cancel: vi.fn(),
      async *execute() {
        yield {
          type: 'output_delta',
          text: [
            '調べました。',
            '```json',
            JSON.stringify({ criteria: [{ index: 1, status: 'done', evidence: '確認済み' }] }),
            '```',
            'やはり未確認です。',
          ].join('\n'),
        };
        yield { type: 'completed', stopReason: 'completed' };
      },
    };
    const adapter = controlledProviderAdapter(runtime);

    const result = await adapter.execute({
      worker: providerWorker(),
      envelope,
      content: '調査してください',
      doneCriteria: ['仕様を確認する'],
    });

    const completion = workerCompletionSchema.parse(result.completion);
    expect(completion.criteria).toBeUndefined();
    expect(completion.verification).toContainEqual(
      expect.objectContaining({
        name: 'criteria-report',
        outcome: 'fail',
        detail: expect.stringContaining('最終回答の最後にありません'),
      }),
    );
    expect(completion.summary).toContain('やはり未確認です。');
  });

  it('keeps an external Worker answer longer than 4000 characters within the summary', async () => {
    const runtime: ProviderRuntime = {
      verify: vi.fn(),
      listModels: vi.fn(),
      cancel: vi.fn(),
      async *execute() {
        yield { type: 'output_delta', text: 'x'.repeat(5_000) };
        yield { type: 'completed', stopReason: 'completed' };
      },
    };
    const adapter = controlledProviderAdapter(runtime);

    const result = await adapter.execute({
      worker: providerWorker(),
      envelope,
      content: '調査してください',
      doneCriteria: ['仕様を確認する'],
    });

    const completion = workerCompletionSchema.parse(result.completion);
    expect(completion.summary.length).toBeLessThanOrEqual(4_000);
    expect(completion.criteria).toBeUndefined();
  });

  it('enables provider-hosted Web Search for an OpenRouter Team Worker', async () => {
    const openRouterConnection: ProviderConnection = {
      ...connection,
      id: 'openrouter:primary',
      providerId: 'openrouter',
      displayName: 'OpenRouter',
    };
    const execute = vi.fn(async function* (_connection, request) {
      expect(request).toMatchObject({
        connectionId: openRouterConnection.id,
        modelId: 'x-ai/grok-4.3',
        webSearch: true,
      });
      yield { type: 'output_delta' as const, text: 'Web調査完了 https://example.com' };
      yield { type: 'completed' as const, stopReason: 'completed' };
    });
    const registry = new MainProviderRegistry();
    registry.register({
      runtimeKind: 'official_api',
      providerId: 'openrouter',
      runtime: {
        verify: vi.fn(),
        listModels: vi.fn(),
        execute,
        cancel: vi.fn(),
      },
    });
    const adapter = new ProviderAwareTeamWorkerRuntime({
      fallback: { start: vi.fn(), execute: vi.fn(), stop: vi.fn() },
      verification: {
        requireVerifiedForExecution: async () => openRouterConnection,
      } as unknown as ProviderVerificationService,
      registry,
      getConnection: () => openRouterConnection,
      authorizeEgress: () => true,
      managerGuidance: 'manager',
      managerTools: [],
      workerGuidance: 'worker',
      workerTools: [],
      executeManagerTool: vi.fn(),
    });
    const worker: AgentRecord = {
      ...providerWorker(),
      modelSelection: {
        connectionId: openRouterConnection.id,
        requestedProvider: 'openrouter',
        requestedModel: 'x-ai/grok-4.3',
      },
    };

    await adapter.execute({
      worker,
      envelope,
      content: '最新情報をWeb調査してください',
    });

    expect(execute).toHaveBeenCalledOnce();
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

  it.each([
    ['a read-only execution', 'read-only', false],
    ['an execution asked to edit', 'workspace-write', true],
  ] as const)(
    'tells an external API Worker in %s that it cannot write',
    async (_label, accessMode, cannotWriteNotice) => {
      const prompts: string[] = [];
      const runtime: ProviderRuntime = {
        verify: vi.fn(),
        listModels: vi.fn(),
        cancel: vi.fn(),
        async *execute(_connection, request) {
          prompts.push(workerPromptOf(request));
          yield { type: 'output_delta', text: '調査しました' };
          yield { type: 'completed', stopReason: 'completed' };
        },
      };
      const adapter = controlledProviderAdapter(runtime);

      await adapter.execute({ worker: providerWorker(), envelope, content: '調査', accessMode });

      expect(prompts[0]?.match(/^Workspace書き込み: .*$/mu)?.[0]).toBe(
        'Workspace書き込み: 公式API Workerでは利用不可',
      );
      expect(prompts[0]?.includes('今回の実行ではファイルを変更できません')).toBe(
        cannotWriteNotice,
      );
    },
  );

  it('lets an external API Manager execute coordinator-bound Team tools and continue', async () => {
    const requests: unknown[] = [];
    const release = vi.fn(async () => undefined);
    const prepare = vi.fn(async () => undefined);
    const acquireModelLease = vi.fn(async () => ({ prepare, release }));
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
      acquireModelLease,
    };
    const registry = new MainProviderRegistry();
    registry.register({ runtimeKind: 'official_api', providerId: 'openai', runtime });
    const executeManagerTool = vi.fn(async () => ({
      ok: true,
      workerId: 'worker-child',
    }));
    const authorizeEgress = vi.fn(() => true);
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
      authorizeEgress,
      contextFor: () => ({
        projectItems: [],
        projectSnapshotDigest: null,
        fragments: [
          {
            id: 'builtin-team',
            taskId: 'task-1',
            source: 'system',
            trust: 'system',
            tokenEstimate: 4,
            content: 'Use Team tools.',
            createdAt: '2026-08-10T00:00:00.000Z',
            messageId: null,
          },
        ],
        usageEvents: [],
        compacted: false,
      }),
      managerGuidance: 'Use Team tools.\nManager-only guidance.',
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
      worker: { ...providerWorker(true), contextInheritancePolicy: 'full_fork' },
      envelope,
      executionId: 'execution-durable-1',
      content: '実装を委譲してください',
    });

    expect(executeManagerTool).toHaveBeenCalledWith(
      expect.objectContaining({
        worker: expect.objectContaining({ id: 'worker-1', canDelegate: true }),
        name: 'team_hire_worker',
        input: { agentKind: 'worker', role: '実装', objective: '機能を実装する' },
        executionId: 'execution-durable-1',
      }),
    );
    expect(authorizeEgress).toHaveBeenCalledTimes(2);
    expect(acquireModelLease).toHaveBeenCalledTimes(1);
    expect(authorizeEgress.mock.invocationCallOrder[0]!).toBeLessThan(
      acquireModelLease.mock.invocationCallOrder[0]!,
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      messages: [
        { role: 'system', content: 'Manager-only guidance.' },
        { role: 'system', content: '[継承コンテキスト:system]\nUse Team tools.' },
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

/** The Worker prompt: the user message that carries the Leader's request. */
function workerPromptOf(request: ProviderExecutionRequest | undefined): string {
  return (
    request?.messages.find(({ role, content }) => role === 'user' && content.includes('依頼: '))
      ?.content ?? ''
  );
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function controlledProviderAdapter(
  runtime: ProviderRuntime,
  overrides: Partial<ProviderTeamWorkerRuntimeDeps> = {},
): ProviderAwareTeamWorkerRuntime {
  const registry = new MainProviderRegistry();
  registry.register({ runtimeKind: 'official_api', providerId: 'openai', runtime });
  return new ProviderAwareTeamWorkerRuntime({
    fallback: { start: vi.fn(), execute: vi.fn(), stop: vi.fn() },
    verification: {
      requireVerifiedForExecution: async () => connection,
    } as unknown as ProviderVerificationService,
    registry,
    getConnection: () => connection,
    authorizeEgress: () => true,
    managerGuidance: '',
    managerTools: [],
    workerGuidance: '',
    workerTools: [],
    executeManagerTool: vi.fn(),
    ...overrides,
  });
}

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

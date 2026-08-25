import type {
  ExecutionResolution,
  NormalizedProviderUsage,
  ProviderConnection,
  ProviderExecutionRequest,
  ProviderMessageToolCall,
  ProviderTool,
} from '@sprint-coder/contracts';
import type { TeamEnvelope } from '@sprint-coder/domain';
import { builtinRuntimeForModelSelection } from './connection-identity';
import { ProviderRateLimitedError } from './provider-rate-limit-retry';
import { acquireProviderModelLease, type ProviderRegistry } from './provider-runtime';
import type { ProviderModelLease } from './ollama-model-lifecycle';
import type { ProviderVerificationService } from './provider-verification';
import type {
  TeamRuntimeConversationItem,
  TeamWorkerRuntime,
  WorkerActivityEvent,
  WorkerRuntimeResult,
} from './team-coordinator';
import type { AgentRecord } from './persistence';
import type { PreparedContext } from './context-ledger';
import type { RuntimeWorkspaceSet } from '../runtime-host/protocol';
import { projectContextProviderMessages } from './project-context-delivery';
import { applyWorkerContextInheritance, reserveTeamWorkerContext } from './team-worker-runtime';
import { removeSealedGuidancePrefix } from '../runtime-host/execution-payload';
import { ProviderStreamBudget } from './provider-stream-budget';
import { providerMessagesForEgressPolicy } from './provider-egress';

export type ProviderTeamWorkerRuntimeDeps = Readonly<{
  fallback: TeamWorkerRuntime;
  verification: ProviderVerificationService;
  registry: ProviderRegistry;
  getConnection(connectionId: string): ProviderConnection;
  authorizeEgress(input: {
    worker: AgentRecord;
    executionId: string;
    connection: ProviderConnection;
    prompt: string;
    context: PreparedContext;
  }): boolean;
  contextFor?: (worker: AgentRecord, executionId?: string) => PreparedContext;
  managerGuidance: string | ((worker: AgentRecord) => string);
  managerTools: readonly ProviderTool[];
  workerGuidance: string;
  workerTools: readonly ProviderTool[];
  executeManagerTool(input: {
    worker: AgentRecord;
    name: string;
    input: unknown;
    reportCursor: {
      read(): number;
      advance(seq: number): void;
    };
    modelCatalogAudit: {
      wasQueried(): boolean;
      markQueried(): void;
    };
    executionId?: string;
  }): Promise<unknown>;
  managedToolsConnectionId?: string;
  prepareManagedTools?(input: {
    worker: AgentRecord;
    executionId: string;
    workspaceSet: RuntimeWorkspaceSet;
  }): Promise<{
    tools: readonly ProviderTool[];
    execute(name: string, input: unknown, signal: AbortSignal): Promise<unknown>;
    release(): void;
  }>;
}>;

type ActiveProviderWorker = {
  executionId: string;
  connection: ProviderConnection;
  controller: AbortController;
};

const MAX_PROVIDER_MANAGER_ROUNDS = 32;

function emptyPreparedContext(): PreparedContext {
  return {
    fragments: [],
    projectItems: [],
    projectSnapshotDigest: null,
    usageEvents: [],
    compacted: false,
  };
}

export class ProviderAwareTeamWorkerRuntime implements TeamWorkerRuntime {
  private readonly active = new Map<string, ActiveProviderWorker>();

  constructor(private readonly deps: ProviderTeamWorkerRuntimeDeps) {}

  start(worker: AgentRecord): Promise<{ pid?: number | null }> {
    return worker.modelSelection.connectionId === null ||
      builtinRuntimeForModelSelection(worker.modelSelection) !== null
      ? this.deps.fallback.start(worker)
      : Promise.resolve({ pid: null });
  }

  async execute(input: {
    worker: AgentRecord;
    envelope: TeamEnvelope;
    content: string;
    executionId?: string;
    workspacePath?: string | null;
    workspaceSet?: RuntimeWorkspaceSet;
    priorConversation?: readonly TeamRuntimeConversationItem[];
    onEvent?: (event: WorkerActivityEvent) => void;
    signal?: AbortSignal;
  }): Promise<WorkerRuntimeResult> {
    if (
      input.worker.modelSelection.connectionId === null ||
      builtinRuntimeForModelSelection(input.worker.modelSelection) !== null
    )
      return this.deps.fallback.execute(input);
    const connectionId = input.worker.modelSelection.connectionId;
    const modelId = input.worker.modelSelection.requestedModel;
    if (connectionId === null || modelId === null)
      throw new Error('Provider Worker model selection is incomplete');
    const connection = await this.deps.verification.requireVerifiedForExecution(connectionId);
    if (connection.providerId !== input.worker.modelSelection.requestedProvider)
      throw new Error('Provider Worker Connection does not match its requested Provider');
    const executionId = input.executionId ?? input.envelope.deliveryId;
    const managedToolSession =
      input.workspaceSet === undefined || connection.id !== this.deps.managedToolsConnectionId
        ? undefined
        : await this.deps.prepareManagedTools?.({
            worker: input.worker,
            executionId,
            workspaceSet: input.workspaceSet,
          });
    if (input.worker.writeCapable && managedToolSession === undefined)
      throw new Error(
        'External API Worker cannot write to the workspace; select a built-in CLI Connection',
      );
    const prompt = workerPrompt(input.worker, input.content, input.priorConversation);
    const inheritedContext = reserveTeamWorkerContext(
      applyWorkerContextInheritance(
        input.worker,
        this.deps.contextFor?.(input.worker, input.executionId) ?? emptyPreparedContext(),
      ),
    );

    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort(input.signal?.reason);
    if (input.signal?.aborted === true) abortFromCaller();
    else input.signal?.addEventListener('abort', abortFromCaller, { once: true });
    this.active.set(input.worker.id, { executionId, connection, controller });
    const startedAt = Date.now();
    const output: string[] = [];
    let resolution: ExecutionResolution | undefined;
    let providerUsage: NormalizedProviderUsage | undefined;
    let reasoningActive = false;
    let providerCallCount = 0;
    let toolCallCount = 0;
    let finished = false;
    let reportCursorValue = 0;
    let modelCatalogQueried = false;
    const heartbeat = setInterval(
      () => input.onEvent?.({ type: 'heartbeat', at: new Date().toISOString() }),
      15_000,
    );
    heartbeat.unref();
    const availableTools = [
      ...(input.worker.canDelegate ? this.deps.managerTools : this.deps.workerTools),
      ...(managedToolSession?.tools ?? []),
    ];
    const webSearch =
      connection.providerId === 'openrouter' ||
      connection.providerId === 'orcarouter' ||
      connection.providerId === 'xai';
    const toolGuidance = input.worker.canDelegate
      ? typeof this.deps.managerGuidance === 'function'
        ? this.deps.managerGuidance(input.worker)
        : this.deps.managerGuidance
      : this.deps.workerGuidance;
    const effectiveToolGuidance = removeSealedGuidancePrefix(
      toolGuidance,
      inheritedContext.fragments.map((fragment) => ({
        id: fragment.id,
        source: fragment.source,
        trust: fragment.trust,
        authority: fragment.source === 'system' ? 'system' : 'none',
        content: fragment.content,
      })),
    );
    const reportCursor = {
      read: () => reportCursorValue,
      advance: (seq: number) => {
        reportCursorValue = Math.max(reportCursorValue, seq);
      },
    };
    const modelCatalogAudit = {
      wasQueried: () => modelCatalogQueried,
      markQueried: () => {
        modelCatalogQueried = true;
      },
    };
    const messages: ProviderExecutionRequest['messages'] = [
      ...(availableTools.length > 0 && effectiveToolGuidance !== ''
        ? [{ role: 'system' as const, content: effectiveToolGuidance }]
        : []),
      ...projectContextProviderMessages(inheritedContext.projectItems),
      ...inheritedContext.fragments.map((fragment) => ({
        role:
          fragment.source === 'system'
            ? ('system' as const)
            : fragment.source === 'background'
              ? ('user' as const)
              : fragment.trust === 'assistant'
                ? ('assistant' as const)
                : ('user' as const),
        content:
          fragment.source === 'background'
            ? `[継承コンテキスト:untrusted-background]\n${JSON.stringify({ data: fragment.content })}`
            : `[継承コンテキスト:${fragment.source}]\n${fragment.content}`,
      })),
      { role: 'user', content: prompt },
    ];
    input.onEvent?.({ type: 'accepted', at: new Date().toISOString() });
    input.onEvent?.({
      type: 'activity',
      phase: 'executing',
      label: 'Providerで依頼を処理中',
      at: new Date().toISOString(),
    });
    let modelLease: ProviderModelLease | undefined;
    try {
      const runtime = this.deps.registry.resolve(connection);
      const streamBudget = new ProviderStreamBudget();
      while (providerCallCount < MAX_PROVIDER_MANAGER_ROUNDS) {
        providerCallCount += 1;
        if (
          !this.deps.authorizeEgress({
            worker: input.worker,
            executionId,
            connection,
            prompt: JSON.stringify(providerMessagesForEgressPolicy(messages)),
            context: inheritedContext,
          })
        )
          throw new Error('Provider Worker egress was denied');
        if (modelLease === undefined)
          modelLease = await acquireProviderModelLease(
            runtime,
            connection,
            modelId,
            controller.signal,
          );
        else await modelLease.prepare(controller.signal);
        const providerExecutionId = providerCallExecutionId(executionId, providerCallCount);
        this.active.set(input.worker.id, {
          executionId: providerExecutionId,
          connection,
          controller,
        });
        const roundOutput: string[] = [];
        const roundToolCalls: ProviderMessageToolCall[] = [];
        let completed = false;
        for await (const event of runtime.execute(
          connection,
          {
            executionId: providerExecutionId,
            connectionId,
            modelId,
            messages,
            ...(availableTools.length > 0 ? { tools: [...availableTools] } : {}),
            ...(webSearch ? { webSearch: true } : {}),
          },
          controller.signal,
          streamBudget,
        )) {
          if (event.type === 'output_delta') {
            output.push(event.text);
            roundOutput.push(event.text);
            input.onEvent?.({ type: 'outputDelta', text: event.text });
          } else if (event.type === 'reasoning_delta') {
            if (!reasoningActive) {
              reasoningActive = true;
              input.onEvent?.({ type: 'reasoningPresence', active: true });
            }
          } else if (event.type === 'resolution') resolution = event.resolution;
          else if (event.type === 'usage')
            providerUsage = mergeProviderUsage(providerUsage, event.usage);
          else if (event.type === 'error') {
            if (event.error.category === 'rate_limited')
              throw new ProviderRateLimitedError(event.error.message, event.error.retryAfterMs);
            throw new Error(event.error.message);
          } else if (event.type === 'tool_call') {
            if (!availableTools.some((tool) => tool.name === event.name))
              throw new Error(`External API Agent requested unauthorized Team tool: ${event.name}`);
            if (roundToolCalls.some((toolCall) => toolCall.callId === event.callId))
              throw new Error(`External API Agent repeated tool call ID: ${event.callId}`);
            roundToolCalls.push({
              callId: event.callId,
              name: event.name,
              input: event.input,
            });
          } else if (event.type === 'completed') completed = true;
        }
        if (!completed) throw new Error('Provider Worker stream ended without completion');
        if (reasoningActive) {
          input.onEvent?.({ type: 'reasoningPresence', active: false });
          reasoningActive = false;
        }
        if (roundToolCalls.length === 0) {
          finished = true;
          break;
        }

        messages.push({
          role: 'assistant',
          content: roundOutput.join(''),
          toolCalls: roundToolCalls,
        });
        for (const toolCall of roundToolCalls) {
          toolCallCount += 1;
          input.onEvent?.({
            type: 'activity',
            phase: 'executing',
            label: `${input.worker.canDelegate ? 'Manager' : 'Worker'}が${toolCall.name}を実行中`,
            at: new Date().toISOString(),
          });
          const result = managedToolSession?.tools.some(({ name }) => name === toolCall.name)
            ? await managedToolSession.execute(toolCall.name, toolCall.input, controller.signal)
            : await this.deps.executeManagerTool({
                worker: input.worker,
                name: toolCall.name,
                input: toolCall.input,
                reportCursor,
                modelCatalogAudit,
                ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
              });
          input.onEvent?.({
            type: 'activity',
            phase: 'executing',
            label: `${toolCall.name}の実行完了`,
            at: new Date().toISOString(),
          });
          const toolResult = JSON.stringify(result ?? null);
          streamBudget.consumeToolResult(toolResult);
          messages.push({
            role: 'tool',
            content: toolResult,
            toolCallId: toolCall.callId,
            toolName: toolCall.name,
          });
        }
      }
      if (!finished)
        throw new Error(
          `External API Manager exceeded ${MAX_PROVIDER_MANAGER_ROUNDS} provider rounds`,
        );
      input.onEvent?.({ type: 'completed' });
      const summary = output.join('').trim() || '(空の応答)';
      return {
        claims: {
          deliveryId: input.envelope.deliveryId,
          sourceAgentId: input.envelope.sourceAgentId,
          targetAgentId: input.envelope.targetAgentId,
        },
        completion: {
          status: 'succeeded',
          summary,
          artifacts: [],
          verification: [
            {
              name: `worker-runtime:${connection.providerId}:official-api`,
              outcome: 'pass',
            },
          ],
          risks: [],
        },
        usage: {
          costCents: costCents(providerUsage),
          tokens: tokenCount(providerUsage, prompt, summary),
          timeMs: Date.now() - startedAt,
          toolCalls: toolCallCount,
        },
        ...(resolution === undefined ? {} : { resolution }),
        ...(providerUsage === undefined ? {} : { providerUsage }),
      };
    } finally {
      managedToolSession?.release();
      await modelLease?.release();
      clearInterval(heartbeat);
      input.signal?.removeEventListener('abort', abortFromCaller);
      if (reasoningActive) input.onEvent?.({ type: 'reasoningPresence', active: false });
      if (this.active.get(input.worker.id)?.controller === controller)
        this.active.delete(input.worker.id);
    }
  }

  async stop(agentId: string): Promise<void> {
    const active = this.active.get(agentId);
    if (active === undefined) return this.deps.fallback.stop(agentId);
    active.controller.abort();
    await this.deps.registry.resolve(active.connection).cancel(active.executionId);
    this.active.delete(agentId);
  }

  dispose(): void {
    for (const active of this.active.values()) active.controller.abort();
    this.active.clear();
    const disposable = this.deps.fallback as TeamWorkerRuntime & { dispose?: () => void };
    disposable.dispose?.();
  }
}

function providerCallExecutionId(executionId: string, ordinal: number): string {
  const suffix = `:provider-call:${ordinal}`;
  return `${executionId.slice(0, 256 - suffix.length)}${suffix}`;
}

function mergeProviderUsage(
  current: NormalizedProviderUsage | undefined,
  next: NormalizedProviderUsage,
): NormalizedProviderUsage {
  if (current === undefined) return next;
  return {
    inputTokens: addNullable(current.inputTokens, next.inputTokens),
    outputTokens: addNullable(current.outputTokens, next.outputTokens),
    cacheReadTokens: addNullable(current.cacheReadTokens, next.cacheReadTokens),
    cacheWriteTokens: addNullable(current.cacheWriteTokens, next.cacheWriteTokens),
    reasoningTokens: addNullable(current.reasoningTokens, next.reasoningTokens),
    providerCost:
      current.providerCost !== null &&
      next.providerCost !== null &&
      current.providerCost.currency === next.providerCost.currency
        ? {
            amount: current.providerCost.amount + next.providerCost.amount,
            currency: current.providerCost.currency,
          }
        : (current.providerCost ?? next.providerCost),
    source:
      current.source === 'unknown'
        ? next.source
        : next.source === 'unknown' || current.source === next.source
          ? current.source
          : 'runtime_observed',
  };
}

function addNullable(left: number | null, right: number | null): number | null {
  return left === null && right === null ? null : (left ?? 0) + (right ?? 0);
}

function workerPrompt(
  worker: AgentRecord,
  content: string,
  priorConversation: readonly TeamRuntimeConversationItem[] | undefined,
): string {
  return [
    `あなたはチームの「${worker.role}」担当Workerです。`,
    `あなたのAgent ID: ${worker.id}`,
    `親Agent ID: ${worker.parentAgentId ?? 'Leader'}`,
    worker.objective === null ? '' : `目的: ${worker.objective}`,
    `Context継承: ${worker.contextInheritancePolicy}`,
    'Workspace書き込み: 公式API Workerでは利用不可',
    '以下の依頼を実行し、結果を日本語で簡潔に報告してください。',
    formatPriorTeamConversation(priorConversation),
    '',
    `依頼: ${content}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function formatPriorTeamConversation(
  conversation: readonly TeamRuntimeConversationItem[] | undefined,
): string {
  if (conversation === undefined || conversation.length === 0) return '';
  return [
    '以下は、このAgent自身が以前に受送信したTeam会話です。',
    '現在の依頼を最優先し、過去の成果は参照資料としてそのまま利用してください。',
    'この内容を取得し直すためにTeamツールを呼ぶ必要はありません。',
    ...conversation.map(
      (item) =>
        `[${item.direction === 'received' ? '受信' : '送信'} / ${item.role}]\n${item.content}`,
    ),
  ].join('\n\n');
}

function costCents(usage: NormalizedProviderUsage | undefined): number {
  const cost = usage?.providerCost;
  return cost?.currency === 'USD' ? Math.round(cost.amount * 100) : 0;
}

function tokenCount(
  usage: NormalizedProviderUsage | undefined,
  prompt: string,
  summary: string,
): number {
  if (usage !== undefined && usage.inputTokens !== null && usage.outputTokens !== null)
    return usage.inputTokens + usage.outputTokens;
  return Math.max(1, Math.ceil((prompt.length + summary.length) / 4));
}

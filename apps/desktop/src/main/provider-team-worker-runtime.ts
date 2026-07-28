import type {
  ExecutionResolution,
  NormalizedProviderUsage,
  ProviderConnection,
} from '@sprint-coder/contracts';
import type { TeamEnvelope } from '@sprint-coder/domain';
import { builtinRuntimeForModelSelection } from './connection-identity';
import { ProviderRateLimitedError } from './provider-rate-limit-retry';
import type { ProviderRegistry } from './provider-runtime';
import type { ProviderVerificationService } from './provider-verification';
import type {
  TeamWorkerRuntime,
  WorkerActivityEvent,
  WorkerRuntimeResult,
} from './team-coordinator';
import type { AgentRecord } from './persistence';

export type ProviderTeamWorkerRuntimeDeps = Readonly<{
  fallback: TeamWorkerRuntime;
  verification: ProviderVerificationService;
  registry: ProviderRegistry;
  getConnection(connectionId: string): ProviderConnection;
  authorizeEgress(input: {
    worker: AgentRecord;
    executionId: string;
    providerId: string;
    prompt: string;
  }): boolean;
}>;

type ActiveProviderWorker = {
  executionId: string;
  connection: ProviderConnection;
  controller: AbortController;
};

export class ProviderAwareTeamWorkerRuntime implements TeamWorkerRuntime {
  private readonly active = new Map<string, ActiveProviderWorker>();

  constructor(private readonly deps: ProviderTeamWorkerRuntimeDeps) {}

  start(worker: AgentRecord): Promise<{ pid?: number | null }> {
    return builtinRuntimeForModelSelection(worker.modelSelection) === null
      ? Promise.resolve({ pid: null })
      : this.deps.fallback.start(worker);
  }

  async execute(input: {
    worker: AgentRecord;
    envelope: TeamEnvelope;
    content: string;
    onEvent?: (event: WorkerActivityEvent) => void;
  }): Promise<WorkerRuntimeResult> {
    if (builtinRuntimeForModelSelection(input.worker.modelSelection) !== null)
      return this.deps.fallback.execute(input);
    const connectionId = input.worker.modelSelection.connectionId;
    const modelId = input.worker.modelSelection.requestedModel;
    if (connectionId === null || modelId === null)
      throw new Error('Provider Worker model selection is incomplete');
    const connection = await this.deps.verification.requireVerifiedForExecution(connectionId);
    if (connection.providerId !== input.worker.modelSelection.requestedProvider)
      throw new Error('Provider Worker Connection does not match its requested Provider');
    const executionId = input.envelope.deliveryId;
    const prompt = workerPrompt(input.worker, input.content);
    if (
      !this.deps.authorizeEgress({
        worker: input.worker,
        executionId,
        providerId: connection.providerId,
        prompt,
      })
    )
      throw new Error('Provider Worker egress was denied');

    const controller = new AbortController();
    this.active.set(input.worker.id, { executionId, connection, controller });
    const startedAt = Date.now();
    const output: string[] = [];
    let resolution: ExecutionResolution | undefined;
    let providerUsage: NormalizedProviderUsage | undefined;
    let completed = false;
    let reasoningActive = false;
    input.onEvent?.({ type: 'accepted', at: new Date().toISOString() });
    input.onEvent?.({
      type: 'activity',
      phase: 'executing',
      label: 'Providerで依頼を処理中',
      at: new Date().toISOString(),
    });
    try {
      const runtime = this.deps.registry.resolve(connection);
      for await (const event of runtime.execute(
        connection,
        {
          executionId,
          connectionId,
          modelId,
          messages: [{ role: 'user', content: prompt }],
        },
        controller.signal,
      )) {
        if (event.type === 'output_delta') {
          output.push(event.text);
          input.onEvent?.({ type: 'outputDelta', text: event.text });
        } else if (event.type === 'reasoning_delta') {
          if (!reasoningActive) {
            reasoningActive = true;
            input.onEvent?.({ type: 'reasoningPresence', active: true });
          }
        } else if (event.type === 'resolution') resolution = event.resolution;
        else if (event.type === 'usage') providerUsage = event.usage;
        else if (event.type === 'error') {
          if (event.error.category === 'rate_limited')
            throw new ProviderRateLimitedError(
              event.error.message,
              event.error.retryAfterMs,
            );
          throw new Error(event.error.message);
        } else if (event.type === 'tool_call')
          throw new Error('External API Workers do not receive Team management tools');
        else if (event.type === 'completed') completed = true;
      }
      if (!completed) throw new Error('Provider Worker stream ended without completion');
      if (reasoningActive) {
        input.onEvent?.({ type: 'reasoningPresence', active: false });
        reasoningActive = false;
      }
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
          toolCalls: 0,
        },
        ...(resolution === undefined ? {} : { resolution }),
        ...(providerUsage === undefined ? {} : { providerUsage }),
      };
    } finally {
      if (reasoningActive)
        input.onEvent?.({ type: 'reasoningPresence', active: false });
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

function workerPrompt(worker: AgentRecord, content: string): string {
  return [
    `あなたはチームの「${worker.role}」担当Workerです。`,
    worker.objective === null ? '' : `目的: ${worker.objective}`,
    '以下の依頼を実行し、結果を日本語で簡潔に報告してください。',
    '',
    `依頼: ${content}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
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

import {
  providerExecutionRequestSchema,
  type CanonicalProviderEvent,
  type ProviderConnection,
  type ProviderExecutionRequest,
  type ProviderModel,
} from '@sprint-coder/contracts';
import { openAICompatibleChatCompletionRequest } from './openai-compatible-provider-client';
import { normalizeOpenAIChatCompletionsStream } from './openai-chat-completions-stream';
import type { ManagedLocalController } from './managed-local-controller';
import type { ManagedLocalRuntimeSession } from './managed-local-runtime-supervisor';
import type { ProviderModelLease } from './ollama-model-lifecycle';
import type { ProviderRuntime, ProviderVerificationResult } from './provider-runtime';
import { ProviderStreamBudget } from './provider-stream-budget';

export const MANAGED_LOCAL_CONNECTION_ID = 'managed-local:runtime';
export const MANAGED_LOCAL_PROVIDER_ID = 'sprint-managed-local';

type ActiveSession = {
  session: ManagedLocalRuntimeSession;
  leases: number;
};

/** Adapts the authenticated Main-owned llama.cpp session to the existing Provider Runtime shape.
 * The loopback token and URL never become a Provider credential or cross IPC. */
export class ManagedLocalProviderRuntime implements ProviderRuntime {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly executions = new Map<string, AbortController>();

  constructor(private readonly controller: ManagedLocalController) {}

  async verify(
    _connection: ProviderConnection,
    _signal: AbortSignal,
  ): Promise<ProviderVerificationResult> {
    const now = new Date();
    return {
      status: 'verified',
      verifiedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
      message: null,
    };
  }

  async listModels(
    connection: ProviderConnection,
    _signal: AbortSignal,
  ): Promise<readonly ProviderModel[]> {
    assertManagedConnection(connection);
    return this.controller.listProviderModels(connection.id, connection.providerId);
  }

  async acquireModelLease(
    connection: ProviderConnection,
    modelId: string,
    signal: AbortSignal,
  ): Promise<ProviderModelLease> {
    assertManagedConnection(connection);
    const lease = await this.controller.acquireRuntime(
      modelId,
      connection.automaticModelRelease !== false,
      signal,
    );
    const current = this.sessions.get(modelId);
    if (current !== undefined && current.session !== lease.session) {
      await lease.release();
      throw new Error('Managed Local session identity changed while leased');
    }
    this.sessions.set(modelId, {
      session: lease.session,
      leases: (current?.leases ?? 0) + 1,
    });
    let released = false;
    return Object.freeze({
      prepare: (nextSignal) => lease.prepare(nextSignal),
      release: async () => {
        if (released) return;
        released = true;
        const active = this.sessions.get(modelId);
        if (active !== undefined) {
          if (active.leases <= 1) this.sessions.delete(modelId);
          else this.sessions.set(modelId, { ...active, leases: active.leases - 1 });
        }
        await lease.release();
      },
    });
  }

  async *execute(
    connection: ProviderConnection,
    request: ProviderExecutionRequest,
    signal: AbortSignal,
    budget = new ProviderStreamBudget(),
  ): AsyncIterable<CanonicalProviderEvent> {
    assertManagedConnection(connection);
    const parsed = providerExecutionRequestSchema.parse(request);
    if (parsed.connectionId !== connection.id)
      throw new Error('Managed Local execution Connection changed');
    const active = this.sessions.get(parsed.modelId);
    if (active === undefined) throw new Error('Managed Local execution has no active model lease');
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    this.executions.set(parsed.executionId, controller);
    try {
      const response = await active.session.authenticatedFetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          openAICompatibleChatCompletionRequest(parsed, MANAGED_LOCAL_PROVIDER_ID),
        ),
        signal: controller.signal,
      });
      if (!response.ok || response.body === null) {
        yield {
          type: 'error',
          error: {
            category: response.status === 404 ? 'not_found' : 'provider_unavailable',
            message: 'Managed Local runtime rejected the request',
            retryable: response.status >= 500,
            retryAfterMs: null,
            providerCode: `http_${response.status}`,
          },
        };
        return;
      }
      yield* normalizeOpenAIChatCompletionsStream(
        response.body,
        connection.providerId,
        parsed.modelId,
        budget.beginCall(),
      );
    } catch {
      yield {
        type: 'error',
        error: {
          category: controller.signal.aborted ? 'canceled' : 'network',
          message: controller.signal.aborted
            ? 'Managed Local execution was canceled'
            : 'Managed Local runtime could not be reached',
          retryable: !controller.signal.aborted,
          retryAfterMs: null,
          providerCode: null,
        },
      };
    } finally {
      signal.removeEventListener('abort', abort);
      if (this.executions.get(parsed.executionId) === controller)
        this.executions.delete(parsed.executionId);
    }
  }

  async cancel(executionId: string): Promise<void> {
    this.executions.get(executionId)?.abort();
  }

  async dispose(): Promise<void> {
    for (const controller of this.executions.values()) controller.abort();
    this.executions.clear();
  }
}

export function managedLocalConnection(now = new Date()): ProviderConnection {
  const timestamp = now.toISOString();
  return {
    id: MANAGED_LOCAL_CONNECTION_ID,
    providerId: MANAGED_LOCAL_PROVIDER_ID,
    runtimeKind: 'openai_compatible',
    displayName: 'Managed Local',
    enabled: true,
    automaticModelRelease: true,
    secretReference: null,
    verification: {
      status: 'not_required',
      verifiedAt: null,
      expiresAt: null,
      message: null,
    },
    rateLimit: {
      mode: 'bypass',
      maxConcurrentRequests: 1,
      requestsPerMinute: null,
      tokensPerMinute: null,
      lastObservedRateLimitHeaders: null,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function assertManagedConnection(connection: ProviderConnection): void {
  if (
    connection.id !== MANAGED_LOCAL_CONNECTION_ID ||
    connection.providerId !== MANAGED_LOCAL_PROVIDER_ID ||
    connection.runtimeKind !== 'openai_compatible' ||
    connection.secretReference !== null
  )
    throw new Error('Invalid Managed Local virtual Connection');
}

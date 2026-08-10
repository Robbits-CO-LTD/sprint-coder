import {
  providerExecutionRequestSchema,
  type CanonicalProviderEvent,
  type ProviderConnection,
  type ProviderExecutionRequest,
  type ProviderModel,
  type ProviderRuntimeKind,
} from '@sprint-coder/contracts';
import type { ProviderModelLease } from './ollama-model-lifecycle';

export type ProviderVerificationResult = Readonly<{
  status: 'verified' | 'invalid_credentials' | 'unavailable';
  verifiedAt: string;
  expiresAt: string;
  message: string | null;
}>;

export interface ProviderRuntime {
  verify(connection: ProviderConnection, signal: AbortSignal): Promise<ProviderVerificationResult>;
  listModels(
    connection: ProviderConnection,
    signal: AbortSignal,
  ): Promise<readonly ProviderModel[]>;
  execute(
    connection: ProviderConnection,
    request: ProviderExecutionRequest,
    signal: AbortSignal,
  ): AsyncIterable<CanonicalProviderEvent>;
  cancel(executionId: string): Promise<void>;
  acquireModelLease?(connection: ProviderConnection, modelId: string): Promise<ProviderModelLease>;
  dispose?(): Promise<void>;
}

const NOOP_MODEL_LEASE: ProviderModelLease = Object.freeze({
  release: async () => undefined,
});

export async function acquireProviderModelLease(
  runtime: ProviderRuntime,
  connection: ProviderConnection,
  modelId: string,
): Promise<ProviderModelLease> {
  return runtime.acquireModelLease?.(connection, modelId) ?? NOOP_MODEL_LEASE;
}

export type ProviderRuntimeRegistration = Readonly<{
  runtimeKind: ProviderRuntimeKind;
  providerId: string | null;
  runtime: ProviderRuntime;
}>;

export interface ProviderRegistry {
  register(registration: ProviderRuntimeRegistration): void;
  resolve(connection: ProviderConnection): ProviderRuntime;
}

export class MainProviderRegistry implements ProviderRegistry {
  private readonly registrations = new Map<string, ProviderRuntime>();

  register(registration: ProviderRuntimeRegistration): void {
    const key = registrationKey(registration.runtimeKind, registration.providerId);
    if (this.registrations.has(key))
      throw new Error(`Provider Runtime is already registered for ${key}`);
    this.registrations.set(key, registration.runtime);
  }

  resolve(connection: ProviderConnection): ProviderRuntime {
    const exact = this.registrations.get(
      registrationKey(connection.runtimeKind, connection.providerId),
    );
    if (exact !== undefined) return exact;
    const generic = this.registrations.get(registrationKey(connection.runtimeKind, null));
    if (generic !== undefined) return generic;
    throw new Error(`Provider Runtime is not registered for Connection ${connection.id}`);
  }
}

export class DeterministicMockProviderRuntime implements ProviderRuntime {
  private readonly canceled = new Set<string>();

  async verify(
    _connection: ProviderConnection,
    _signal: AbortSignal,
  ): Promise<ProviderVerificationResult> {
    const verifiedAt = new Date(0).toISOString();
    return {
      status: 'verified',
      verifiedAt,
      expiresAt: new Date(24 * 60 * 60 * 1_000).toISOString(),
      message: null,
    };
  }

  async listModels(
    connection: ProviderConnection,
    _signal: AbortSignal,
  ): Promise<readonly ProviderModel[]> {
    const unknown = { value: null, source: 'unknown' } as const;
    return [
      {
        connectionId: connection.id,
        providerId: connection.providerId,
        modelId: 'mock-model',
        displayName: 'Mock Model',
        available: true,
        availabilityCheckedAt: new Date(0).toISOString(),
        contextWindow: unknown,
        maxOutputTokens: unknown,
        toolCalling: unknown,
        structuredOutput: unknown,
        multimodalInput: unknown,
        reasoning: unknown,
      },
    ];
  }

  async *execute(
    connection: ProviderConnection,
    request: ProviderExecutionRequest,
    signal: AbortSignal,
  ): AsyncIterable<CanonicalProviderEvent> {
    const parsed = providerExecutionRequestSchema.parse(request);
    if (parsed.connectionId !== connection.id)
      throw new Error('Execution Connection does not match the resolved Runtime Connection');
    if (signal.aborted || this.canceled.has(parsed.executionId)) {
      yield {
        type: 'error',
        error: {
          category: 'canceled',
          message: 'Provider execution was canceled',
          retryable: false,
          retryAfterMs: null,
          providerCode: null,
        },
      };
      return;
    }
    const text = parsed.messages.at(-1)?.content ?? '';
    yield { type: 'output_delta', text: `mock:${text}` };
    yield {
      type: 'resolution',
      resolution: { resolvedProvider: connection.providerId, resolvedModel: parsed.modelId },
    };
    yield {
      type: 'usage',
      usage: {
        inputTokens: Math.max(1, Math.ceil(text.length / 4)),
        outputTokens: Math.max(1, Math.ceil((text.length + 5) / 4)),
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        providerCost: null,
        source: 'runtime_observed',
      },
    };
    yield { type: 'completed', stopReason: 'stop' };
  }

  async cancel(executionId: string): Promise<void> {
    this.canceled.add(executionId);
  }
}

function registrationKey(runtimeKind: ProviderRuntimeKind, providerId: string | null): string {
  return `${runtimeKind}:${providerId ?? '*'}`;
}

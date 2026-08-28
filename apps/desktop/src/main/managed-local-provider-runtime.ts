import {
  MANAGED_LOCAL_DEFAULT_MAX_OUTPUT_TOKENS,
  canonicalProviderEventSchema,
  MANAGED_LOCAL_TOOL_MAX_OUTPUT_TOKENS,
  providerExecutionRequestSchema,
  type CanonicalProviderEvent,
  type ProviderConnection,
  type ProviderExecutionRequest,
  type ProviderModel,
} from '@sprint-coder/contracts';
import { digestCanonical } from './context-compiler';
import { openAICompatibleChatCompletionRequest } from './openai-compatible-provider-client';
import { normalizeOpenAIChatCompletionsStream } from './openai-chat-completions-stream';
import type { ManagedLocalController } from './managed-local-controller';
import type { ManagedLocalRuntimeSession } from './managed-local-runtime-supervisor';
import type { ProviderModelLease } from './ollama-model-lifecycle';
import type {
  ProviderImageInputCapabilitySnapshot,
  ProviderRuntime,
  ProviderVerificationResult,
} from './provider-runtime';
import { ProviderStreamBudget } from './provider-stream-budget';
import { secureLogger } from './secure-logger';

export const MANAGED_LOCAL_CONNECTION_ID = 'managed-local:runtime';
export const MANAGED_LOCAL_PROVIDER_ID = 'sprint-managed-local';
const MAX_FORCED_TOOL_RESPONSE_BYTES = 1024 * 1024;

class ManagedLocalProtocolError extends Error {}

type ActiveSession = {
  session: ManagedLocalRuntimeSession;
  leases: number;
};

/** Adapts the authenticated Main-owned llama.cpp session to the existing Provider Runtime shape.
 * The loopback token and URL never become a Provider credential or cross IPC. */
export class ManagedLocalProviderRuntime implements ProviderRuntime {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly executions = new Map<string, AbortController>();

  constructor(
    private readonly controller: ManagedLocalController,
    private readonly now: () => number = Date.now,
  ) {}

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

  async captureImageInputCapability(
    connection: ProviderConnection,
    modelId: string,
    signal: AbortSignal,
  ): Promise<ProviderImageInputCapabilitySnapshot> {
    assertManagedConnection(connection);
    if (signal.aborted) throw signal.reason;
    const value = this.controller.imageInputCapability(modelId);
    return Object.freeze({
      value,
      revision: digestCanonical({
        connectionId: connection.id,
        providerId: connection.providerId,
        modelId,
        value,
        source: 'managed_local_immutable_artifacts_v1',
      }),
      capturedAtMs: this.now(),
    });
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
    const inferenceSettingsView =
      typeof this.controller.getInferenceSettings === 'function'
        ? await this.controller.getInferenceSettings(parsed.modelId)
        : null;
    const inferenceSettings =
      inferenceSettingsView?.configured ??
      ({ maxOutputTokens: MANAGED_LOCAL_DEFAULT_MAX_OUTPUT_TOKENS, thinking: false } as const);
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    this.executions.set(parsed.executionId, controller);
    try {
      const forcedToolName =
        typeof parsed.toolChoice === 'object' ? parsed.toolChoice.name : undefined;
      const compatibleRequest = openAICompatibleChatCompletionRequest(
        forcedToolName === undefined
          ? parsed
          : {
              ...parsed,
              messages: managedLocalForcedToolMessages(parsed.messages, forcedToolName),
              tools: parsed.tools?.filter(({ name }) => name === forcedToolName),
            },
        MANAGED_LOCAL_PROVIDER_ID,
        inferenceSettings,
      );
      const body =
        forcedToolName === undefined
          ? compatibleRequest
          : {
              ...compatibleRequest,
              stream: false,
              stream_options: undefined,
              max_tokens: MANAGED_LOCAL_TOOL_MAX_OUTPUT_TOKENS,
              reasoning_effort: 'none',
              chat_template_kwargs: { enable_thinking: false },
            };
      let response = await active.session.authenticatedFetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const responseBody = response.body;
      if (!response.ok || (forcedToolName === undefined && responseBody === null)) {
        if (!response.ok) {
          if (response.body !== null) void response.body.cancel().catch(() => undefined);
          secureLogger.warn('Managed Local runtime rejected a Provider request', {
            status: response.status,
          });
        }
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
      if (forcedToolName !== undefined) {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            for (const event of await managedLocalForcedToolEvents(response, forcedToolName))
              yield event;
            return;
          } catch (error) {
            if (
              !(error instanceof ManagedLocalProtocolError) ||
              error.message !== 'Managed Local forced tool call is missing' ||
              attempt >= 3
            )
              throw error;
            secureLogger.warn('Managed Local forced tool generation will retry', {
              toolName: forcedToolName,
              attempt,
            });
            response = await active.session.authenticatedFetch('/v1/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal: controller.signal,
            });
            if (!response.ok) {
              if (response.body !== null) void response.body.cancel().catch(() => undefined);
              throw new ManagedLocalProtocolError('Managed Local forced tool retry was rejected');
            }
          }
        }
        throw new ManagedLocalProtocolError('Managed Local forced tool call is missing');
      }
      yield* normalizeOpenAIChatCompletionsStream(
        responseBody!,
        connection.providerId,
        parsed.modelId,
        budget.beginCall(),
      );
    } catch (error) {
      if (error instanceof ManagedLocalProtocolError)
        secureLogger.warn('Managed Local forced tool response was rejected', {
          reason: error.message,
        });
      yield {
        type: 'error',
        error: {
          category: controller.signal.aborted
            ? 'canceled'
            : error instanceof ManagedLocalProtocolError
              ? 'internal'
              : 'network',
          message: controller.signal.aborted
            ? 'Managed Local execution was canceled'
            : error instanceof ManagedLocalProtocolError
              ? error.message
              : 'Managed Local runtime could not be reached',
          retryable: !controller.signal.aborted && !(error instanceof ManagedLocalProtocolError),
          retryAfterMs: null,
          providerCode:
            error instanceof ManagedLocalProtocolError ? 'forced_tool_response_invalid' : null,
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

export function managedLocalForcedToolMessages(
  messages: ProviderExecutionRequest['messages'],
  forcedToolName: string,
): ProviderExecutionRequest['messages'] {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1)
    if (messages[index]?.role === 'user') {
      latestUserIndex = index;
      break;
    }
  if (latestUserIndex < 0)
    throw new ManagedLocalProtocolError('Managed Local forced tool user message is missing');
  const systemContent = [
    `Call exactly ${forcedToolName} now. Extract only that tool's arguments from the latest user request. Do not answer with text and do not perform later steps yet.`,
    ...messages.filter(({ role }) => role === 'system').map(({ content }) => content),
  ].join('\n\n');
  return [{ role: 'system', content: systemContent }, messages[latestUserIndex]!];
}

export async function managedLocalForcedToolEvents(
  response: Response,
  expectedName: string,
): Promise<readonly CanonicalProviderEvent[]> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_FORCED_TOOL_RESPONSE_BYTES)
    throw new ManagedLocalProtocolError('Managed Local forced tool response is too large');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_FORCED_TOOL_RESPONSE_BYTES)
    throw new ManagedLocalProtocolError('Managed Local forced tool response is too large');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ManagedLocalProtocolError('Managed Local forced tool response is invalid');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ManagedLocalProtocolError('Managed Local forced tool response is invalid');
  const choices = (value as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length !== 1)
    throw new ManagedLocalProtocolError('Managed Local forced tool choices are invalid');
  const choice = choices[0];
  if (choice === null || typeof choice !== 'object' || Array.isArray(choice))
    throw new ManagedLocalProtocolError('Managed Local forced tool choice is invalid');
  const message = (choice as Record<string, unknown>).message;
  if (message === null || typeof message !== 'object' || Array.isArray(message))
    throw new ManagedLocalProtocolError('Managed Local forced tool message is invalid');
  const calls = (message as Record<string, unknown>).tool_calls;
  if (!Array.isArray(calls) || calls.length !== 1)
    throw new ManagedLocalProtocolError('Managed Local forced tool call is missing');
  const call = calls[0];
  if (call === null || typeof call !== 'object' || Array.isArray(call))
    throw new ManagedLocalProtocolError('Managed Local forced tool call is invalid');
  const record = call as Record<string, unknown>;
  const fn = record.function;
  if (
    typeof record.id !== 'string' ||
    record.id.length < 1 ||
    fn === null ||
    typeof fn !== 'object' ||
    Array.isArray(fn) ||
    (fn as Record<string, unknown>).name !== expectedName
  )
    throw new ManagedLocalProtocolError('Managed Local forced tool identity is invalid');
  const rawArguments = (fn as Record<string, unknown>).arguments;
  if (typeof rawArguments !== 'string' || rawArguments.length > 64 * 1024)
    throw new ManagedLocalProtocolError('Managed Local forced tool arguments are invalid');
  let input: unknown;
  try {
    input = JSON.parse(rawArguments);
  } catch {
    throw new ManagedLocalProtocolError('Managed Local forced tool arguments are invalid');
  }
  return Object.freeze([
    canonicalProviderEventSchema.parse({
      type: 'tool_call',
      callId: record.id,
      name: expectedName,
      input,
    }),
    canonicalProviderEventSchema.parse({ type: 'completed', stopReason: 'tool_calls' }),
  ]);
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

import {
  providerExecutionRequestSchema,
  type CanonicalProviderEvent,
  type NormalizedProviderError,
  type ProviderConnection,
  type ProviderExecutionRequest,
  type ProviderModel,
  type ProviderProfile,
} from '@sprint-coder/contracts';
import type { ProviderRuntime, ProviderVerificationResult } from './provider-runtime';
import type {
  OpenAICompatibleCredential,
  ProviderProfileRegistry,
} from './provider-profile';
import { resolveProfileBaseUrl } from './provider-profile';
import type { ProviderFetch } from './openai-provider-client';
import { openAICompatibleResponseRequest } from './openai-provider-client';
import { normalizeOpenAIResponsesStream } from './openai-responses-stream';
import { normalizeOpenAIChatCompletionsStream } from './openai-chat-completions-stream';

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1_000;

export type OpenAICompatibleCredentialResolver = (
  connection: ProviderConnection,
) => OpenAICompatibleCredential | Promise<OpenAICompatibleCredential>;

export class OpenAICompatibleProviderClient implements ProviderRuntime {
  private readonly executions = new Map<string, AbortController>();

  constructor(
    private readonly profiles: ProviderProfileRegistry,
    private readonly resolveCredential: OpenAICompatibleCredentialResolver,
    private readonly providerFetch: ProviderFetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async verify(
    connection: ProviderConnection,
    signal: AbortSignal,
  ): Promise<ProviderVerificationResult> {
    const checkedAt = this.now();
    try {
      await this.fetchModels(connection, signal);
      return {
        status: 'verified',
        verifiedAt: checkedAt.toISOString(),
        expiresAt: new Date(checkedAt.getTime() + VERIFICATION_TTL_MS).toISOString(),
        message: null,
      };
    } catch (error) {
      if (error instanceof CompatibleHttpError)
        return {
          status:
            error.status === 401 || error.status === 403
              ? 'invalid_credentials'
              : 'unavailable',
          verifiedAt: checkedAt.toISOString(),
          expiresAt: checkedAt.toISOString(),
          message:
            error.status === 401 || error.status === 403
              ? 'Provider credentials were rejected'
              : 'Provider API is temporarily unavailable',
        };
      if (signal.aborted) throw error;
      return {
        status: 'unavailable',
        verifiedAt: checkedAt.toISOString(),
        expiresAt: checkedAt.toISOString(),
        message: 'Provider API could not be reached',
      };
    }
  }

  async listModels(
    connection: ProviderConnection,
    signal: AbortSignal,
  ): Promise<readonly ProviderModel[]> {
    const response = await this.fetchModels(connection, signal);
    const checkedAt = this.now().toISOString();
    const unknown = { value: null, source: 'unknown' } as const;
    return response.data
      .filter((model) => model.id.length > 0 && model.id.length <= 256)
      .map((model) => ({
        connectionId: connection.id,
        providerId: connection.providerId,
        modelId: model.id,
        displayName: model.id,
        available: true,
        availabilityCheckedAt: checkedAt,
        contextWindow:
          positiveInteger(model.context_window) === null
            ? unknown
            : {
                value: positiveInteger(model.context_window),
                source: 'provider_api' as const,
                observedAt: checkedAt,
              },
        maxOutputTokens:
          positiveInteger(model.max_completion_tokens) === null
            ? unknown
            : {
                value: positiveInteger(model.max_completion_tokens),
                source: 'provider_api' as const,
                observedAt: checkedAt,
              },
        toolCalling: unknown,
        structuredOutput: unknown,
        multimodalInput: unknown,
        reasoning: unknown,
      }));
  }

  async *execute(
    connection: ProviderConnection,
    request: ProviderExecutionRequest,
    signal: AbortSignal,
  ): AsyncIterable<CanonicalProviderEvent> {
    assertCompatibleConnection(connection);
    const parsed = providerExecutionRequestSchema.parse(request);
    if (parsed.connectionId !== connection.id)
      throw new Error('Execution Connection does not match the Provider Profile Connection');
    const profile = this.profiles.get(connection.providerId);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    this.executions.set(parsed.executionId, controller);
    try {
      const path = profile.protocol === 'responses' ? '/responses' : '/chat/completions';
      const body =
        profile.protocol === 'responses'
          ? openAICompatibleResponseRequest(parsed)
          : openAICompatibleChatCompletionRequest(parsed);
      const response = await this.authenticatedFetch(
        connection,
        profile,
        path,
        controller.signal,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) {
        const retryAfterMs = retryAfter(response.headers.get('retry-after'), this.now());
        if (response.status === 429)
          yield { type: 'rate_limit', retryAfterMs, observedAt: this.now().toISOString() };
        yield {
          type: 'error',
          error: normalizeCompatibleHttpError(profile, response.status, retryAfterMs),
        };
        return;
      }
      if (response.body === null) {
        yield {
          type: 'error',
          error: {
            category: 'provider_unavailable',
            message: 'Provider API returned an empty stream',
            retryable: true,
            retryAfterMs: null,
            providerCode: null,
          },
        };
        return;
      }
      if (profile.protocol === 'responses')
        yield* normalizeOpenAIResponsesStream(
          response.body,
          connection.providerId,
          parsed.modelId,
        );
      else
        yield* normalizeOpenAIChatCompletionsStream(
          response.body,
          connection.providerId,
          parsed.modelId,
        );
    } catch {
      yield {
        type: 'error',
        error: {
          category: controller.signal.aborted ? 'canceled' : 'network',
          message: controller.signal.aborted
            ? 'Provider execution was canceled'
            : 'Provider API could not be reached',
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

  private async fetchModels(
    connection: ProviderConnection,
    signal: AbortSignal,
  ): Promise<CompatibleModelList> {
    assertCompatibleConnection(connection);
    const profile = this.profiles.get(connection.providerId);
    const response = await this.authenticatedFetch(
      connection,
      profile,
      profile.modelsPath,
      signal,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
      },
    );
    if (!response.ok) throw new CompatibleHttpError(response.status);
    const value: unknown = await response.json();
    if (!isCompatibleModelList(value))
      throw new Error('OpenAI-compatible model catalog response is invalid');
    return value;
  }

  private async authenticatedFetch(
    connection: ProviderConnection,
    profile: ProviderProfile,
    path: string,
    signal: AbortSignal,
    init: RequestInit,
  ): Promise<Response> {
    const credential = await this.resolveCredential(connection);
    for (const field of profile.requiredCredentialFields)
      if (field === 'account_id' && (credential.accountId?.trim().length ?? 0) === 0)
        throw new Error(`Provider Profile ${profile.id} requires an account ID`);
    const headers = new Headers(init.headers);
    const prefix =
      profile.authentication.scheme.length === 0
        ? ''
        : `${profile.authentication.scheme} `;
    headers.set(profile.authentication.headerName, `${prefix}${credential.apiKey}`);
    const baseUrl = resolveProfileBaseUrl(profile, credential);
    return this.providerFetch(`${baseUrl}${path}`, { ...init, headers, signal });
  }
}

type CompatibleModelList = Readonly<{
  data: readonly Readonly<{
    id: string;
    context_window?: number;
    max_completion_tokens?: number;
  }>[];
}>;

function isCompatibleModelList(value: unknown): value is CompatibleModelList {
  if (value === null || typeof value !== 'object') return false;
  const data = (value as Record<string, unknown>).data;
  return (
    Array.isArray(data) &&
    data.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        typeof (item as Record<string, unknown>).id === 'string',
    )
  );
}

export function openAICompatibleChatCompletionRequest(
  request: ProviderExecutionRequest,
): Record<string, unknown> {
  return {
    model: request.modelId,
    stream: true,
    stream_options: { include_usage: true },
    messages: request.messages.map((message) => ({
      role: message.role,
      content:
        message.inlineImages === undefined || message.inlineImages.length === 0
          ? message.content
          : [
              { type: 'text', text: message.content },
              ...message.inlineImages.map((image) => ({
                type: 'image_url',
                image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
              })),
            ],
      ...(message.role === 'tool' ? { tool_call_id: message.toolCallId } : {}),
    })),
    ...(request.tools === undefined
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        }),
    ...(request.structuredOutput === undefined
      ? {}
      : {
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: request.structuredOutput.name,
              schema: request.structuredOutput.schema,
              strict: request.structuredOutput.strict,
            },
          },
        }),
  };
}

function normalizeCompatibleHttpError(
  profile: ProviderProfile,
  status: number,
  retryAfterMs: number | null,
): NormalizedProviderError {
  const override = profile.errorOverrides.find((candidate) => candidate.status === status);
  if (override !== undefined)
    return {
      category: override.category,
      message: 'Provider API rejected the request',
      retryable: override.retryable,
      retryAfterMs: override.category === 'rate_limited' ? retryAfterMs : null,
      providerCode: `http_${status}`,
    };
  if (status === 401 || status === 403)
    return {
      category: 'credentials',
      message: 'Provider credentials were rejected',
      retryable: false,
      retryAfterMs: null,
      providerCode: `http_${status}`,
    };
  if (status === 404)
    return {
      category: 'not_found',
      message: 'The requested Provider model or resource was not found',
      retryable: false,
      retryAfterMs: null,
      providerCode: 'http_404',
    };
  if (status === 429)
    return {
      category: 'rate_limited',
      message: 'Provider API rate limit reached',
      retryable: true,
      retryAfterMs,
      providerCode: 'http_429',
    };
  if (status === 408)
    return {
      category: 'timeout',
      message: 'Provider API request timed out',
      retryable: true,
      retryAfterMs: null,
      providerCode: 'http_408',
    };
  return {
    category: status >= 500 ? 'provider_unavailable' : 'invalid_request',
    message:
      status >= 500
        ? 'Provider API is temporarily unavailable'
        : 'Provider API rejected the request',
    retryable: status >= 500,
    retryAfterMs: null,
    providerCode: `http_${status}`,
  };
}

function retryAfter(value: string | null, now: Date): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now.getTime()) : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function assertCompatibleConnection(connection: ProviderConnection): void {
  if (connection.runtimeKind !== 'openai_compatible')
    throw new Error('OpenAI-compatible client requires a Provider Profile Connection');
}

class CompatibleHttpError extends Error {
  constructor(readonly status: number) {
    super(`OpenAI-compatible API request failed with HTTP ${status}`);
  }
}

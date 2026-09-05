import { secureProviderFetch } from './provider-endpoint-policy';
import {
  providerExecutionRequestSchema,
  type CanonicalProviderEvent,
  type NormalizedProviderError,
  type ProviderConnection,
  type ProviderExecutionRequest,
  type ProviderModel,
} from '@sprint-coder/contracts';
import type { ProviderRuntime, ProviderVerificationResult } from './provider-runtime';
import type { ProviderFetch } from './openai-provider-client';
import { normalizeAnthropicMessagesStream } from './anthropic-messages-stream';
import { ProviderQuotaExceededError, ProviderStreamBudget } from './provider-stream-budget';

const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_API_VERSION = '2023-06-01';
const MODELS_SOURCE = 'https://platform.claude.com/docs/en/api/models/list';
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1_000;

export type AnthropicCredential = Readonly<{ apiKey: string }>;
export type AnthropicCredentialResolver = (
  connection: ProviderConnection,
) => AnthropicCredential | Promise<AnthropicCredential>;

type AnthropicModel = Readonly<{
  id: string;
  display_name?: string;
  max_input_tokens?: number;
  max_tokens?: number;
  capabilities?: Readonly<{
    image_input?: Readonly<{ supported?: boolean }>;
    structured_outputs?: Readonly<{ supported?: boolean }>;
    thinking?: Readonly<{ supported?: boolean }>;
  }>;
}>;

export function serializeAnthropicCredential(credential: AnthropicCredential): string {
  if (credential.apiKey.trim().length === 0) throw new Error('Anthropic API key is missing');
  return JSON.stringify(credential);
}

export function parseAnthropicCredential(value: string): AnthropicCredential {
  const parsed: unknown = JSON.parse(value);
  const record = object(parsed);
  if (typeof record?.apiKey !== 'string' || record.apiKey.trim().length === 0)
    throw new Error('Anthropic API key is missing');
  return { apiKey: record.apiKey };
}

export class AnthropicProviderClient implements ProviderRuntime {
  private readonly executions = new Map<string, AbortController>();

  constructor(
    private readonly resolveCredential: AnthropicCredentialResolver,
    private readonly providerFetch: ProviderFetch = secureProviderFetch,
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
      if (signal.aborted) throw error;
      const status = error instanceof AnthropicHttpError ? error.status : null;
      return {
        status: status === 401 ? 'invalid_credentials' : 'unavailable',
        verifiedAt: checkedAt.toISOString(),
        expiresAt: checkedAt.toISOString(),
        message:
          status === 401
            ? 'Anthropic API credentials were rejected'
            : status === 403
              ? 'Anthropic API key does not have permission to list models'
              : 'Anthropic API is temporarily unavailable',
      };
    }
  }

  async listModels(
    connection: ProviderConnection,
    signal: AbortSignal,
  ): Promise<readonly ProviderModel[]> {
    const models = await this.fetchModels(connection, signal);
    const observedAt = this.now().toISOString();
    const providerValue = <T>(value: T | null) =>
      ({
        value,
        source: 'provider_api',
        sourceReference: MODELS_SOURCE,
        observedAt,
      }) as const;
    const unknown = { value: null, source: 'unknown' } as const;
    return models.map((model) => ({
      connectionId: connection.id,
      providerId: 'anthropic',
      modelId: model.id,
      displayName: model.display_name?.trim() || model.id,
      available: true,
      availabilityCheckedAt: observedAt,
      contextWindow: providerValue(positiveInteger(model.max_input_tokens)),
      maxOutputTokens: providerValue(positiveInteger(model.max_tokens)),
      toolCalling: unknown,
      structuredOutput: capability(model.capabilities?.structured_outputs, observedAt),
      multimodalInput: capability(model.capabilities?.image_input, observedAt),
      reasoning: capability(model.capabilities?.thinking, observedAt),
    }));
  }

  async *execute(
    connection: ProviderConnection,
    request: ProviderExecutionRequest,
    signal: AbortSignal,
    budget = new ProviderStreamBudget(),
  ): AsyncIterable<CanonicalProviderEvent> {
    assertAnthropicConnection(connection);
    const parsed = providerExecutionRequestSchema.parse(request);
    if (parsed.connectionId !== connection.id)
      throw new Error('Execution Connection does not match the Anthropic API Connection');
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abort, { once: true });
    this.executions.set(parsed.executionId, controller);
    try {
      controller.signal.throwIfAborted();
      const response = await this.authenticatedFetch(connection, '/messages', controller.signal, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(anthropicMessageRequest(parsed)),
      });
      if (!response.ok) {
        const retryAfterMs = retryAfter(response.headers.get('retry-after'), this.now());
        if (response.status === 429)
          yield {
            type: 'rate_limit',
            retryAfterMs,
            observedAt: this.now().toISOString(),
          };
        yield {
          type: 'error',
          error: normalizeHttpError(response.status, retryAfterMs),
        };
        return;
      }
      if (response.body === null) {
        yield {
          type: 'error',
          error: {
            category: 'provider_unavailable',
            message: 'Anthropic API returned an empty stream',
            retryable: true,
            retryAfterMs: null,
            providerCode: null,
          },
        };
        return;
      }
      yield* normalizeAnthropicMessagesStream(response.body, parsed.modelId, budget.beginCall());
    } catch (error) {
      if (error instanceof ProviderQuotaExceededError) {
        controller.abort();
        throw error;
      }
      yield {
        type: 'error',
        error: {
          category: controller.signal.aborted ? 'canceled' : 'network',
          message: controller.signal.aborted
            ? 'Anthropic execution was canceled'
            : 'Anthropic API could not be reached',
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
  ): Promise<readonly AnthropicModel[]> {
    assertAnthropicConnection(connection);
    const models: AnthropicModel[] = [];
    let afterId: string | null = null;
    do {
      const query =
        afterId === null ? '?limit=1000' : `?limit=1000&after_id=${encodeURIComponent(afterId)}`;
      const response = await this.authenticatedFetch(connection, `/models${query}`, signal, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new AnthropicHttpError(response.status);
      const value: unknown = await response.json();
      const page = object(value);
      if (page === null || !Array.isArray(page.data))
        throw new Error('Anthropic model catalog response is invalid');
      models.push(...page.data.filter(isAnthropicModel));
      if (page.has_more === true) {
        if (typeof page.last_id !== 'string' || page.last_id === afterId)
          throw new Error('Anthropic model catalog pagination is invalid');
        afterId = page.last_id;
      } else afterId = null;
    } while (afterId !== null);
    return models;
  }

  private async authenticatedFetch(
    connection: ProviderConnection,
    path: string,
    signal: AbortSignal,
    init: RequestInit,
  ): Promise<Response> {
    assertAnthropicConnection(connection);
    const credential = await this.resolveCredential(connection);
    const headers = new Headers(init.headers);
    headers.set('x-api-key', credential.apiKey);
    headers.set('anthropic-version', ANTHROPIC_API_VERSION);
    return this.providerFetch(`${ANTHROPIC_API_BASE_URL}${path}`, {
      ...init,
      headers,
      signal,
    });
  }
}

class AnthropicHttpError extends Error {
  constructor(readonly status: number) {
    super(`Anthropic API request failed with HTTP ${status}`);
  }
}

function anthropicMessageRequest(request: ProviderExecutionRequest): Record<string, unknown> {
  const system = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  return {
    model: request.modelId,
    max_tokens: 4_096,
    stream: true,
    ...(system === '' ? {} : { system }),
    messages: request.messages
      .filter((message) => message.role !== 'system')
      .map((message) =>
        message.role === 'tool'
          ? {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: message.toolCallId,
                  content: message.content,
                },
              ],
            }
          : {
              role: message.role,
              content:
                message.role === 'assistant' &&
                message.toolCalls !== undefined &&
                message.toolCalls.length > 0
                  ? [
                      ...(message.content === '' ? [] : [{ type: 'text', text: message.content }]),
                      ...message.toolCalls.map((toolCall) => ({
                        type: 'tool_use',
                        id: toolCall.callId,
                        name: toolCall.name,
                        input: toolCall.input,
                      })),
                    ]
                  : message.inlineImages === undefined || message.inlineImages.length === 0
                    ? message.content
                    : [
                        { type: 'text', text: message.content },
                        ...message.inlineImages.map((image) => ({
                          type: 'image',
                          source: {
                            type: 'base64',
                            media_type: image.mimeType,
                            data: image.base64,
                          },
                        })),
                      ],
            },
      ),
    ...(request.tools === undefined
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
            strict: true,
          })),
        }),
    ...(request.structuredOutput === undefined
      ? {}
      : {
          output_config: {
            format: {
              type: 'json_schema',
              schema: request.structuredOutput.schema,
            },
          },
        }),
  };
}

function normalizeHttpError(status: number, retryAfterMs: number | null): NormalizedProviderError {
  if (status === 401)
    return error('credentials', 'Anthropic API credentials were rejected', false, status);
  if (status === 403)
    return error('invalid_request', 'Anthropic API permission denied', false, status);
  if (status === 404) return error('not_found', 'Anthropic model was not found', false, status);
  if (status === 429)
    return {
      ...error('rate_limited', 'Anthropic rate limit reached', true, status),
      retryAfterMs,
    };
  if (status === 504) return error('timeout', 'Anthropic request timed out', true, status);
  if (status >= 500)
    return error('provider_unavailable', 'Anthropic API is temporarily unavailable', true, status);
  return error('invalid_request', 'Anthropic API rejected the request', false, status);
}

function error(
  category: NormalizedProviderError['category'],
  message: string,
  retryable: boolean,
  status: number,
): NormalizedProviderError {
  return {
    category,
    message,
    retryable,
    retryAfterMs: null,
    providerCode: `http_${status}`,
  };
}

function capability(
  value: Readonly<{ supported?: boolean }> | undefined,
  observedAt: string,
): ProviderModel['reasoning'] {
  return typeof value?.supported === 'boolean'
    ? {
        value: value.supported,
        source: 'provider_api',
        sourceReference: MODELS_SOURCE,
        observedAt,
      }
    : { value: null, source: 'unknown' };
}

function isAnthropicModel(value: unknown): value is AnthropicModel {
  const record = object(value);
  return typeof record?.id === 'string' && record.id.length > 0 && record.id.length <= 256;
}

function assertAnthropicConnection(connection: ProviderConnection): void {
  if (connection.runtimeKind !== 'official_api' || connection.providerId !== 'anthropic')
    throw new Error('Anthropic Provider client requires an official Anthropic API Connection');
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function retryAfter(value: string | null, now: Date): number | null {
  if (value === null || value.trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now.getTime()) : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

import {
  providerExecutionRequestSchema,
  type CanonicalProviderEvent,
  type NormalizedProviderError,
  type ProviderConnection,
  type ProviderExecutionRequest,
  type ProviderModel,
} from '@sprint-coder/contracts';
import type { ProviderRuntime, ProviderVerificationResult } from './provider-runtime';
import type { OpenAICredentialResolver, ProviderFetch } from './openai-provider-client';
import { normalizeOpenRouterResponsesStream } from './openrouter-responses-stream';
import { ProviderQuotaExceededError, ProviderStreamBudget } from './provider-stream-budget';

const OPENROUTER_API_BASE_URL = 'https://openrouter.ai/api/v1';
const MODELS_SOURCE = 'https://openrouter.ai/docs/api/api-reference/models/get-models';
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1_000;

type OpenRouterModel = Readonly<{
  id: string;
  name?: string;
  context_length?: number | null;
  supported_parameters?: readonly string[] | null;
  architecture?: Readonly<{ input_modalities?: readonly string[] | null }> | null;
  top_provider?: Readonly<{ max_completion_tokens?: number | null }> | null;
  pricing?: Readonly<{ prompt?: string | null; completion?: string | null }> | null;
}>;

export class OpenRouterCatalogClient implements ProviderRuntime {
  private readonly executions = new Map<string, AbortController>();

  constructor(
    private readonly resolveCredential: OpenAICredentialResolver,
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
      const status = error instanceof OpenRouterHttpError ? error.status : null;
      return {
        status: status === 401 || status === 403 ? 'invalid_credentials' : 'unavailable',
        verifiedAt: checkedAt.toISOString(),
        expiresAt: checkedAt.toISOString(),
        message:
          status === 401 || status === 403
            ? 'OpenRouter API credentials were rejected'
            : 'OpenRouter API is temporarily unavailable',
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
    return models.map((model) => {
      const parameters = new Set(model.supported_parameters ?? []);
      const modalities = new Set(model.architecture?.input_modalities ?? []);
      return {
        connectionId: connection.id,
        providerId: connection.providerId,
        providerDisplayName: 'OpenRouter',
        modelAuthor: providerValue(openRouterModelAuthor(model.id)),
        modelId: model.id,
        displayName: model.name?.trim() || model.id,
        available: true,
        availabilityCheckedAt: observedAt,
        contextWindow: providerValue(positiveInteger(model.context_length)),
        maxOutputTokens: providerValue(positiveInteger(model.top_provider?.max_completion_tokens)),
        toolCalling: providerValue(parameters.has('tools') || parameters.has('tool_choice')),
        structuredOutput: providerValue(
          parameters.has('response_format') || parameters.has('structured_outputs'),
        ),
        multimodalInput: providerValue([...modalities].some((modality) => modality !== 'text')),
        reasoning: providerValue(parameters.has('reasoning')),
        gateway: {
          providerId: 'openrouter',
          upstreamProvider: {
            value: null,
            source: 'unknown',
          },
        },
        pricing: {
          promptPerToken: providerValue(nonEmpty(model.pricing?.prompt)),
          completionPerToken: providerValue(nonEmpty(model.pricing?.completion)),
          currency: 'USD',
        },
      };
    });
  }

  async *execute(
    connection: ProviderConnection,
    request: ProviderExecutionRequest,
    signal: AbortSignal,
    budget = new ProviderStreamBudget(),
  ): AsyncIterable<CanonicalProviderEvent> {
    assertOpenRouterConnection(connection);
    const parsed = providerExecutionRequestSchema.parse(request);
    if (parsed.connectionId !== connection.id)
      throw new Error('Execution Connection does not match the OpenRouter Connection');
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abort, { once: true });
    this.executions.set(parsed.executionId, controller);
    try {
      controller.signal.throwIfAborted();
      const response = await this.authenticatedFetch(connection, '/responses', controller.signal, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-OpenRouter-Metadata': 'enabled',
        },
        body: JSON.stringify(responseRequest(parsed)),
      });
      if (!response.ok) {
        const retryAfterMs = retryAfter(response.headers.get('retry-after'), this.now());
        if (response.status === 429)
          yield { type: 'rate_limit', retryAfterMs, observedAt: this.now().toISOString() };
        yield { type: 'error', error: httpError(response.status, retryAfterMs) };
        return;
      }
      if (response.body === null) {
        yield {
          type: 'error',
          error: {
            category: 'provider_unavailable',
            message: 'OpenRouter returned an empty stream',
            retryable: true,
            retryAfterMs: null,
            providerCode: null,
          },
        };
        return;
      }
      yield* normalizeOpenRouterResponsesStream(response.body, parsed.modelId, budget.beginCall());
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
            ? 'OpenRouter execution was canceled'
            : 'OpenRouter could not be reached',
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
  ): Promise<readonly OpenRouterModel[]> {
    const response = await this.authenticatedFetch(connection, '/models', signal, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new OpenRouterHttpError(response.status);
    const value: unknown = await response.json();
    if (
      value === null ||
      typeof value !== 'object' ||
      !Array.isArray((value as { data?: unknown }).data)
    )
      throw new Error('OpenRouter model catalog response is invalid');
    return (value as { data: unknown[] }).data.filter(isOpenRouterModel);
  }

  private async authenticatedFetch(
    connection: ProviderConnection,
    path: string,
    signal: AbortSignal,
    init: RequestInit,
  ): Promise<Response> {
    assertOpenRouterConnection(connection);
    const credential = await this.resolveCredential(connection);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${credential.apiKey}`);
    headers.set('X-OpenRouter-Title', 'Sprint Coder');
    return this.providerFetch(`${OPENROUTER_API_BASE_URL}${path}`, {
      ...init,
      headers,
      signal,
    });
  }
}

class OpenRouterHttpError extends Error {
  constructor(readonly status: number) {
    super(`OpenRouter API request failed with HTTP ${status}`);
  }
}

function isOpenRouterModel(value: unknown): value is OpenRouterModel {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>).id === 'string' &&
    ((value as Record<string, unknown>).id as string).length > 0 &&
    ((value as Record<string, unknown>).id as string).length <= 256
  );
}

function positiveInteger(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function openRouterModelAuthor(modelId: string): string | null {
  const separator = modelId.indexOf('/');
  if (separator <= 0) return null;
  const author = modelId.slice(0, separator).replace(/^~/, '');
  return author.length > 0 ? author : null;
}

function assertOpenRouterConnection(connection: ProviderConnection): void {
  if (connection.runtimeKind !== 'official_api' || connection.providerId !== 'openrouter')
    throw new Error('OpenRouter client requires an official OpenRouter Connection');
}

function responseRequest(request: ProviderExecutionRequest): Record<string, unknown> {
  const tools = [
    ...(request.tools ?? []).map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: true,
    })),
    ...(request.webSearch === true ? [{ type: 'openrouter:web_search' }] : []),
  ];
  return {
    model: request.modelId,
    stream: true,
    store: false,
    input: request.messages.flatMap((message) => {
      if (message.role === 'tool')
        return [
          {
            type: 'function_call_output',
            call_id: message.toolCallId,
            output: message.content,
          },
        ];
      const items: Record<string, unknown>[] = [];
      if (message.content !== '' || (message.toolCalls?.length ?? 0) === 0)
        items.push({
          role: message.role,
          content:
            message.inlineImages === undefined || message.inlineImages.length === 0
              ? message.content
              : [
                  { type: 'input_text', text: message.content },
                  ...message.inlineImages.map((image) => ({
                    type: 'input_image',
                    image_url: `data:${image.mimeType};base64,${image.base64}`,
                  })),
                ],
        });
      for (const toolCall of message.toolCalls ?? [])
        items.push({
          type: 'function_call',
          call_id: toolCall.callId,
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.input),
        });
      return items;
    }),
    ...(tools.length === 0 ? {} : { tools }),
    ...(request.structuredOutput === undefined
      ? {}
      : {
          text: {
            format: {
              type: 'json_schema',
              name: request.structuredOutput.name,
              schema: request.structuredOutput.schema,
              strict: request.structuredOutput.strict,
            },
          },
        }),
  };
}

function httpError(status: number, retryAfterMs: number | null): NormalizedProviderError {
  if (status === 401)
    return {
      category: 'credentials',
      message: 'OpenRouter credentials were rejected',
      retryable: false,
      retryAfterMs: null,
      providerCode: 'http_401',
    };
  if (status === 403)
    return {
      category: 'invalid_request',
      message: 'OpenRouter policy rejected the request',
      retryable: false,
      retryAfterMs: null,
      providerCode: 'http_403',
    };
  if (status === 404)
    return {
      category: 'not_found',
      message: 'OpenRouter could not route the requested model',
      retryable: false,
      retryAfterMs: null,
      providerCode: 'http_404',
    };
  if (status === 429)
    return {
      category: 'rate_limited',
      message: 'OpenRouter rate limit reached',
      retryable: true,
      retryAfterMs,
      providerCode: 'http_429',
    };
  return {
    category: status >= 500 ? 'provider_unavailable' : 'invalid_request',
    message:
      status >= 500 ? 'OpenRouter is temporarily unavailable' : 'OpenRouter rejected the request',
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

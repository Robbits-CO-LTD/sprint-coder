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
import { normalizeGeminiContentStream } from './gemini-content-stream';
import { ProviderQuotaExceededError, ProviderStreamBudget } from './provider-stream-budget';

const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const MODELS_SOURCE = 'https://ai.google.dev/api/models';
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1_000;

export type GeminiCredential = Readonly<{ apiKey: string }>;
export type GeminiCredentialResolver = (
  connection: ProviderConnection,
) => GeminiCredential | Promise<GeminiCredential>;

type GeminiModel = Readonly<{
  name: string;
  baseModelId?: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: readonly string[];
  thinking?: boolean;
}>;

export function serializeGeminiCredential(credential: GeminiCredential): string {
  if (credential.apiKey.trim().length === 0) throw new Error('Gemini API key is missing');
  return JSON.stringify(credential);
}

export function parseGeminiCredential(value: string): GeminiCredential {
  const parsed: unknown = JSON.parse(value);
  const record = object(parsed);
  if (typeof record?.apiKey !== 'string' || record.apiKey.trim().length === 0)
    throw new Error('Gemini API key is missing');
  return { apiKey: record.apiKey };
}

export class GeminiProviderClient implements ProviderRuntime {
  private readonly executions = new Map<string, AbortController>();

  constructor(
    private readonly resolveCredential: GeminiCredentialResolver,
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
      if (signal.aborted) throw error;
      const status = error instanceof GeminiHttpError ? error.status : null;
      return {
        status: status === 401 || status === 403 ? 'invalid_credentials' : 'unavailable',
        verifiedAt: checkedAt.toISOString(),
        expiresAt: checkedAt.toISOString(),
        message:
          status === 401 || status === 403
            ? 'Gemini API credentials were rejected'
            : 'Gemini API is temporarily unavailable',
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
    return models.map((model) => {
      const modelId = model.baseModelId?.trim() || stripModelPrefix(model.name);
      return {
        connectionId: connection.id,
        providerId: 'google',
        modelId,
        displayName: model.displayName?.trim() || modelId,
        available: model.supportedGenerationMethods?.includes('generateContent') ?? false,
        availabilityCheckedAt: observedAt,
        contextWindow: providerValue(positiveInteger(model.inputTokenLimit)),
        maxOutputTokens: providerValue(positiveInteger(model.outputTokenLimit)),
        toolCalling: unknown,
        structuredOutput: unknown,
        multimodalInput: unknown,
        reasoning: typeof model.thinking === 'boolean' ? providerValue(model.thinking) : unknown,
      };
    });
  }

  async *execute(
    connection: ProviderConnection,
    request: ProviderExecutionRequest,
    signal: AbortSignal,
    budget = new ProviderStreamBudget(),
  ): AsyncIterable<CanonicalProviderEvent> {
    assertGeminiConnection(connection);
    const parsed = providerExecutionRequestSchema.parse(request);
    if (parsed.connectionId !== connection.id)
      throw new Error('Execution Connection does not match the Gemini API Connection');
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    this.executions.set(parsed.executionId, controller);
    try {
      const response = await this.authenticatedFetch(
        connection,
        `/models/${encodeURIComponent(parsed.modelId)}:streamGenerateContent?alt=sse`,
        controller.signal,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify(geminiGenerateRequest(parsed)),
        },
      );
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
            message: 'Gemini API returned an empty stream',
            retryable: true,
            retryAfterMs: null,
            providerCode: null,
          },
        };
        return;
      }
      yield* normalizeGeminiContentStream(
        response.body,
        parsed.modelId,
        parsed.executionId,
        budget.beginCall(),
      );
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
            ? 'Gemini execution was canceled'
            : 'Gemini API could not be reached',
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
  ): Promise<readonly GeminiModel[]> {
    assertGeminiConnection(connection);
    const models: GeminiModel[] = [];
    let pageToken: string | null = null;
    do {
      const query =
        pageToken === null
          ? '?pageSize=1000'
          : `?pageSize=1000&pageToken=${encodeURIComponent(pageToken)}`;
      const response = await this.authenticatedFetch(connection, `/models${query}`, signal, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new GeminiHttpError(response.status);
      const value: unknown = await response.json();
      const page = object(value);
      if (page === null || !Array.isArray(page.models))
        throw new Error('Gemini model catalog response is invalid');
      models.push(...page.models.filter(isGeminiModel));
      const next =
        typeof page.nextPageToken === 'string' && page.nextPageToken !== ''
          ? page.nextPageToken
          : null;
      if (next !== null && next === pageToken)
        throw new Error('Gemini model catalog pagination is invalid');
      pageToken = next;
    } while (pageToken !== null);
    return models;
  }

  private async authenticatedFetch(
    connection: ProviderConnection,
    path: string,
    signal: AbortSignal,
    init: RequestInit,
  ): Promise<Response> {
    assertGeminiConnection(connection);
    const credential = await this.resolveCredential(connection);
    const headers = new Headers(init.headers);
    headers.set('x-goog-api-key', credential.apiKey);
    return this.providerFetch(`${GEMINI_API_BASE_URL}${path}`, {
      ...init,
      headers,
      signal,
    });
  }
}

class GeminiHttpError extends Error {
  constructor(readonly status: number) {
    super(`Gemini API request failed with HTTP ${status}`);
  }
}

function geminiGenerateRequest(request: ProviderExecutionRequest): Record<string, unknown> {
  const system = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const toolCallMetadata = new Map(
    request.messages.flatMap((message) =>
      (message.toolCalls ?? []).map(
        (toolCall) => [toolCall.callId, toolCall.providerMetadata] as const,
      ),
    ),
  );
  return {
    ...(system === '' ? {} : { systemInstruction: { parts: [{ text: system }] } }),
    contents: request.messages
      .filter((message) => message.role !== 'system')
      .map((message) =>
        message.role === 'tool'
          ? {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    ...(toolCallMetadata.get(message.toolCallId ?? '')?.geminiCallIdPresent ===
                    false
                      ? {}
                      : { id: message.toolCallId }),
                    name: message.toolName ?? message.toolCallId,
                    response: { output: message.content },
                  },
                },
              ],
            }
          : {
              role: message.role === 'assistant' ? 'model' : 'user',
              parts: [
                ...(message.content === '' ? [] : [{ text: message.content }]),
                ...(message.toolCalls ?? []).map((toolCall) => ({
                  functionCall: {
                    ...(toolCall.providerMetadata?.geminiCallIdPresent === false
                      ? {}
                      : { id: toolCall.callId }),
                    name: toolCall.name,
                    args: toolCall.input,
                  },
                  ...(toolCall.providerMetadata?.geminiThoughtSignature === undefined
                    ? {}
                    : {
                        thoughtSignature: toolCall.providerMetadata.geminiThoughtSignature,
                      }),
                })),
                ...(message.inlineImages ?? []).map((image) => ({
                  inlineData: {
                    mimeType: image.mimeType,
                    data: image.base64,
                  },
                })),
              ],
            },
      ),
    ...(request.tools === undefined
      ? {}
      : {
          tools: [
            {
              functionDeclarations: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              })),
            },
          ],
        }),
    ...(request.structuredOutput === undefined
      ? {}
      : {
          generationConfig: {
            responseMimeType: 'application/json',
            responseJsonSchema: request.structuredOutput.schema,
          },
        }),
  };
}

function normalizeHttpError(status: number, retryAfterMs: number | null): NormalizedProviderError {
  if (status === 401)
    return error('credentials', 'Gemini API credentials were rejected', false, status);
  if (status === 403)
    return error('invalid_request', 'Gemini API permission denied', false, status);
  if (status === 404) return error('not_found', 'Gemini model was not found', false, status);
  if (status === 429)
    return {
      ...error('rate_limited', 'Gemini rate limit reached', true, status),
      retryAfterMs,
    };
  if (status === 499) return error('canceled', 'Gemini request was canceled', false, status);
  if (status === 504) return error('timeout', 'Gemini request timed out', true, status);
  if (status >= 500)
    return error('provider_unavailable', 'Gemini API is temporarily unavailable', true, status);
  return error('invalid_request', 'Gemini API rejected the request', false, status);
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

function isGeminiModel(value: unknown): value is GeminiModel {
  const record = object(value);
  return typeof record?.name === 'string' && record.name.length > 0 && record.name.length <= 512;
}

function assertGeminiConnection(connection: ProviderConnection): void {
  if (connection.runtimeKind !== 'official_api' || connection.providerId !== 'google')
    throw new Error('Gemini Provider client requires an official Google Gemini API Connection');
}

function stripModelPrefix(value: string): string {
  return value.startsWith('models/') ? value.slice('models/'.length) : value;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function retryAfter(value: string | null, now: Date): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now.getTime()) : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

import {
  providerExecutionRequestSchema,
  type CanonicalProviderEvent,
  type NormalizedProviderError,
  type ProviderConnection,
  type ProviderExecutionRequest,
  type ProviderModel,
} from '@sprint-coder/contracts';
import type { ProviderRuntime, ProviderVerificationResult } from './provider-runtime';
import { openAICompatibleResponseRequest, type ProviderFetch } from './openai-provider-client';
import { normalizeOpenAIResponsesStream } from './openai-responses-stream';
import { ProviderQuotaExceededError, ProviderStreamBudget } from './provider-stream-budget';

const XAI_API_BASE_URL = 'https://api.x.ai/v1';
const MODELS_SOURCE = 'https://docs.x.ai/developers/rest-api-reference/inference/models';
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1_000;
const XAI_COST_TICKS_PER_USD = 10_000_000_000;

export type XAICredential = Readonly<{ apiKey: string }>;
export type XAICredentialResolver = (
  connection: ProviderConnection,
) => XAICredential | Promise<XAICredential>;

type XAIModel = Readonly<{
  id: string;
  context_length?: number;
}>;

type XAILanguageModel = Readonly<{
  id: string;
  input_modalities?: readonly string[];
  output_modalities?: readonly string[];
  prompt_text_token_price?: number;
  completion_text_token_price?: number;
}>;

export function serializeXAICredential(credential: XAICredential): string {
  if (credential.apiKey.trim().length === 0) throw new Error('xAI API key is missing');
  return JSON.stringify(credential);
}

export function parseXAICredential(value: string): XAICredential {
  const parsed: unknown = JSON.parse(value);
  const record = object(parsed);
  if (typeof record?.apiKey !== 'string' || record.apiKey.trim().length === 0)
    throw new Error('xAI API key is missing');
  return { apiKey: record.apiKey };
}

export class XAIProviderClient implements ProviderRuntime {
  private readonly executions = new Map<string, AbortController>();

  constructor(
    private readonly resolveCredential: XAICredentialResolver,
    private readonly providerFetch: ProviderFetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async verify(
    connection: ProviderConnection,
    signal: AbortSignal,
  ): Promise<ProviderVerificationResult> {
    const checkedAt = this.now();
    try {
      await this.fetchCatalog(connection, signal);
      return {
        status: 'verified',
        verifiedAt: checkedAt.toISOString(),
        expiresAt: new Date(checkedAt.getTime() + VERIFICATION_TTL_MS).toISOString(),
        message: null,
      };
    } catch (error) {
      if (signal.aborted) throw error;
      const status = error instanceof XAIHttpError ? error.status : null;
      return {
        status: status === 401 || status === 403 ? 'invalid_credentials' : 'unavailable',
        verifiedAt: checkedAt.toISOString(),
        expiresAt: checkedAt.toISOString(),
        message:
          status === 401 || status === 403
            ? 'xAI API credentials were rejected'
            : 'xAI API is temporarily unavailable',
      };
    }
  }

  async listModels(
    connection: ProviderConnection,
    signal: AbortSignal,
  ): Promise<readonly ProviderModel[]> {
    const { models, languageModels } = await this.fetchCatalog(connection, signal);
    const observedAt = this.now().toISOString();
    const providerValue = <T>(value: T | null) =>
      ({
        value,
        source: 'provider_api',
        sourceReference: MODELS_SOURCE,
        observedAt,
      }) as const;
    const unknown = { value: null, source: 'unknown' } as const;
    const modelById = new Map(models.map((model) => [model.id, model]));
    return languageModels.map((languageModel) => {
      const model = modelById.get(languageModel.id);
      const inputs = new Set(languageModel.input_modalities ?? []);
      const outputs = new Set(languageModel.output_modalities ?? []);
      return {
        connectionId: connection.id,
        providerId: 'xai',
        modelId: languageModel.id,
        displayName: languageModel.id,
        available: outputs.has('text'),
        availabilityCheckedAt: observedAt,
        contextWindow: providerValue(positiveInteger(model?.context_length)),
        maxOutputTokens: unknown,
        toolCalling: unknown,
        structuredOutput: unknown,
        multimodalInput: providerValue(inputs.has('image')),
        reasoning: unknown,
        pricing: {
          promptPerToken: providerValue(usdPerToken(languageModel.prompt_text_token_price)),
          completionPerToken: providerValue(usdPerToken(languageModel.completion_text_token_price)),
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
    assertXAIConnection(connection);
    const parsed = providerExecutionRequestSchema.parse(request);
    if (parsed.connectionId !== connection.id)
      throw new Error('Execution Connection does not match the xAI API Connection');
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abort, { once: true });
    this.executions.set(parsed.executionId, controller);
    try {
      controller.signal.throwIfAborted();
      const response = await this.authenticatedFetch(connection, '/responses', controller.signal, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(xAIResponseRequest(parsed)),
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
            message: 'xAI API returned an empty stream',
            retryable: true,
            retryAfterMs: null,
            providerCode: null,
          },
        };
        return;
      }
      yield* normalizeOpenAIResponsesStream(
        response.body,
        'xai',
        parsed.modelId,
        {
          costTicksPerUsd: XAI_COST_TICKS_PER_USD,
        },
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
            ? 'xAI execution was canceled'
            : 'xAI API could not be reached',
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

  private async fetchCatalog(
    connection: ProviderConnection,
    signal: AbortSignal,
  ): Promise<{
    models: readonly XAIModel[];
    languageModels: readonly XAILanguageModel[];
  }> {
    assertXAIConnection(connection);
    const [modelsResponse, languageResponse] = await Promise.all([
      this.authenticatedFetch(connection, '/models', signal, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      }),
      this.authenticatedFetch(connection, '/language-models', signal, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      }),
    ]);
    if (!modelsResponse.ok) throw new XAIHttpError(modelsResponse.status);
    if (!languageResponse.ok) throw new XAIHttpError(languageResponse.status);
    const [modelsValue, languageValue]: unknown[] = await Promise.all([
      modelsResponse.json(),
      languageResponse.json(),
    ]);
    const modelsPage = object(modelsValue);
    const languagePage = object(languageValue);
    if (
      modelsPage === null ||
      !Array.isArray(modelsPage.data) ||
      languagePage === null ||
      !Array.isArray(languagePage.models)
    )
      throw new Error('xAI model catalog response is invalid');
    return {
      models: modelsPage.data.filter(isXAIModel),
      languageModels: languagePage.models.filter(isXAILanguageModel),
    };
  }

  private async authenticatedFetch(
    connection: ProviderConnection,
    path: string,
    signal: AbortSignal,
    init: RequestInit,
  ): Promise<Response> {
    assertXAIConnection(connection);
    const credential = await this.resolveCredential(connection);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${credential.apiKey}`);
    return this.providerFetch(`${XAI_API_BASE_URL}${path}`, {
      ...init,
      headers,
      signal,
    });
  }
}

function xAIResponseRequest(request: ProviderExecutionRequest): Record<string, unknown> {
  const base = openAICompatibleResponseRequest(request);
  if (request.webSearch !== true) return base;
  return {
    ...base,
    tools: [...(Array.isArray(base.tools) ? base.tools : []), { type: 'web_search' }],
  };
}

class XAIHttpError extends Error {
  constructor(readonly status: number) {
    super(`xAI API request failed with HTTP ${status}`);
  }
}

function normalizeHttpError(status: number, retryAfterMs: number | null): NormalizedProviderError {
  if (status === 401)
    return error('credentials', 'xAI API credentials were rejected', false, status);
  if (status === 403) return error('invalid_request', 'xAI API permission denied', false, status);
  if (status === 404) return error('not_found', 'Grok model was not found', false, status);
  if (status === 429)
    return {
      ...error('rate_limited', 'xAI rate limit reached', true, status),
      retryAfterMs,
    };
  if (status >= 500)
    return error('provider_unavailable', 'xAI API is temporarily unavailable', true, status);
  return error('invalid_request', 'xAI API rejected the request', false, status);
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

function isXAIModel(value: unknown): value is XAIModel {
  const record = object(value);
  return typeof record?.id === 'string' && record.id.length > 0 && record.id.length <= 256;
}

function isXAILanguageModel(value: unknown): value is XAILanguageModel {
  return isXAIModel(value);
}

function assertXAIConnection(connection: ProviderConnection): void {
  if (connection.runtimeKind !== 'official_api' || connection.providerId !== 'xai')
    throw new Error('xAI Provider client requires an official xAI API Connection');
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function usdPerToken(value: unknown): string | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? (value / XAI_COST_TICKS_PER_USD).toString()
    : null;
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

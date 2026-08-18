import {
  providerExecutionRequestSchema,
  type CanonicalProviderEvent,
  type NormalizedProviderError,
  type ProviderConnection,
  type ProviderExecutionRequest,
  type ProviderModel,
} from '@sprint-coder/contracts';
import type { ProviderRuntime, ProviderVerificationResult } from './provider-runtime';
import {
  openAICompatibleResponseRequest,
  type OpenAICredentialResolver,
  type ProviderFetch,
} from './openai-provider-client';
import { normalizeOpenAIResponsesStream } from './openai-responses-stream';
import { ProviderQuotaExceededError, ProviderStreamBudget } from './provider-stream-budget';

const ORCAROUTER_API_BASE_URL = 'https://api.orcarouter.ai/v1';
const MODELS_SOURCE = 'https://docs.orcarouter.ai/getting-started/models';
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1_000;

type OrcaRouterModel = Readonly<{
  id: string;
  owned_by?: string;
  supported_endpoint_types?: readonly string[];
}>;

export class OrcaRouterProviderClient implements ProviderRuntime {
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
      const status = error instanceof OrcaRouterHttpError ? error.status : null;
      return {
        status: status === 401 || status === 403 ? 'invalid_credentials' : 'unavailable',
        verifiedAt: checkedAt.toISOString(),
        expiresAt: checkedAt.toISOString(),
        message:
          status === 401 || status === 403
            ? 'OrcaRouter API credentials were rejected'
            : 'OrcaRouter API is temporarily unavailable',
      };
    }
  }

  async listModels(
    connection: ProviderConnection,
    signal: AbortSignal,
  ): Promise<readonly ProviderModel[]> {
    const models = await this.fetchModels(connection, signal);
    const observedAt = this.now().toISOString();
    const unknown = { value: null, source: 'unknown' as const };
    const providerValue = <T>(value: T | null) => ({
      value,
      source: 'provider_api' as const,
      sourceReference: MODELS_SOURCE,
      observedAt,
    });
    return models.filter(isChatModel).map((model) => ({
      connectionId: connection.id,
      providerId: 'orcarouter',
      providerDisplayName: 'OrcaRouter',
      modelAuthor: providerValue(modelAuthor(model)),
      modelId: model.id,
      displayName: model.id,
      available: true,
      availabilityCheckedAt: observedAt,
      contextWindow: unknown,
      maxOutputTokens: unknown,
      toolCalling: unknown,
      structuredOutput: unknown,
      multimodalInput: unknown,
      reasoning: unknown,
      gateway: {
        providerId: 'orcarouter',
        upstreamProvider: unknown,
      },
    }));
  }

  async *execute(
    connection: ProviderConnection,
    request: ProviderExecutionRequest,
    signal: AbortSignal,
    budget = new ProviderStreamBudget(),
  ): AsyncIterable<CanonicalProviderEvent> {
    assertOrcaRouterConnection(connection);
    const parsed = providerExecutionRequestSchema.parse(request);
    if (parsed.connectionId !== connection.id)
      throw new Error('Execution Connection does not match the OrcaRouter Connection');
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abort, { once: true });
    this.executions.set(parsed.executionId, controller);
    try {
      const response = await this.authenticatedFetch(connection, '/responses', controller.signal, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
            message: 'OrcaRouter returned an empty stream',
            retryable: true,
            retryAfterMs: null,
            providerCode: null,
          },
        };
        return;
      }
      const headerModel = response.headers.get('x-orca-resolved-model');
      for await (const event of normalizeOpenAIResponsesStream(
        response.body,
        'orcarouter',
        parsed.modelId,
        {},
        budget.beginCall(),
      )) {
        if (event.type === 'resolution') {
          yield {
            ...event,
            resolution: {
              ...event.resolution,
              resolvedProvider: 'orcarouter',
              resolvedModel: nonEmpty(headerModel) ?? event.resolution.resolvedModel,
              gatewayProvider: 'orcarouter',
              upstreamProvider: null,
            },
          };
        } else if (
          event.type === 'error' &&
          event.error.message === 'OpenAI response generation failed'
        ) {
          yield {
            ...event,
            error: { ...event.error, message: 'OrcaRouter response generation failed' },
          };
        } else yield event;
      }
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
            ? 'OrcaRouter execution was canceled'
            : 'OrcaRouter could not be reached',
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
  ): Promise<readonly OrcaRouterModel[]> {
    const response = await this.authenticatedFetch(connection, '/models', signal, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new OrcaRouterHttpError(response.status);
    const value: unknown = await response.json();
    if (
      value === null ||
      typeof value !== 'object' ||
      !Array.isArray((value as { data?: unknown }).data)
    )
      throw new Error('OrcaRouter model catalog response is invalid');
    return (value as { data: unknown[] }).data.filter(isOrcaRouterModel);
  }

  private async authenticatedFetch(
    connection: ProviderConnection,
    path: string,
    signal: AbortSignal,
    init: RequestInit,
  ): Promise<Response> {
    assertOrcaRouterConnection(connection);
    const credential = await this.resolveCredential(connection);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${credential.apiKey}`);
    return this.providerFetch(`${ORCAROUTER_API_BASE_URL}${path}`, {
      ...init,
      headers,
      signal,
    });
  }
}

class OrcaRouterHttpError extends Error {
  constructor(readonly status: number) {
    super(`OrcaRouter API request failed with HTTP ${status}`);
  }
}

function isOrcaRouterModel(value: unknown): value is OrcaRouterModel {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    record.id.length <= 256 &&
    (record.owned_by === undefined || typeof record.owned_by === 'string') &&
    (record.supported_endpoint_types === undefined ||
      (Array.isArray(record.supported_endpoint_types) &&
        record.supported_endpoint_types.every((item) => typeof item === 'string')))
  );
}

function isChatModel(model: OrcaRouterModel): boolean {
  return (
    model.id.startsWith('orcarouter/') ||
    model.supported_endpoint_types?.includes('openai') === true
  );
}

function modelAuthor(model: OrcaRouterModel): string | null {
  const owner = nonEmpty(model.owned_by);
  if (owner !== null) return owner;
  const separator = model.id.indexOf('/');
  return separator > 0 ? model.id.slice(0, separator) : null;
}

function responseRequest(request: ProviderExecutionRequest): Record<string, unknown> {
  const base = openAICompatibleResponseRequest(request);
  const tools = Array.isArray(base.tools) ? [...base.tools] : [];
  if (request.webSearch === true) tools.push({ type: 'web_search' });
  if (tools.length > 0) return { ...base, tools };
  const withoutTools = { ...base };
  delete withoutTools.tools;
  return withoutTools;
}

function assertOrcaRouterConnection(connection: ProviderConnection): void {
  if (connection.runtimeKind !== 'official_api' || connection.providerId !== 'orcarouter')
    throw new Error('OrcaRouter client requires an official OrcaRouter Connection');
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 128) : null;
}

function httpError(status: number, retryAfterMs: number | null): NormalizedProviderError {
  if (status === 401 || status === 403)
    return {
      category: 'credentials',
      message: 'OrcaRouter credentials were rejected',
      retryable: false,
      retryAfterMs: null,
      providerCode: `http_${status}`,
    };
  if (status === 404)
    return {
      category: 'not_found',
      message: 'OrcaRouter could not route the requested model',
      retryable: false,
      retryAfterMs: null,
      providerCode: 'http_404',
    };
  if (status === 429)
    return {
      category: 'rate_limited',
      message: 'OrcaRouter rate limit reached',
      retryable: true,
      retryAfterMs,
      providerCode: 'http_429',
    };
  return {
    category: status >= 500 ? 'provider_unavailable' : 'invalid_request',
    message:
      status >= 500 ? 'OrcaRouter is temporarily unavailable' : 'OrcaRouter rejected the request',
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

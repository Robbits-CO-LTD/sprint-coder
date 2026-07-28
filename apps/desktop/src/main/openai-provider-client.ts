import {
  providerExecutionRequestSchema,
  type CanonicalProviderEvent,
  type NormalizedProviderError,
  type ProviderConnection,
  type ProviderExecutionRequest,
  type ProviderModel,
} from '@sprint-coder/contracts';
import type { ProviderRuntime, ProviderVerificationResult } from './provider-runtime';
import { normalizeOpenAIResponsesStream } from './openai-responses-stream';

const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1_000;

export type OpenAICredential = Readonly<{
  apiKey: string;
  organizationId?: string;
  projectId?: string;
}>;

export type OpenAICredentialResolver = (
  connection: ProviderConnection,
) => OpenAICredential | Promise<OpenAICredential>;

export function serializeOpenAICredential(credential: OpenAICredential): string {
  if (credential.apiKey.trim().length === 0) throw new Error('OpenAI API key is missing');
  return JSON.stringify(credential);
}

export function parseOpenAICredential(value: string): OpenAICredential {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== 'object')
    throw new Error('OpenAI credential is invalid');
  const record = parsed as Record<string, unknown>;
  if (typeof record.apiKey !== 'string' || record.apiKey.trim().length === 0)
    throw new Error('OpenAI API key is missing');
  if (record.organizationId !== undefined && typeof record.organizationId !== 'string')
    throw new Error('OpenAI organization ID is invalid');
  if (record.projectId !== undefined && typeof record.projectId !== 'string')
    throw new Error('OpenAI project ID is invalid');
  return {
    apiKey: record.apiKey,
    ...(typeof record.organizationId === 'string' ? { organizationId: record.organizationId } : {}),
    ...(typeof record.projectId === 'string' ? { projectId: record.projectId } : {}),
  };
}

export type ProviderFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type OpenAIModelList = Readonly<{
  object: 'list';
  data: readonly Readonly<{
    id: string;
    object: 'model';
  }>[];
}>;

export class OpenAIProviderClient implements ProviderRuntime {
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
      if (error instanceof OpenAIHttpError)
        return {
          status:
            error.status === 401 || error.status === 403 ? 'invalid_credentials' : 'unavailable',
          verifiedAt: checkedAt.toISOString(),
          expiresAt: checkedAt.toISOString(),
          message:
            error.status === 401 || error.status === 403
              ? 'OpenAI API credentials were rejected'
              : 'OpenAI API is temporarily unavailable',
        };
      if (signal.aborted) throw error;
      return {
        status: 'unavailable',
        verifiedAt: checkedAt.toISOString(),
        expiresAt: checkedAt.toISOString(),
        message: 'OpenAI API could not be reached',
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
      .filter((model) => model.object === 'model' && model.id.length > 0 && model.id.length <= 256)
      .map((model) => ({
        connectionId: connection.id,
        providerId: connection.providerId,
        modelId: model.id,
        displayName: model.id,
        available: true,
        availabilityCheckedAt: checkedAt,
        contextWindow: unknown,
        maxOutputTokens: unknown,
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
    assertOpenAIConnection(connection);
    const parsed = providerExecutionRequestSchema.parse(request);
    if (parsed.connectionId !== connection.id)
      throw new Error('Execution Connection does not match the OpenAI API Connection');
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    this.executions.set(parsed.executionId, controller);
    try {
      const response = await this.authenticatedFetch(connection, '/responses', controller.signal, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(openAICompatibleResponseRequest(parsed)),
      });
      if (!response.ok) {
        const retryAfterMs = retryAfter(response.headers.get('retry-after'), this.now());
        if (response.status === 429)
          yield { type: 'rate_limit', retryAfterMs, observedAt: this.now().toISOString() };
        yield { type: 'error', error: normalizeHttpError(response.status, retryAfterMs) };
        return;
      }
      if (response.body === null) {
        yield {
          type: 'error',
          error: {
            category: 'provider_unavailable',
            message: 'OpenAI API returned an empty stream',
            retryable: true,
            retryAfterMs: null,
            providerCode: null,
          },
        };
        return;
      }
      yield* normalizeOpenAIResponsesStream(response.body, connection.providerId, parsed.modelId);
    } catch {
      yield {
        type: 'error',
        error: {
          category: controller.signal.aborted ? 'canceled' : 'network',
          message: controller.signal.aborted
            ? 'OpenAI execution was canceled'
            : 'OpenAI API could not be reached',
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
  ): Promise<OpenAIModelList> {
    assertOpenAIConnection(connection);
    const response = await this.authenticatedFetch(connection, '/models', signal, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new OpenAIHttpError(response.status);
    const value: unknown = await response.json();
    if (!isOpenAIModelList(value)) throw new Error('OpenAI model catalog response is invalid');
    return value;
  }

  private async authenticatedFetch(
    connection: ProviderConnection,
    path: string,
    signal: AbortSignal,
    init: RequestInit,
  ): Promise<Response> {
    const credential = await this.resolveCredential(connection);
    if (credential.apiKey.trim().length === 0) throw new Error('OpenAI API key is missing');
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${credential.apiKey}`);
    if (credential.organizationId !== undefined)
      headers.set('OpenAI-Organization', credential.organizationId);
    if (credential.projectId !== undefined) headers.set('OpenAI-Project', credential.projectId);
    return this.providerFetch(`${OPENAI_API_BASE_URL}${path}`, { ...init, headers, signal });
  }
}

class OpenAIHttpError extends Error {
  constructor(readonly status: number) {
    super(`OpenAI API request failed with HTTP ${status}`);
  }
}

function assertOpenAIConnection(connection: ProviderConnection): void {
  if (connection.runtimeKind !== 'official_api' || connection.providerId !== 'openai')
    throw new Error('OpenAI Provider client requires an official OpenAI API Connection');
}

function isOpenAIModelList(value: unknown): value is OpenAIModelList {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.object !== 'list' || !Array.isArray(record.data)) return false;
  return record.data.every(
    (item) =>
      item !== null &&
      typeof item === 'object' &&
      (item as Record<string, unknown>).object === 'model' &&
      typeof (item as Record<string, unknown>).id === 'string',
  );
}

export function openAICompatibleResponseRequest(
  request: ProviderExecutionRequest,
): Record<string, unknown> {
  const input: Record<string, unknown>[] = [];
  for (const message of request.messages) {
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: message.content,
      });
      continue;
    }
    if (message.content !== '' || (message.toolCalls?.length ?? 0) === 0)
      input.push({
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
      input.push({
        type: 'function_call',
        call_id: toolCall.callId,
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.input),
      });
  }
  return {
    model: request.modelId,
    stream: true,
    store: false,
    input,
    ...(request.tools === undefined
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
            strict: true,
          })),
        }),
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

function normalizeHttpError(status: number, retryAfterMs: number | null): NormalizedProviderError {
  if (status === 401 || status === 403)
    return {
      category: 'credentials',
      message: 'OpenAI API credentials were rejected',
      retryable: false,
      retryAfterMs: null,
      providerCode: `http_${status}`,
    };
  if (status === 404)
    return {
      category: 'not_found',
      message: 'The requested OpenAI model or resource was not found',
      retryable: false,
      retryAfterMs: null,
      providerCode: 'http_404',
    };
  if (status === 429)
    return {
      category: 'rate_limited',
      message: 'OpenAI API rate limit reached',
      retryable: true,
      retryAfterMs,
      providerCode: 'http_429',
    };
  if (status === 408)
    return {
      category: 'timeout',
      message: 'OpenAI API request timed out',
      retryable: true,
      retryAfterMs: null,
      providerCode: 'http_408',
    };
  return {
    category: status >= 500 ? 'provider_unavailable' : 'invalid_request',
    message:
      status >= 500 ? 'OpenAI API is temporarily unavailable' : 'OpenAI API rejected the request',
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

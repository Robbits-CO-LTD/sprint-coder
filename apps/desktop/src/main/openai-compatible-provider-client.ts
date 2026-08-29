import {
  MANAGED_LOCAL_DEFAULT_MAX_OUTPUT_TOKENS,
  providerExecutionRequestSchema,
  type CanonicalProviderEvent,
  type ManagedLocalInferenceSettings,
  type NormalizedProviderError,
  type ProviderConnection,
  type ProviderExecutionRequest,
  type ProviderModel,
  type ProviderProfile,
} from '@sprint-coder/contracts';
import type { ProviderRuntime, ProviderVerificationResult } from './provider-runtime';
import type { OpenAICompatibleCredential, ProviderProfileRegistry } from './provider-profile';
import {
  profileRequiresCredential,
  resolveProfileBaseUrl,
  resolvedProfileEndpointTrust,
} from './provider-profile';
import type { ProviderFetch } from './openai-provider-client';
import { openAICompatibleResponseRequest } from './openai-provider-client';
import { normalizeOpenAIResponsesStream } from './openai-responses-stream';
import { normalizeOpenAIChatCompletionsStream } from './openai-chat-completions-stream';
import {
  OllamaModelLeaseCoordinator,
  type OllamaModelTarget,
  type ProviderModelLease,
} from './ollama-model-lifecycle';
import { secureLogger } from './secure-logger';
import { ProviderEndpointPolicy, secureProviderFetch } from './provider-endpoint-policy';
import { ProviderQuotaExceededError, ProviderStreamBudget } from './provider-stream-budget';
import { digestCanonical } from './context-compiler';
import type { ProviderImageInputCapabilitySnapshot } from './provider-runtime';

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1_000;
export const OLLAMA_MODEL_PRELOAD_TIMEOUT_MS = 180_000;
const OLLAMA_MODEL_PRELOAD_RESPONSE_BYTES = 64 * 1_024;
const OLLAMA_IMAGE_CAPABILITY_TIMEOUT_MS = 5_000;
const OLLAMA_IMAGE_CAPABILITY_RESPONSE_BYTES = 256 * 1_024;
const endpointPolicy = new ProviderEndpointPolicy();

export type OllamaModelPreparationFailure =
  'preload_timeout' | 'not_found' | 'provider_unavailable' | 'network' | 'canceled';

export class OllamaModelPreparationError extends Error {
  readonly userMessage: string;

  constructor(readonly category: OllamaModelPreparationFailure) {
    super(`Ollama model preparation failed: ${category}`);
    this.name = 'OllamaModelPreparationError';
    this.userMessage =
      category === 'preload_timeout'
        ? 'Ollamaモデルの準備が180秒以内に完了しませんでした。モデルを確認して、もう一度お試しください。'
        : category === 'not_found'
          ? '選択したOllamaモデルが見つかりません。モデル一覧を更新して、もう一度選択してください。'
          : category === 'provider_unavailable'
            ? 'Ollamaがモデルの準備を完了できませんでした。Ollamaの状態を確認して、もう一度お試しください。'
            : category === 'network'
              ? 'Ollamaへ接続できず、モデルを準備できませんでした。Ollamaが起動していることを確認してください。'
              : 'Ollamaモデルの準備をキャンセルしました。';
  }
}

export type OpenAICompatibleCredentialResolver = (
  connection: ProviderConnection,
) => OpenAICompatibleCredential | Promise<OpenAICompatibleCredential>;

export class OpenAICompatibleProviderClient implements ProviderRuntime {
  private readonly executions = new Map<string, AbortController>();
  private readonly modelLifecycle: OllamaModelLeaseCoordinator;

  constructor(
    private readonly profiles: ProviderProfileRegistry,
    private readonly resolveCredential: OpenAICompatibleCredentialResolver,
    private readonly providerFetch: ProviderFetch = secureProviderFetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.modelLifecycle = new OllamaModelLeaseCoordinator(
      (target) => this.unloadOllamaModel(target),
      (_target, error) => {
        secureLogger.warn('Ollama model release failed', {
          category: 'provider_model_release',
          failure:
            error instanceof CompatibleHttpError
              ? { kind: 'http', status: error.status }
              : { kind: 'transport', name: error instanceof Error ? error.name : 'unknown' },
        });
      },
      2_000,
      (target, signal) => this.preloadOllamaModel(target, signal),
    );
  }

  async acquireModelLease(
    connection: ProviderConnection,
    modelId: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ProviderModelLease> {
    const target = await this.ollamaModelTarget(connection, modelId);
    if (target === null) return { prepare: async () => undefined, release: async () => undefined };
    return this.modelLifecycle.acquire(target, connection.automaticModelRelease !== false, signal);
  }

  async dispose(): Promise<void> {
    for (const controller of this.executions.values()) controller.abort();
    await this.modelLifecycle.dispose();
  }

  async verify(
    connection: ProviderConnection,
    signal: AbortSignal,
  ): Promise<ProviderVerificationResult> {
    const checkedAt = this.now();
    try {
      const profile = this.profiles.get(connection.providerId);
      if (profile.modelsPath === null)
        await this.verifyWithMinimalGeneration(connection, profile, signal);
      else await this.fetchModels(connection, signal);
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
            error.status === 401 || error.status === 403 ? 'invalid_credentials' : 'unavailable',
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
    assertCompatibleConnection(connection);
    const profile = this.profiles.get(connection.providerId);
    if (profile.modelsPath === null) return this.catalogModels(connection, profile.curatedModels);
    const response = await this.fetchModels(connection, signal);
    return this.catalogModels(connection, response.data);
  }

  async captureImageInputCapability(
    connection: ProviderConnection,
    modelId: string,
    signal: AbortSignal,
  ): Promise<ProviderImageInputCapabilitySnapshot | null> {
    const target = await this.ollamaModelTarget(connection, modelId);
    if (target === null) return null;
    const endpoint = new URL(target.endpoint);
    endpoint.pathname = '/api/show';
    const controller = new AbortController();
    let timedOut = false;
    const abort = (): void => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, OLLAMA_IMAGE_CAPABILITY_TIMEOUT_MS);
    try {
      const response = await this.providerFetch(endpoint.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId, verbose: false }),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) return this.unknownImageInputCapability(connection, modelId, 'http');
      const payload = await readBoundedOllamaJsonResponse(
        response,
        controller.signal,
        OLLAMA_IMAGE_CAPABILITY_RESPONSE_BYTES,
      );
      const capabilities = ollamaCapabilities(payload);
      if (capabilities === null)
        return this.unknownImageInputCapability(connection, modelId, 'malformed');
      return Object.freeze({
        value: capabilities.includes('vision'),
        revision: digestCanonical({
          connectionId: connection.id,
          providerId: connection.providerId,
          modelId,
          endpointDigest: digestCanonical(target.endpoint),
          capabilities,
        }),
        capturedAtMs: this.now().getTime(),
      });
    } catch {
      if (signal.aborted) throw new OllamaModelPreparationError('canceled');
      return this.unknownImageInputCapability(
        connection,
        modelId,
        timedOut ? 'timeout' : 'network',
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }

  private catalogModels(
    connection: ProviderConnection,
    models: readonly Readonly<{
      id: string;
      displayName?: string;
      context_window?: number;
      max_completion_tokens?: number;
    }>[],
  ): readonly ProviderModel[] {
    const checkedAt = this.now().toISOString();
    const unknown = { value: null, source: 'unknown' } as const;
    return models
      .filter((model) => model.id.length > 0 && model.id.length <= 256)
      .map((model) => ({
        connectionId: connection.id,
        providerId: connection.providerId,
        modelId: model.id,
        displayName: model.displayName ?? model.id,
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
    budget = new ProviderStreamBudget(),
  ): AsyncIterable<CanonicalProviderEvent> {
    assertCompatibleConnection(connection);
    const parsed = providerExecutionRequestSchema.parse(request);
    if (parsed.connectionId !== connection.id)
      throw new Error('Execution Connection does not match the Provider Profile Connection');
    const profile = this.profiles.get(connection.providerId);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abort, { once: true });
    this.executions.set(parsed.executionId, controller);
    try {
      controller.signal.throwIfAborted();
      const path = profile.protocol === 'responses' ? '/responses' : '/chat/completions';
      const body =
        profile.protocol === 'responses'
          ? openAICompatibleResponseRequest(parsed)
          : openAICompatibleChatCompletionRequest(parsed, connection.providerId);
      const response = await this.authenticatedFetch(connection, profile, path, controller.signal, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
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
          {},
          budget.beginCall(),
        );
      else
        yield* normalizeOpenAIChatCompletionsStream(
          response.body,
          connection.providerId,
          parsed.modelId,
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

  private async ollamaModelTarget(
    connection: ProviderConnection,
    modelId: string,
  ): Promise<OllamaModelTarget | null> {
    if (connection.providerId !== 'ollama') return null;
    const profile = this.profiles.get(connection.providerId);
    if (profile.id !== 'ollama' || profile.nativeModelLifecycle !== 'ollama') return null;
    const credential = await this.resolveCredential(connection);
    const endpoint = resolveOllamaNativeGenerateEndpoint(
      resolveProfileBaseUrl(profile, credential),
    );
    return endpoint === null ? null : { endpoint, modelId };
  }

  private async unloadOllamaModel(target: OllamaModelTarget): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    try {
      const response = await this.providerFetch(target.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: target.modelId, keep_alive: 0 }),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) throw new CompatibleHttpError(response.status);
      await response.body?.cancel();
    } finally {
      clearTimeout(timer);
    }
  }

  private async preloadOllamaModel(
    target: OllamaModelTarget,
    lifecycleSignal: AbortSignal,
  ): Promise<void> {
    if (lifecycleSignal.aborted) throw new OllamaModelPreparationError('canceled');
    const controller = new AbortController();
    let timedOut = false;
    const abort = (): void => controller.abort();
    lifecycleSignal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, OLLAMA_MODEL_PRELOAD_TIMEOUT_MS);
    try {
      const response = await this.providerFetch(target.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: target.modelId, keep_alive: '5m', stream: false }),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok)
        throw new OllamaModelPreparationError(
          response.status === 404 ? 'not_found' : 'provider_unavailable',
        );
      const payload = await readBoundedOllamaPreloadResponse(response, controller.signal);
      if (payload.model !== target.modelId)
        throw new OllamaModelPreparationError('provider_unavailable');
    } catch (error) {
      if (error instanceof OllamaModelPreparationError) throw error;
      if (timedOut) throw new OllamaModelPreparationError('preload_timeout');
      if (lifecycleSignal.aborted) throw new OllamaModelPreparationError('canceled');
      throw new OllamaModelPreparationError('network');
    } finally {
      clearTimeout(timer);
      lifecycleSignal.removeEventListener('abort', abort);
    }
  }

  private unknownImageInputCapability(
    connection: ProviderConnection,
    modelId: string,
    reason: 'http' | 'malformed' | 'timeout' | 'network',
  ): ProviderImageInputCapabilitySnapshot {
    return Object.freeze({
      value: null,
      revision: digestCanonical({
        connectionId: connection.id,
        providerId: connection.providerId,
        modelId,
        connectionUpdatedAt: connection.updatedAt,
        status: reason,
      }),
      capturedAtMs: this.now().getTime(),
    });
  }

  private async fetchModels(
    connection: ProviderConnection,
    signal: AbortSignal,
  ): Promise<CompatibleModelList> {
    assertCompatibleConnection(connection);
    const profile = this.profiles.get(connection.providerId);
    if (profile.modelsPath === null)
      throw new Error(`Provider Profile ${profile.id} uses a curated model catalog`);
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

  private async verifyWithMinimalGeneration(
    connection: ProviderConnection,
    profile: ProviderProfile,
    signal: AbortSignal,
  ): Promise<void> {
    if (profile.verificationModel === null)
      throw new Error(`Provider Profile ${profile.id} has no verification model`);
    const response = await this.authenticatedFetch(
      connection,
      profile,
      profile.protocol === 'responses' ? '/responses' : '/chat/completions',
      signal,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          profile.protocol === 'responses'
            ? {
                model: profile.verificationModel,
                input: 'ping',
                max_output_tokens: 1,
                stream: false,
                store: false,
              }
            : {
                model: profile.verificationModel,
                messages: [{ role: 'user', content: 'ping' }],
                max_tokens: 1,
                stream: false,
              },
        ),
      },
    );
    if (!response.ok) throw new CompatibleHttpError(response.status);
    await response.body?.cancel();
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
      if (field === 'api_key' && (credential.apiKey?.trim().length ?? 0) === 0)
        throw new Error(`Provider Profile ${profile.id} requires an API key`);
      else if (field === 'account_id' && (credential.accountId?.trim().length ?? 0) === 0)
        throw new Error(`Provider Profile ${profile.id} requires an account ID`);
    const headers = new Headers(init.headers);
    if (credential.apiKey !== undefined) {
      const prefix =
        profile.authentication.scheme.length === 0 ? '' : `${profile.authentication.scheme} `;
      headers.set(profile.authentication.headerName, `${prefix}${credential.apiKey}`);
    } else if (profileRequiresCredential(profile, 'api_key')) {
      throw new Error(`Provider Profile ${profile.id} requires an API key`);
    }
    const baseUrl = resolveProfileBaseUrl(profile, credential);
    if (credential.endpointDigest !== endpointPolicy.digestForBaseUrl(baseUrl))
      throw new Error('Provider endpoint requires validation');
    if (
      resolvedProfileEndpointTrust(profile, credential) === 'trusted-local' &&
      credential.localConsentDigest !== endpointPolicy.digestForBaseUrl(baseUrl)
    )
      throw new Error('Local Provider endpoint requires explicit consent');
    return this.providerFetch(`${baseUrl}${path}`, { ...init, headers, signal });
  }
}

export function resolveOllamaNativeGenerateEndpoint(baseUrl: string): string | null {
  return resolveOllamaNativeEndpoint(baseUrl, '/api/generate');
}

export function resolveOllamaNativeShowEndpoint(baseUrl: string): string | null {
  return resolveOllamaNativeEndpoint(baseUrl, '/api/show');
}

function resolveOllamaNativeEndpoint(baseUrl: string, pathname: '/api/generate' | '/api/show') {
  const parsed = new URL(baseUrl);
  if (
    parsed.protocol !== 'http:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    !['/', '/v1', '/v1/'].includes(parsed.pathname) ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    return null;
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost') parsed.hostname = '127.0.0.1';
  else if (!isLoopbackIpLiteral(hostname)) return null;
  parsed.pathname = pathname;
  return parsed.toString();
}

function isLoopbackIpLiteral(hostname: string): boolean {
  if (hostname === '[::1]' || hostname === '::1') return true;
  const octets = hostname.split('.');
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255) &&
    octets[0] === '127'
  );
}

async function readBoundedOllamaPreloadResponse(
  response: Response,
  signal: AbortSignal,
): Promise<{ model: string }> {
  const parsed = await readBoundedOllamaJsonResponse(
    response,
    signal,
    OLLAMA_MODEL_PRELOAD_RESPONSE_BYTES,
  );
  if (parsed === null || typeof parsed !== 'object')
    throw new OllamaModelPreparationError('provider_unavailable');
  const model = (parsed as Record<string, unknown>).model;
  if (typeof model !== 'string' || model.length === 0 || model.length > 256)
    throw new OllamaModelPreparationError('provider_unavailable');
  return { model };
}

async function readBoundedOllamaJsonResponse(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
): Promise<unknown> {
  if (response.body === null) throw new OllamaModelPreparationError('provider_unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await readOllamaPreloadChunk(reader, signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new OllamaModelPreparationError('provider_unavailable');
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A non-conforming mocked stream may keep a read pending after cancellation. The bounded
      // preload has already failed, so lock cleanup must not replace the safe failure category.
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new OllamaModelPreparationError('provider_unavailable');
  }
}

function ollamaCapabilities(value: unknown): readonly string[] | null {
  if (value === null || typeof value !== 'object') return null;
  const capabilities = (value as Record<string, unknown>).capabilities;
  if (
    !Array.isArray(capabilities) ||
    capabilities.length > 64 ||
    !capabilities.every((item) => typeof item === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(item))
  )
    return null;
  return [...new Set(capabilities)].sort();
}

function readOllamaPreloadChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  let rejectAborted: ((error: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const abort = (): void => rejectAborted?.(new Error('aborted'));
  signal.addEventListener('abort', abort, { once: true });
  return Promise.race([reader.read(), aborted]).finally(() => {
    signal.removeEventListener('abort', abort);
  });
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
  providerId?: string,
  managedLocalSettings?: ManagedLocalInferenceSettings,
): Record<string, unknown> {
  const localSettings = managedLocalSettings ?? {
    maxOutputTokens: MANAGED_LOCAL_DEFAULT_MAX_OUTPUT_TOKENS,
    thinking: false,
  };
  return {
    model: request.modelId,
    stream: true,
    stream_options: { include_usage: true },
    messages: request.messages.map((message) => ({
      role: message.role,
      content:
        message.inlineImages === undefined || message.inlineImages.length === 0
          ? message.role === 'assistant' &&
            (message.toolCalls?.length ?? 0) > 0 &&
            message.content === ''
            ? null
            : message.content
          : [
              { type: 'text', text: message.content },
              ...message.inlineImages.map((image) => ({
                type: 'image_url',
                image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
              })),
            ],
      ...(message.role === 'tool' ? { tool_call_id: message.toolCallId } : {}),
      ...(message.role === 'assistant' && message.toolCalls !== undefined
        ? {
            tool_calls: message.toolCalls.map((toolCall) => ({
              id: toolCall.callId,
              type: 'function',
              function: {
                name: toolCall.name,
                arguments: JSON.stringify(toolCall.input),
              },
            })),
          }
        : {}),
    })),
    ...(providerId === 'sprint-managed-local'
      ? {
          max_tokens: localSettings.maxOutputTokens,
          ...(localSettings.thinking ? {} : { reasoning_effort: 'none' }),
          chat_template_kwargs: { enable_thinking: localSettings.thinking },
        }
      : {}),
    ...(request.tools === undefined
      ? {}
      : {
          ...(providerId === 'ollama' ? { reasoning_effort: 'none' } : {}),
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
          ...(request.toolChoice === undefined
            ? {}
            : {
                tool_choice:
                  typeof request.toolChoice === 'string'
                    ? request.toolChoice
                    : {
                        type: 'function',
                        function: { name: request.toolChoice.name },
                      },
              }),
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

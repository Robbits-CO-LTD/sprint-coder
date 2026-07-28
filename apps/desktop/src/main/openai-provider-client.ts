import type { ProviderConnection, ProviderModel } from '@sprint-coder/contracts';
import type { ProviderVerificationResult } from './provider-runtime';

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

export class OpenAIProviderClient {
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
            error.status === 401 || error.status === 403
              ? 'invalid_credentials'
              : 'unavailable',
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

  private async fetchModels(
    connection: ProviderConnection,
    signal: AbortSignal,
  ): Promise<OpenAIModelList> {
    assertOpenAIConnection(connection);
    const credential = await this.resolveCredential(connection);
    if (credential.apiKey.trim().length === 0) throw new Error('OpenAI API key is missing');
    const headers = new Headers({
      Accept: 'application/json',
      Authorization: `Bearer ${credential.apiKey}`,
    });
    if (credential.organizationId !== undefined)
      headers.set('OpenAI-Organization', credential.organizationId);
    if (credential.projectId !== undefined) headers.set('OpenAI-Project', credential.projectId);
    const response = await this.providerFetch(`${OPENAI_API_BASE_URL}/models`, {
      method: 'GET',
      headers,
      signal,
    });
    if (!response.ok) throw new OpenAIHttpError(response.status);
    const value: unknown = await response.json();
    if (!isOpenAIModelList(value)) throw new Error('OpenAI model catalog response is invalid');
    return value;
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

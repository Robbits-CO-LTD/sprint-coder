import { randomUUID } from 'node:crypto';
import {
  anthropicConnectionCreateInputSchema,
  geminiConnectionCreateInputSchema,
  openAIConnectionCreateInputSchema,
  openRouterConnectionCreateInputSchema,
  providerProfileConnectionCreateInputSchema,
  xAIConnectionCreateInputSchema,
  type AnthropicConnectionCreateInput,
  type GeminiConnectionCreateInput,
  type OpenAIConnectionCreateInput,
  type OpenRouterConnectionCreateInput,
  type ProviderConnection,
  type ProviderProfileConnectionCreateInput,
  type XAIConnectionCreateInput,
} from '@sprint-coder/contracts';
import { serializeOpenAICredential, type OpenAICredential } from './openai-provider-client';
import { serializeAnthropicCredential } from './anthropic-provider-client';
import { serializeGeminiCredential } from './gemini-provider-client';
import { serializeXAICredential } from './xai-provider-client';
import {
  serializeOpenAICompatibleCredential,
  type ProviderProfileRegistry,
} from './provider-profile';

export interface ProviderConnectionRepository {
  listProviderConnections(): readonly ProviderConnection[];
  createProviderConnection(connection: ProviderConnection): ProviderConnection;
}

export interface ProviderConnectionSecretWriter {
  put(secret: string): string;
  delete(reference: string): void;
}

export class ProviderConnectionService {
  constructor(
    private readonly repository: ProviderConnectionRepository,
    private readonly secrets: ProviderConnectionSecretWriter,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = randomUUID,
    private readonly profiles?: ProviderProfileRegistry,
  ) {}

  list(): readonly ProviderConnection[] {
    return this.repository.listProviderConnections();
  }

  createOpenAI(input: OpenAIConnectionCreateInput): ProviderConnection {
    const parsed = openAIConnectionCreateInputSchema.parse(input);
    const credential: OpenAICredential = {
      apiKey: parsed.apiKey,
      ...(parsed.organizationId === undefined ? {} : { organizationId: parsed.organizationId }),
      ...(parsed.projectId === undefined ? {} : { projectId: parsed.projectId }),
    };
    const secretReference = this.secrets.put(serializeOpenAICredential(credential));
    const timestamp = this.now().toISOString();
    try {
      return this.repository.createProviderConnection({
        id: `openai:${this.id()}`,
        providerId: 'openai',
        runtimeKind: 'official_api',
        displayName: parsed.displayName,
        enabled: true,
        secretReference,
        verification: {
          status: 'unverified',
          verifiedAt: null,
          expiresAt: null,
          message: null,
        },
        rateLimit: {
          mode: 'auto',
          maxConcurrentRequests: 2,
          requestsPerMinute: null,
          tokensPerMinute: null,
          lastObservedRateLimitHeaders: null,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    } catch (error) {
      this.secrets.delete(secretReference);
      throw error;
    }
  }

  createOpenRouter(input: OpenRouterConnectionCreateInput): ProviderConnection {
    const parsed = openRouterConnectionCreateInputSchema.parse(input);
    const secretReference = this.secrets.put(serializeOpenAICredential({ apiKey: parsed.apiKey }));
    const timestamp = this.now().toISOString();
    try {
      return this.repository.createProviderConnection({
        id: `openrouter:${this.id()}`,
        providerId: 'openrouter',
        runtimeKind: 'official_api',
        displayName: parsed.displayName,
        enabled: true,
        secretReference,
        verification: {
          status: 'unverified',
          verifiedAt: null,
          expiresAt: null,
          message: null,
        },
        rateLimit: {
          mode: 'auto',
          maxConcurrentRequests: 2,
          requestsPerMinute: null,
          tokensPerMinute: null,
          lastObservedRateLimitHeaders: null,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    } catch (error) {
      this.secrets.delete(secretReference);
      throw error;
    }
  }

  createAnthropic(input: AnthropicConnectionCreateInput): ProviderConnection {
    const parsed = anthropicConnectionCreateInputSchema.parse(input);
    const secretReference = this.secrets.put(
      serializeAnthropicCredential({ apiKey: parsed.apiKey }),
    );
    const timestamp = this.now().toISOString();
    try {
      return this.repository.createProviderConnection({
        id: `anthropic:${this.id()}`,
        providerId: 'anthropic',
        runtimeKind: 'official_api',
        displayName: parsed.displayName,
        enabled: true,
        secretReference,
        verification: {
          status: 'unverified',
          verifiedAt: null,
          expiresAt: null,
          message: null,
        },
        rateLimit: {
          mode: 'auto',
          maxConcurrentRequests: 2,
          requestsPerMinute: null,
          tokensPerMinute: null,
          lastObservedRateLimitHeaders: null,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    } catch (error) {
      this.secrets.delete(secretReference);
      throw error;
    }
  }

  createGemini(input: GeminiConnectionCreateInput): ProviderConnection {
    const parsed = geminiConnectionCreateInputSchema.parse(input);
    const secretReference = this.secrets.put(serializeGeminiCredential({ apiKey: parsed.apiKey }));
    const timestamp = this.now().toISOString();
    try {
      return this.repository.createProviderConnection({
        id: `google:${this.id()}`,
        providerId: 'google',
        runtimeKind: 'official_api',
        displayName: parsed.displayName,
        enabled: true,
        secretReference,
        verification: {
          status: 'unverified',
          verifiedAt: null,
          expiresAt: null,
          message: null,
        },
        rateLimit: {
          mode: 'auto',
          maxConcurrentRequests: 2,
          requestsPerMinute: null,
          tokensPerMinute: null,
          lastObservedRateLimitHeaders: null,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    } catch (error) {
      this.secrets.delete(secretReference);
      throw error;
    }
  }

  createXAI(input: XAIConnectionCreateInput): ProviderConnection {
    const parsed = xAIConnectionCreateInputSchema.parse(input);
    const secretReference = this.secrets.put(serializeXAICredential({ apiKey: parsed.apiKey }));
    const timestamp = this.now().toISOString();
    try {
      return this.repository.createProviderConnection({
        id: `xai:${this.id()}`,
        providerId: 'xai',
        runtimeKind: 'official_api',
        displayName: parsed.displayName,
        enabled: true,
        secretReference,
        verification: {
          status: 'unverified',
          verifiedAt: null,
          expiresAt: null,
          message: null,
        },
        rateLimit: {
          mode: 'auto',
          maxConcurrentRequests: 2,
          requestsPerMinute: null,
          tokensPerMinute: null,
          lastObservedRateLimitHeaders: null,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    } catch (error) {
      this.secrets.delete(secretReference);
      throw error;
    }
  }

  createProfile(input: ProviderProfileConnectionCreateInput): ProviderConnection {
    const parsed = providerProfileConnectionCreateInputSchema.parse(input);
    if (this.profiles === undefined) throw new Error('Provider Profile Registry is not configured');
    const profile = this.profiles.get(parsed.profileId);
    if (parsed.baseUrl !== undefined && !profile.baseUrlConfigurable)
      throw new Error(`Provider Profile ${profile.id} does not allow a custom base URL`);
    for (const field of profile.requiredCredentialFields)
      if (field === 'account_id' && parsed.accountId === undefined)
        throw new Error(`Provider Profile ${profile.id} requires an account ID`);
    const secretReference = this.secrets.put(
      serializeOpenAICompatibleCredential({
        apiKey: parsed.apiKey,
        ...(parsed.baseUrl === undefined ? {} : { baseUrl: parsed.baseUrl }),
        ...(parsed.accountId === undefined ? {} : { accountId: parsed.accountId }),
      }),
    );
    const timestamp = this.now().toISOString();
    try {
      return this.repository.createProviderConnection({
        id: `${profile.id}:${this.id()}`,
        providerId: profile.id,
        runtimeKind: 'openai_compatible',
        displayName: parsed.displayName,
        enabled: true,
        secretReference,
        verification: {
          status: 'unverified',
          verifiedAt: null,
          expiresAt: null,
          message: null,
        },
        rateLimit: {
          mode: 'auto',
          maxConcurrentRequests: 2,
          requestsPerMinute: null,
          tokensPerMinute: null,
          lastObservedRateLimitHeaders: null,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    } catch (error) {
      this.secrets.delete(secretReference);
      throw error;
    }
  }
}

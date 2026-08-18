import { randomUUID } from 'node:crypto';
import {
  anthropicConnectionCreateInputSchema,
  geminiConnectionCreateInputSchema,
  openAIConnectionCreateInputSchema,
  openRouterConnectionCreateInputSchema,
  orcaRouterConnectionCreateInputSchema,
  providerProfileConnectionCreateInputSchema,
  xAIConnectionCreateInputSchema,
  type AnthropicConnectionCreateInput,
  type GeminiConnectionCreateInput,
  type OpenAIConnectionCreateInput,
  type OpenRouterConnectionCreateInput,
  type OrcaRouterConnectionCreateInput,
  type ProviderConnection,
  type ProviderProfileConnectionCreateInput,
  type XAIConnectionCreateInput,
} from '@sprint-coder/contracts';
import { serializeOpenAICredential, type OpenAICredential } from './openai-provider-client';
import { serializeAnthropicCredential } from './anthropic-provider-client';
import { serializeGeminiCredential } from './gemini-provider-client';
import { serializeXAICredential } from './xai-provider-client';
import {
  parseOpenAICompatibleCredential,
  resolveProfileBaseUrl,
  serializeOpenAICompatibleCredential,
  type OpenAICompatibleCredential,
  type ProviderProfileRegistry,
} from './provider-profile';
import {
  isPreparedProviderEndpoint,
  type PreparedProviderEndpoint,
} from './provider-endpoint-policy';

export interface ProviderConnectionRepository {
  listProviderConnections(): readonly ProviderConnection[];
  createProviderConnection(connection: ProviderConnection): ProviderConnection;
  setProviderConnectionSecretReference?(
    connectionId: string,
    secretReference: string | null,
  ): ProviderConnection;
}

export interface ProviderConnectionSecretWriter {
  put(secret: string): string;
  get?(reference: string): string;
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

  createOrcaRouter(input: OrcaRouterConnectionCreateInput): ProviderConnection {
    const parsed = orcaRouterConnectionCreateInputSchema.parse(input);
    const secretReference = this.secrets.put(serializeOpenAICredential({ apiKey: parsed.apiKey }));
    const timestamp = this.now().toISOString();
    try {
      return this.repository.createProviderConnection({
        id: `orcarouter:${this.id()}`,
        providerId: 'orcarouter',
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

  createProfile(
    input: ProviderProfileConnectionCreateInput,
    endpointApproval?: PreparedProviderEndpoint,
  ): ProviderConnection {
    const parsed = providerProfileConnectionCreateInputSchema.parse(input);
    if (this.profiles === undefined) throw new Error('Provider Profile Registry is not configured');
    const profile = this.profiles.get(parsed.profileId);
    if (parsed.baseUrl !== undefined && !profile.baseUrlConfigurable)
      throw new Error(`Provider Profile ${profile.id} does not allow a custom base URL`);
    for (const field of profile.requiredCredentialFields)
      if (field === 'api_key' && parsed.apiKey === undefined)
        throw new Error(`Provider Profile ${profile.id} requires an API key`);
      else if (field === 'account_id' && parsed.accountId === undefined)
        throw new Error(`Provider Profile ${profile.id} requires an account ID`);
    const credential: OpenAICompatibleCredential = {
      ...(parsed.apiKey === undefined ? {} : { apiKey: parsed.apiKey }),
      ...(parsed.baseUrl === undefined ? {} : { baseUrl: parsed.baseUrl }),
      ...(parsed.accountId === undefined ? {} : { accountId: parsed.accountId }),
      ...(endpointApproval === undefined ? {} : { endpointDigest: endpointApproval.digest }),
      ...(endpointApproval?.trust === 'trusted-local'
        ? { localConsentDigest: endpointApproval.digest }
        : {}),
    };
    // Validate the effective endpoint before writing either the credential envelope or Connection.
    // This prevents an insecure LAN HTTP URL from surviving as a permanently unavailable record.
    const canonicalBaseUrl = resolveProfileBaseUrl(profile, credential);
    if (endpointApproval === undefined)
      throw new Error('Provider endpoint requires a confirmed endpoint approval');
    if (!isPreparedProviderEndpoint(endpointApproval))
      throw new Error('Provider endpoint approval is not policy-issued');
    if (
      endpointApproval.canonicalUrl.replace(/\/+$/u, '') !== canonicalBaseUrl ||
      (endpointApproval.trust === 'trusted-local' &&
        endpointApproval.digest !== credential.localConsentDigest)
    )
      throw new Error('Provider endpoint approval does not match the effective endpoint');
    const secretReference = this.secrets.put(serializeOpenAICompatibleCredential(credential));
    const timestamp = this.now().toISOString();
    try {
      return this.repository.createProviderConnection({
        id: `${profile.id}:${this.id()}`,
        providerId: profile.id,
        runtimeKind: 'openai_compatible',
        displayName: parsed.displayName,
        enabled: true,
        automaticModelRelease: profile.nativeModelLifecycle === 'ollama',
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

  confirmExistingProfileEndpoint(
    connectionId: string,
    endpointApproval: PreparedProviderEndpoint,
  ): ProviderConnection {
    if (!isPreparedProviderEndpoint(endpointApproval))
      throw new Error('Provider endpoint approval is not policy-issued');
    const connection = this.repository
      .listProviderConnections()
      .find((candidate) => candidate.id === connectionId);
    if (connection === undefined) throw new Error('Provider Connection was not found');
    if (connection.runtimeKind !== 'openai_compatible' || connection.secretReference === null)
      throw new Error('Provider Connection does not use a Profile credential');
    if (
      this.profiles === undefined ||
      this.secrets.get === undefined ||
      this.repository.setProviderConnectionSecretReference === undefined
    )
      throw new Error('Provider endpoint credential migration is unavailable');
    const profile = this.profiles.get(connection.providerId);
    const credential = parseOpenAICompatibleCredential(
      this.secrets.get(connection.secretReference),
    );
    const canonicalBaseUrl = resolveProfileBaseUrl(profile, credential);
    if (endpointApproval.canonicalUrl.replace(/\/+$/u, '') !== canonicalBaseUrl)
      throw new Error('Provider endpoint approval does not match the existing endpoint');
    const updatedCredential: OpenAICompatibleCredential = {
      ...(credential.apiKey === undefined ? {} : { apiKey: credential.apiKey }),
      ...(credential.baseUrl === undefined ? {} : { baseUrl: credential.baseUrl }),
      ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }),
      endpointDigest: endpointApproval.digest,
      ...(endpointApproval.trust === 'trusted-local'
        ? { localConsentDigest: endpointApproval.digest }
        : {}),
    };
    const newReference = this.secrets.put(serializeOpenAICompatibleCredential(updatedCredential));
    let updated: ProviderConnection;
    try {
      updated = this.repository.setProviderConnectionSecretReference(connection.id, newReference);
    } catch (error) {
      this.secrets.delete(newReference);
      throw error;
    }
    try {
      this.secrets.delete(connection.secretReference);
    } catch {
      // The new reference is already committed. A stale encrypted blob is safer than rolling the
      // Connection back to an endpoint credential that no longer carries the verified digest.
    }
    return updated;
  }
}

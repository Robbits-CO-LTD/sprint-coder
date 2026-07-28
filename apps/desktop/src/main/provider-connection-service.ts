import { randomUUID } from 'node:crypto';
import {
  openAIConnectionCreateInputSchema,
  openRouterConnectionCreateInputSchema,
  type OpenAIConnectionCreateInput,
  type OpenRouterConnectionCreateInput,
  type ProviderConnection,
} from '@sprint-coder/contracts';
import {
  serializeOpenAICredential,
  type OpenAICredential,
} from './openai-provider-client';

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
  ) {}

  list(): readonly ProviderConnection[] {
    return this.repository.listProviderConnections();
  }

  createOpenAI(input: OpenAIConnectionCreateInput): ProviderConnection {
    const parsed = openAIConnectionCreateInputSchema.parse(input);
    const credential: OpenAICredential = {
      apiKey: parsed.apiKey,
      ...(parsed.organizationId === undefined
        ? {}
        : { organizationId: parsed.organizationId }),
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
    const secretReference = this.secrets.put(
      serializeOpenAICredential({ apiKey: parsed.apiKey }),
    );
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
}

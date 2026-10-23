import type { ModelSelection, ProviderConnection } from '@sprint-coder/contracts';

export const LOCAL_PROVIDER_TEST_SELECTION: ModelSelection = {
  connectionId: 'localai:test',
  requestedProvider: 'localai',
  requestedModel: 'test-model',
};

export function localProviderTestConnection(): ProviderConnection {
  return {
    id: 'localai:test',
    providerId: 'localai',
    runtimeKind: 'openai_compatible',
    displayName: 'LocalAI test',
    enabled: true,
    secretReference: null,
    verification: { status: 'not_required', verifiedAt: null, expiresAt: null, message: null },
    rateLimit: {
      mode: 'bypass',
      maxConcurrentRequests: null,
      requestsPerMinute: null,
      tokensPerMinute: null,
      lastObservedRateLimitHeaders: null,
    },
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
  };
}

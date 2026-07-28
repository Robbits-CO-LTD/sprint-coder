import { describe, expect, it } from 'vitest';
import type { ProviderConnection } from '@sprint-coder/contracts';
import {
  DeterministicMockProviderRuntime,
  MainProviderRegistry,
  type ProviderRuntime,
} from './provider-runtime';
import {
  ProviderVerificationService,
  ProviderVerificationTimeoutError,
} from './provider-verification';

function externalConnection(): ProviderConnection {
  return {
    id: 'connection:mock-api',
    providerId: 'mock',
    runtimeKind: 'official_api',
    displayName: 'Mock API',
    enabled: true,
    secretReference: 'provider-secret:123e4567-e89b-42d3-a456-426614174000',
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
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
  };
}

describe('ProviderVerificationService', () => {
  it('verifies before execution and expires the result after 24 hours', async () => {
    let connection = externalConnection();
    let now = new Date('2026-07-28T00:00:00.000Z');
    const repository = {
      getProviderConnection: () => connection,
      updateProviderConnectionVerification: (
        _connectionId: string,
        verification: ProviderConnection['verification'],
      ) => (connection = { ...connection, verification }),
    };
    const registry = new MainProviderRegistry();
    registry.register({
      runtimeKind: 'official_api',
      providerId: null,
      runtime: new DeterministicMockProviderRuntime(),
    });
    const service = new ProviderVerificationService(repository, registry, () => now);

    expect((await service.requireVerifiedForExecution(connection.id)).verification).toMatchObject({
      status: 'verified',
      expiresAt: '2026-07-29T00:00:00.000Z',
    });
    now = new Date('2026-07-29T00:00:00.001Z');
    expect(service.getConnection(connection.id).verification.status).toBe(
      'verification_expired',
    );
  });

  it('blocks on preflight timeout without classifying it as invalid credentials', async () => {
    const connection = externalConnection();
    const repository = {
      getProviderConnection: () => connection,
      updateProviderConnectionVerification: () => connection,
    };
    const hangingRuntime: ProviderRuntime = {
      verify: () => new Promise(() => undefined),
      listModels: async () => [],
      execute: async function* () {
        yield { type: 'completed', stopReason: null };
      },
      cancel: async () => undefined,
    };
    const registry = new MainProviderRegistry();
    registry.register({ runtimeKind: 'official_api', providerId: null, runtime: hangingRuntime });
    const service = new ProviderVerificationService(repository, registry, () => new Date(), 100, 1);

    await expect(service.requireVerifiedForExecution(connection.id)).rejects.toBeInstanceOf(
      ProviderVerificationTimeoutError,
    );
    expect(connection.verification.status).toBe('unverified');
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { ProviderConnection } from '@sprint-coder/contracts';
import {
  DeterministicMockProviderRuntime,
  MainProviderRegistry,
  type ProviderRuntime,
} from './provider-runtime';
import { ProviderVerificationService } from './provider-verification';

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
  it('does not run or persist a pre-aborted verification', async () => {
    let connection = externalConnection();
    const updateProviderConnectionVerification = vi.fn(
      (_connectionId: string, verification: ProviderConnection['verification']) =>
        (connection = { ...connection, verification }),
    );
    const verify = vi.fn(async () => ({
      status: 'verified' as const,
      verifiedAt: '2026-07-28T00:00:00.000Z',
      expiresAt: '2026-07-29T00:00:00.000Z',
      message: null,
    }));
    const registry = new MainProviderRegistry();
    registry.register({
      runtimeKind: 'official_api',
      providerId: null,
      runtime: {
        verify,
        listModels: async () => [],
        execute: async function* () {
          yield { type: 'completed' as const, stopReason: null };
        },
        cancel: async () => undefined,
      },
    });
    const service = new ProviderVerificationService(
      {
        getProviderConnection: () => connection,
        updateProviderConnectionVerification,
      },
      registry,
    );
    const controller = new AbortController();
    controller.abort();

    await expect(service.verify(connection, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(verify).not.toHaveBeenCalled();
    expect(updateProviderConnectionVerification).not.toHaveBeenCalled();
    expect(connection.verification.status).toBe('unverified');
  });

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
    expect(service.getConnection(connection.id).verification.status).toBe('verification_expired');
  });

  it('blocks on preflight timeout without classifying it as invalid credentials', async () => {
    let connection = externalConnection();
    const repository = {
      getProviderConnection: () => connection,
      updateProviderConnectionVerification: (
        _connectionId: string,
        verification: ProviderConnection['verification'],
      ) => (connection = { ...connection, verification }),
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

    await expect(service.requireVerifiedForExecution(connection.id)).rejects.toThrow(
      'Provider connection verification timed out',
    );
    expect(connection.verification).toMatchObject({
      status: 'unavailable',
      expiresAt: null,
      message: 'Provider connection verification timed out',
    });
  });
});

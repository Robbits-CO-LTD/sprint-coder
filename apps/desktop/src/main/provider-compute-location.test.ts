import { describe, expect, it } from 'vitest';
import type { ProviderConnection, ProviderProfile } from '@sprint-coder/contracts';
import {
  providerComputeLocation,
  providerConnectionView,
  providerModelCatalogAccessType,
  type ProviderProfileLookup,
} from './provider-compute-location';

function connection(
  runtimeKind: ProviderConnection['runtimeKind'],
  providerId = 'example',
): ProviderConnection {
  return {
    id: `${providerId}:connection`,
    providerId,
    runtimeKind,
    displayName: 'Example',
    enabled: true,
    secretReference: null,
    verification: {
      status: 'not_required',
      verifiedAt: null,
      expiresAt: null,
      message: null,
    },
    rateLimit: {
      mode: 'auto',
      maxConcurrentRequests: 1,
      requestsPerMinute: null,
      tokensPerMinute: null,
      lastObservedRateLimitHeaders: null,
    },
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
  };
}

function profiles(entries: Readonly<Record<string, 'cloud' | 'local'>>): ProviderProfileLookup {
  return {
    get: (profileId) => {
      const computeLocation = entries[profileId];
      if (computeLocation === undefined) throw new Error('Profile not found');
      return { computeLocation } satisfies Pick<ProviderProfile, 'computeLocation'>;
    },
  };
}

describe('Provider compute location', () => {
  it('keeps built-in subscriptions and official APIs in cloud regardless of endpoint metadata', () => {
    const lookup = profiles({ example: 'local' });
    const builtin = connection('builtin_cli');
    const official = connection('official_api');

    expect(providerComputeLocation(builtin, lookup)).toBe('cloud');
    expect(providerModelCatalogAccessType(builtin, lookup)).toBe('subscription');
    expect(providerComputeLocation(official, lookup)).toBe('cloud');
    expect(providerModelCatalogAccessType(official, lookup)).toBe('api');
  });

  it('uses only explicit Profile metadata to classify an OpenAI-compatible connection as local', () => {
    const local = connection('openai_compatible', 'ollama');
    const cloud = connection('openai_compatible', 'mistral');
    const lookup = profiles({ ollama: 'local', mistral: 'cloud' });

    expect(providerComputeLocation(local, lookup)).toBe('local');
    expect(providerModelCatalogAccessType(local, lookup)).toBe('local');
    expect(providerComputeLocation(cloud, lookup)).toBe('cloud');
    expect(providerModelCatalogAccessType(cloud, lookup)).toBe('api');
  });

  it('defaults an unknown or legacy Profile to cloud and API', () => {
    const legacy = connection('openai_compatible', 'missing-profile');
    const lookup = profiles({});

    expect(providerComputeLocation(legacy, lookup)).toBe('cloud');
    expect(providerModelCatalogAccessType(legacy, lookup)).toBe('api');
  });

  it('returns an additive view without mutating persisted Connection data', () => {
    const persisted = connection('openai_compatible', 'ollama');
    const view = providerConnectionView(persisted, profiles({ ollama: 'local' }));

    expect(view).toEqual({ ...persisted, computeLocation: 'local' });
    expect(persisted).not.toHaveProperty('computeLocation');
  });

  it('classifies the in-process mock as local without exposing it as a subscription', () => {
    const mock = connection('mock');

    expect(providerComputeLocation(mock, profiles({}))).toBe('local');
    expect(providerModelCatalogAccessType(mock, profiles({}))).toBe('local');
  });
});

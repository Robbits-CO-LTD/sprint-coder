import { describe, expect, it } from 'vitest';
import type { ProviderConnection } from '@sprint-coder/contracts';
import { ProviderConnectionService } from './provider-connection-service';
import { parseOpenAICredential } from './openai-provider-client';
import {
  MainProviderProfileRegistry,
  parseOpenAICompatibleCredential,
} from './provider-profile';
import { PACK_A_PROVIDER_PROFILES } from './bundled-provider-profiles';

describe('ProviderConnectionService', () => {
  it('stores credentials outside the Connection record and applies safe API limits', () => {
    const storedSecrets = new Map<string, string>();
    const connections: ProviderConnection[] = [];
    const service = new ProviderConnectionService(
      {
        listProviderConnections: () => connections,
        createProviderConnection: (connection) => {
          connections.push(connection);
          return connection;
        },
      },
      {
        put: (secret) => {
          storedSecrets.set('provider-secret:00000000-0000-4000-8000-000000000001', secret);
          return 'provider-secret:00000000-0000-4000-8000-000000000001';
        },
        delete: (reference) => void storedSecrets.delete(reference),
      },
      () => new Date('2026-07-28T03:00:00.000Z'),
      () => '00000000-0000-4000-8000-000000000002',
    );

    const connection = service.createOpenAI({
      displayName: 'Work OpenAI',
      apiKey: 'secret-canary',
      organizationId: 'org_test',
      projectId: 'proj_test',
    });

    expect(connection).toMatchObject({
      id: 'openai:00000000-0000-4000-8000-000000000002',
      providerId: 'openai',
      runtimeKind: 'official_api',
      secretReference: 'provider-secret:00000000-0000-4000-8000-000000000001',
      verification: { status: 'unverified' },
      rateLimit: { mode: 'auto', maxConcurrentRequests: 2 },
    });
    expect(JSON.stringify(connection)).not.toContain('secret-canary');
    expect(
      parseOpenAICredential(
        storedSecrets.get('provider-secret:00000000-0000-4000-8000-000000000001') ?? '',
      ),
    ).toEqual({
      apiKey: 'secret-canary',
      organizationId: 'org_test',
      projectId: 'proj_test',
    });
  });

  it('removes the new secret if the DB write fails', () => {
    let deleted: string | null = null;
    const service = new ProviderConnectionService(
      {
        listProviderConnections: () => [],
        createProviderConnection: () => {
          throw new Error('db failed');
        },
      },
      {
        put: () => 'provider-secret:00000000-0000-4000-8000-000000000001',
        delete: (reference) => {
          deleted = reference;
        },
      },
    );

    expect(() =>
      service.createOpenAI({ displayName: 'OpenAI', apiKey: 'secret-canary' }),
    ).toThrow('db failed');
    expect(deleted).toBe('provider-secret:00000000-0000-4000-8000-000000000001');
  });

  it('creates an OpenRouter Connection with a Main-only secret reference', () => {
    const stored: string[] = [];
    const service = new ProviderConnectionService(
      {
        listProviderConnections: () => [],
        createProviderConnection: (connection) => connection,
      },
      {
        put: (secret) => {
          stored.push(secret);
          return 'provider-secret:00000000-0000-4000-8000-000000000003';
        },
        delete: () => undefined,
      },
      () => new Date('2026-07-28T00:00:00.000Z'),
      () => 'connection-3',
    );

    const connection = service.createOpenRouter({
      displayName: 'OpenRouter',
      apiKey: 'openrouter-secret',
    });

    expect(connection).toMatchObject({
      id: 'openrouter:connection-3',
      providerId: 'openrouter',
      runtimeKind: 'official_api',
      secretReference: 'provider-secret:00000000-0000-4000-8000-000000000003',
      rateLimit: { mode: 'auto', maxConcurrentRequests: 2 },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toContain('openrouter-secret');
  });

  it.each(PACK_A_PROVIDER_PROFILES)(
    'creates the $displayName Connection through the shared Profile path',
    (profile) => {
      const stored: string[] = [];
      const profiles = new MainProviderProfileRegistry();
      for (const candidate of PACK_A_PROVIDER_PROFILES) profiles.register(candidate);
      const service = new ProviderConnectionService(
        {
          listProviderConnections: () => [],
          createProviderConnection: (connection) => connection,
        },
        {
          put: (secret) => {
            stored.push(secret);
            return 'provider-secret:00000000-0000-4000-8000-000000000004';
          },
          delete: () => undefined,
        },
        () => new Date('2026-07-28T00:00:00.000Z'),
        () => 'connection-4',
        profiles,
      );

      const connection = service.createProfile({
        profileId: profile.id,
        displayName: profile.displayName,
        apiKey: 'profile-secret',
      });

      expect(connection).toMatchObject({
        id: `${profile.id}:connection-4`,
        providerId: profile.id,
        runtimeKind: 'openai_compatible',
        rateLimit: { mode: 'auto', maxConcurrentRequests: 2 },
      });
      expect(JSON.stringify(connection)).not.toContain('profile-secret');
      expect(parseOpenAICompatibleCredential(stored[0] ?? '')).toEqual({
        apiKey: 'profile-secret',
      });
    },
  );
});

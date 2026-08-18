import { describe, expect, it } from 'vitest';
import type { ProviderConnection } from '@sprint-coder/contracts';
import { ProviderConnectionService } from './provider-connection-service';
import { parseOpenAICredential } from './openai-provider-client';
import { MainProviderProfileRegistry, parseOpenAICompatibleCredential } from './provider-profile';
import { LOCAL_PROVIDER_PROFILES, PACK_A_PROVIDER_PROFILES } from './bundled-provider-profiles';
import { ProviderEndpointPolicy } from './provider-endpoint-policy';

describe('ProviderConnectionService', () => {
  const endpointPolicy = new ProviderEndpointPolicy(async (hostname) => [
    hostname === 'localhost'
      ? { address: '127.0.0.1', family: 4 }
      : { address: '8.8.8.8', family: 4 },
  ]);

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

    expect(() => service.createOpenAI({ displayName: 'OpenAI', apiKey: 'secret-canary' })).toThrow(
      'db failed',
    );
    expect(deleted).toBe('provider-secret:00000000-0000-4000-8000-000000000001');

    deleted = null;
    expect(() =>
      service.createOrcaRouter({ displayName: 'OrcaRouter', apiKey: 'orca-secret-canary' }),
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

  it('creates an independent OrcaRouter Connection with a Main-only secret reference', () => {
    const stored: string[] = [];
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
      () => new Date('2026-08-18T00:00:00.000Z'),
      () => 'connection-4',
    );

    const connection = service.createOrcaRouter({
      displayName: 'OrcaRouter',
      apiKey: 'orca-secret',
    });

    expect(connection).toMatchObject({
      id: 'orcarouter:connection-4',
      providerId: 'orcarouter',
      runtimeKind: 'official_api',
      secretReference: 'provider-secret:00000000-0000-4000-8000-000000000004',
      rateLimit: { mode: 'auto', maxConcurrentRequests: 2 },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toContain('orca-secret');
  });

  it.each(PACK_A_PROVIDER_PROFILES)(
    'creates the $displayName Connection through the shared Profile path',
    async (profile) => {
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

      const endpoint = await endpointPolicy.prepareBaseUrl(profile.baseUrl);
      const connection = service.createProfile(
        {
          profileId: profile.id,
          displayName: profile.displayName,
          apiKey: 'profile-secret',
        },
        endpoint,
      );

      expect(connection).toMatchObject({
        id: `${profile.id}:connection-4`,
        providerId: profile.id,
        runtimeKind: 'openai_compatible',
        rateLimit: { mode: 'auto', maxConcurrentRequests: 2 },
      });
      expect(JSON.stringify(connection)).not.toContain('profile-secret');
      expect(parseOpenAICompatibleCredential(stored[0] ?? '')).toMatchObject({
        apiKey: 'profile-secret',
        endpointDigest: endpoint.digest,
      });
    },
  );

  it.each(LOCAL_PROVIDER_PROFILES)(
    'creates the $displayName Connection without inventing an API key',
    async (profile) => {
      const stored: string[] = [];
      const profiles = new MainProviderProfileRegistry();
      profiles.register(profile);
      const service = new ProviderConnectionService(
        {
          listProviderConnections: () => [],
          createProviderConnection: (connection) => connection,
        },
        {
          put: (secret) => {
            stored.push(secret);
            return 'provider-secret:00000000-0000-4000-8000-000000000005';
          },
          delete: () => undefined,
        },
        () => new Date('2026-07-30T00:00:00.000Z'),
        () => 'local-connection',
        profiles,
      );

      const endpoint = await endpointPolicy.prepareBaseUrl(profile.baseUrl);
      const connection = service.createProfile(
        {
          profileId: profile.id,
          displayName: profile.displayName,
        },
        endpoint,
      );

      expect(connection).toMatchObject({
        id: `${profile.id}:local-connection`,
        providerId: profile.id,
        runtimeKind: 'openai_compatible',
        secretReference: 'provider-secret:00000000-0000-4000-8000-000000000005',
        automaticModelRelease: profile.id === 'ollama',
      });
      expect(parseOpenAICompatibleCredential(stored[0] ?? '')).toMatchObject({
        endpointDigest: endpoint.digest,
        localConsentDigest: endpoint.digest,
      });
    },
  );

  it('persists exact local endpoint consent only when the prepared digest matches', async () => {
    const stored: string[] = [];
    const profiles = new MainProviderProfileRegistry();
    const profile = LOCAL_PROVIDER_PROFILES[0]!;
    profiles.register(profile);
    const service = new ProviderConnectionService(
      {
        listProviderConnections: () => [],
        createProviderConnection: (connection) => connection,
      },
      {
        put: (secret) => {
          stored.push(secret);
          return 'provider-secret:local-consent';
        },
        delete: () => undefined,
      },
      undefined,
      undefined,
      profiles,
    );
    const endpoint = await new ProviderEndpointPolicy(async () => [
      { address: '127.0.0.1', family: 4 },
    ]).prepareBaseUrl(profile.baseUrl);

    service.createProfile(
      { profileId: profile.id, displayName: 'Consented Local Provider' },
      endpoint,
    );

    expect(parseOpenAICompatibleCredential(stored[0]!)).toMatchObject({
      endpointDigest: endpoint.digest,
      localConsentDigest: endpoint.digest,
    });
    expect(() =>
      service.createProfile(
        { profileId: profile.id, displayName: 'Wrong endpoint' },
        { ...endpoint, canonicalUrl: 'http://localhost:9999/v1' },
      ),
    ).toThrow('does not match');
    expect(() =>
      service.createProfile(
        { profileId: profile.id, displayName: 'Forged endpoint' },
        JSON.parse(JSON.stringify(endpoint)) as typeof endpoint,
      ),
    ).toThrow('not policy-issued');
  });

  it('replaces an existing Profile credential only after endpoint revalidation', async () => {
    const profiles = new MainProviderProfileRegistry();
    const profile = LOCAL_PROVIDER_PROFILES[0]!;
    profiles.register(profile);
    const connections: ProviderConnection[] = [];
    const secrets = new Map<string, string>();
    let sequence = 0;
    const service = new ProviderConnectionService(
      {
        listProviderConnections: () => connections,
        createProviderConnection: (connection) => {
          connections.push(connection);
          return connection;
        },
        setProviderConnectionSecretReference: (connectionId, secretReference) => {
          const index = connections.findIndex(({ id }) => id === connectionId);
          const current = connections[index];
          if (current === undefined) throw new Error('missing');
          const updated = { ...current, secretReference };
          connections[index] = updated;
          return updated;
        },
      },
      {
        put: (secret) => {
          const reference = `provider-secret:00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
          secrets.set(reference, secret);
          return reference;
        },
        get: (reference) => secrets.get(reference) ?? '',
        delete: (reference) => void secrets.delete(reference),
      },
      undefined,
      () => 'existing-profile',
      profiles,
    );
    const endpoint = await endpointPolicy.prepareBaseUrl(profile.baseUrl);
    const created = service.createProfile(
      { profileId: profile.id, displayName: 'Existing Local Provider' },
      endpoint,
    );
    secrets.set(created.secretReference!, '{}');
    const oldReference = created.secretReference!;

    const updated = service.confirmExistingProfileEndpoint(created.id, endpoint);

    expect(updated.secretReference).not.toBe(oldReference);
    expect(secrets.has(oldReference)).toBe(false);
    expect(parseOpenAICompatibleCredential(secrets.get(updated.secretReference!)!)).toMatchObject({
      endpointDigest: endpoint.digest,
      localConsentDigest: endpoint.digest,
    });
  });

  it('rejects a cloud Profile before storing when its required API key is absent', () => {
    let stored = false;
    const profiles = new MainProviderProfileRegistry();
    profiles.register(PACK_A_PROVIDER_PROFILES[0]!);
    const service = new ProviderConnectionService(
      {
        listProviderConnections: () => [],
        createProviderConnection: (connection) => connection,
      },
      {
        put: () => {
          stored = true;
          return 'provider-secret:00000000-0000-4000-8000-000000000006';
        },
        delete: () => undefined,
      },
      undefined,
      undefined,
      profiles,
    );

    expect(() =>
      service.createProfile({
        profileId: PACK_A_PROVIDER_PROFILES[0]!.id,
        displayName: PACK_A_PROVIDER_PROFILES[0]!.displayName,
      }),
    ).toThrow('requires an API key');
    expect(stored).toBe(false);
  });

  it('rejects a valid Profile before storing when endpoint approval is bypassed', () => {
    let stored = false;
    const profiles = new MainProviderProfileRegistry();
    profiles.register(PACK_A_PROVIDER_PROFILES[0]!);
    const service = new ProviderConnectionService(
      {
        listProviderConnections: () => [],
        createProviderConnection: (connection) => connection,
      },
      {
        put: () => {
          stored = true;
          return 'provider-secret:bypass';
        },
        delete: () => undefined,
      },
      undefined,
      undefined,
      profiles,
    );

    expect(() =>
      service.createProfile({
        profileId: PACK_A_PROVIDER_PROFILES[0]!.id,
        displayName: 'Bypass',
        apiKey: 'secret',
      }),
    ).toThrow('requires a confirmed endpoint approval');
    expect(stored).toBe(false);
  });

  it('rejects LAN HTTP before storing a local Profile Connection', () => {
    let stored = false;
    const profiles = new MainProviderProfileRegistry();
    profiles.register(LOCAL_PROVIDER_PROFILES[0]!);
    const service = new ProviderConnectionService(
      {
        listProviderConnections: () => [],
        createProviderConnection: (connection) => connection,
      },
      {
        put: () => {
          stored = true;
          return 'provider-secret:00000000-0000-4000-8000-000000000007';
        },
        delete: () => undefined,
      },
      undefined,
      undefined,
      profiles,
    );

    expect(() =>
      service.createProfile({
        profileId: LOCAL_PROVIDER_PROFILES[0]!.id,
        displayName: 'LAN LocalAI',
        baseUrl: 'http://192.168.1.20:8080/v1',
      }),
    ).toThrow('must use HTTPS or loopback HTTP');
    expect(stored).toBe(false);
  });
});

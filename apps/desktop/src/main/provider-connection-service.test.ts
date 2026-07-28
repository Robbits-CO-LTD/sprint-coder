import { describe, expect, it } from 'vitest';
import type { ProviderConnection } from '@sprint-coder/contracts';
import { ProviderConnectionService } from './provider-connection-service';
import { parseOpenAICredential } from './openai-provider-client';

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
});

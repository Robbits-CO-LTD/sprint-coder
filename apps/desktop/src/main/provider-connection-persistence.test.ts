import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePersistenceClient } from './persistence';

let directory: string | null = null;

afterEach(() => {
  if (directory !== null) rmSync(directory, { recursive: true, force: true });
  directory = null;
});

describe('Provider Connection persistence', () => {
  it.runIf(process.env['SPRINT_CODER_ELECTRON_DB_TEST'] === '1')(
    'persists an external Connection without storing credential bytes',
    () => {
    directory = mkdtempSync(join(tmpdir(), 'sprint-coder-provider-connection-'));
    const path = join(directory, 'app.sqlite3');
    const persistence = new SqlitePersistenceClient(path);
    persistence.createProviderConnection({
      id: 'openai:primary',
      providerId: 'openai',
      runtimeKind: 'official_api',
      displayName: 'OpenAI API',
      enabled: true,
      secretReference: 'provider-secret:00000000-0000-4000-8000-000000000001',
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
      createdAt: '2026-07-28T03:00:00.000Z',
      updatedAt: '2026-07-28T03:00:00.000Z',
    });
    persistence.close();

    const reopened = new SqlitePersistenceClient(path);
    expect(reopened.getProviderConnection('openai:primary')).toMatchObject({
      providerId: 'openai',
      runtimeKind: 'official_api',
      displayName: 'OpenAI API',
      secretReference: 'provider-secret:00000000-0000-4000-8000-000000000001',
      rateLimit: { maxConcurrentRequests: 2 },
    });
    reopened.close();
    },
  );
});

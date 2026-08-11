import { describe, expect, it } from 'vitest';
import { SecureLogger, type SecureLogEntry } from './secure-logger';

describe('SecureLogger', () => {
  it('redacts structured headers, bodies, URLs, and Error details in the sink', () => {
    const entries: SecureLogEntry[] = [];
    const logger = new SecureLogger((entry) => entries.push(entry));
    const canary = 'SPRINT_CODER_SECRET_CANARY_7f91c';

    logger.error(
      'Provider request failed',
      {
        headers: {
          Authorization: `Bearer ${canary}`,
          'x-api-key': canary,
        },
        requestBody: { access_token: canary, prompt: 'safe' },
        url: `https://example.test/models?api_key=${canary}&page=1`,
        error: new Error(`token=${canary}`),
      },
      {
        category: 'chat',
        event: 'provider.request.failed',
        taskId: 'task-1',
        status: 'failed',
      },
    );

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(canary);
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).toContain('safe');
    expect(entries[0]).toMatchObject({
      category: 'chat',
      event: 'provider.request.failed',
      taskId: 'task-1',
      status: 'failed',
    });
  });
});

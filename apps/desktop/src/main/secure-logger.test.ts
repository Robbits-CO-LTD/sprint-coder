import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { combineLogSinks } from './persistent-log';
import { createConsoleLogSink, SecureLogger, type SecureLogEntry } from './secure-logger';

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

describe('console pipe lifecycle', () => {
  it.each(['stdout', 'stderr'] as const)(
    'stops writing a broken %s pipe without entering the uncaught exception logger',
    async (name) => {
      const writes = vi.fn();
      const failed = new Writable({
        write(_chunk, _encoding, callback) {
          writes();
          callback(Object.assign(new Error('Synthetic closed pipe'), { code: 'EPIPE' }));
        },
      });
      const healthyLines: string[] = [];
      const healthy = new Writable({
        write(chunk, _encoding, callback) {
          healthyLines.push(chunk.toString());
          callback();
        },
      });
      const entries: SecureLogEntry[] = [];
      const failures = vi.fn((stream: string, code: string) =>
        logger.error('Console pipe closed', { stream, code }),
      );
      const sink = createConsoleLogSink(
        name === 'stdout' ? failed : healthy,
        name === 'stderr' ? failed : healthy,
        failures,
      );
      const logger = new SecureLogger(combineLogSinks((entry) => entries.push(entry), sink));
      const writeFailed = () =>
        name === 'stdout' ? logger.info('Synthetic info') : logger.error('Synthetic error');
      writeFailed();
      await vi.waitFor(() => expect(failures).toHaveBeenCalledOnce());
      for (let i = 0; i < 20; i++) writeFailed();
      if (name === 'stdout') logger.error('Healthy stderr');
      else logger.info('Healthy stdout');
      expect(writes).toHaveBeenCalledOnce();
      expect(failures).toHaveBeenCalledWith(name, 'EPIPE');
      expect(entries).toHaveLength(23);
      expect(healthyLines.join('')).toContain(`Healthy ${name === 'stdout' ? 'stderr' : 'stdout'}`);
    },
  );

  it('handles synchronous closed-pipe failures once while retaining other errors', () => {
    const stdout = new Writable();
    const stderr = new Writable();
    const failures = vi.fn();
    const sink = createConsoleLogSink(stdout, stderr, failures);
    const logger = new SecureLogger(sink);
    const broken = vi.spyOn(stderr, 'write').mockImplementation(() => {
      throw Object.assign(new Error('Synthetic closed pipe'), { code: 'EPIPE' });
    });
    expect(() => logger.error('First')).not.toThrow();
    expect(() => logger.error('Second')).not.toThrow();
    expect(broken).toHaveBeenCalledOnce();
    expect(failures).toHaveBeenCalledOnce();
    const unexpected = new Error('Synthetic unexpected error');
    expect(() => stdout.emit('error', unexpected)).toThrow(unexpected);
    expect(failures).toHaveBeenCalledOnce();
  });
});

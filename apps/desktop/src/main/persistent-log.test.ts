import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { combineLogSinks, createPersistentLog } from './persistent-log';
import { SecureLogger } from './secure-logger';

describe('persistent diagnostic log', () => {
  it('writes redacted JSON lines to a private file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-log-'));
    const persistentLog = createPersistentLog(directory);
    const logger = new SecureLogger(persistentLog.sink);

    logger.error('Runtime failed', {
      authorization: 'Bearer SPRINT_CODER_SECRET_CANARY_123456789',
      correlationId: 'correlation-1',
    });

    const contents = readFileSync(persistentLog.filePath, 'utf8');
    expect(contents).not.toContain('SPRINT_CODER_SECRET_CANARY');
    expect(JSON.parse(contents)).toMatchObject({
      level: 'error',
      message: 'Runtime failed',
      context: { authorization: '[REDACTED]', correlationId: 'correlation-1' },
    });
    if (process.platform !== 'win32')
      expect(statSync(persistentLog.filePath).mode & 0o777).toBe(0o600);
  });

  it('keeps one previous file when the size limit is reached', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-log-'));
    const filePath = join(directory, 'sprint-coder.log');
    writeFileSync(filePath, 'old diagnostic data\n');

    const persistentLog = createPersistentLog(directory, 10);
    new SecureLogger(persistentLog.sink).info('new session');

    expect(readFileSync(join(directory, 'sprint-coder.previous.log'), 'utf8')).toBe(
      'old diagnostic data\n',
    );
    expect(readFileSync(filePath, 'utf8')).toContain('new session');
  });

  it('continues to the fallback sink when a sink fails', () => {
    const entries: unknown[] = [];
    const sink = combineLogSinks(
      () => {
        throw new Error('disk full');
      },
      (entry) => entries.push(entry),
    );

    new SecureLogger(sink).warn('Still observable');

    expect(entries).toHaveLength(1);
  });

  it('refuses to follow a symbolic link at the log path', () => {
    if (process.platform === 'win32') return;
    const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-log-'));
    const target = join(directory, 'target.txt');
    writeFileSync(target, 'keep me');
    symlinkSync(target, join(directory, 'sprint-coder.log'));

    expect(() => createPersistentLog(directory)).toThrow('not a regular file');
    expect(readFileSync(target, 'utf8')).toBe('keep me');
  });

  it('refuses to write through a symbolic log directory', () => {
    if (process.platform === 'win32') return;
    const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-log-'));
    const targetDirectory = join(directory, 'target');
    const logDirectory = join(directory, 'logs');
    mkdirSync(targetDirectory);
    symlinkSync(targetDirectory, logDirectory);

    expect(() => createPersistentLog(logDirectory)).toThrow('not a regular directory');
  });
});

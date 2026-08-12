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
import { combineLogSinks, createPersistentLog, resolveDiagnosticLogRoot } from './persistent-log';
import { SecureLogger } from './secure-logger';

describe('persistent diagnostic log', () => {
  it('resolves the product log root while preserving explicit test isolation', () => {
    expect(
      resolveDiagnosticLogRoot({
        homeDirectory: '/Users/alice',
        platform: 'darwin',
      }),
    ).toBe('/Users/alice/.sprintcoder/logs');
    expect(
      resolveDiagnosticLogRoot({
        homeDirectory: 'C:\\Users\\alice',
        platform: 'win32',
      }),
    ).toBe('C:\\Users\\alice\\.sprintcoder\\logs');
    expect(
      resolveDiagnosticLogRoot({
        homeDirectory: '/Users/alice',
        userDataOverride: '/tmp/e2e-user-data',
        platform: 'darwin',
      }),
    ).toBe('/tmp/e2e-user-data/logs');
  });

  it('routes redacted JSON lines to private category streams', () => {
    const root = mkdtempSync(join(tmpdir(), 'sprint-coder-log-'));
    const persistentLog = createPersistentLog(root);
    const logger = new SecureLogger(persistentLog.sink);

    logger.error(
      'Runtime failed',
      {
        authorization: 'Bearer SPRINT_CODER_SECRET_CANARY_123456789',
        correlationId: 'correlation-1',
      },
      {
        category: 'chat',
        event: 'turn.failed',
        taskId: 'task-1',
        turnId: 'turn-1',
        runtime: 'codex',
        provider: 'openai',
        status: 'failed',
      },
    );
    logger.info('Worker completed', undefined, {
      category: 'team',
      event: 'worker.completed',
      taskId: 'task-1',
      teamId: 'team-1',
      workerId: 'worker-1',
      status: 'completed',
    });

    const chatPath = join(root, 'chat', 'task-1.jsonl');
    const teamPath = join(root, 'team', 'team-team-1.jsonl');
    const chatContents = readFileSync(chatPath, 'utf8');
    expect(chatContents).not.toContain('SPRINT_CODER_SECRET_CANARY');
    expect(JSON.parse(chatContents)).toMatchObject({
      category: 'chat',
      event: 'turn.failed',
      status: 'failed',
      taskId: 'task-1',
      turnId: 'turn-1',
      runtime: 'codex',
      provider: 'openai',
      context: { authorization: '[REDACTED]', correlationId: 'correlation-1' },
    });
    expect(JSON.parse(readFileSync(teamPath, 'utf8'))).toMatchObject({
      category: 'team',
      event: 'worker.completed',
      teamId: 'team-1',
      workerId: 'worker-1',
    });
    expect(readFileSync(persistentLog.filePath, 'utf8')).toBe('');
    if (process.platform !== 'win32') {
      expect(statSync(chatPath).mode & 0o777).toBe(0o600);
      expect(statSync(join(root, 'chat')).mode & 0o777).toBe(0o700);
    }
  });

  it('uses a bounded fallback stream for an invalid or missing related id', () => {
    const root = mkdtempSync(join(tmpdir(), 'sprint-coder-log-'));
    const persistentLog = createPersistentLog(root);
    const logger = new SecureLogger(persistentLog.sink);

    logger.warn('Missing task id', undefined, { category: 'chat', event: 'turn.unknown' });
    logger.warn('Unsafe team id', undefined, {
      category: 'team',
      event: 'team.unknown',
      teamId: '../../escape',
    });

    expect(readFileSync(join(root, 'chat', 'unknown.jsonl'), 'utf8')).toContain('turn.unknown');
    expect(readFileSync(join(root, 'team', 'unknown.jsonl'), 'utf8')).toContain('team.unknown');
  });

  it('separates Team streams by Team, then Task, without namespace collisions', () => {
    const root = mkdtempSync(join(tmpdir(), 'sprint-coder-log-'));
    const logger = new SecureLogger(createPersistentLog(root).sink);

    logger.error('Team-bound failure', undefined, {
      category: 'team',
      event: 'turn.runtime.failed',
      taskId: 'same-id',
      teamId: 'same-id',
    });
    logger.error('Task-only failure A', undefined, {
      category: 'team',
      event: 'turn.runtime.failed',
      taskId: 'same-id',
    });
    logger.error('Task-only failure B', undefined, {
      category: 'team',
      event: 'turn.runtime.failed',
      taskId: 'other-task',
    });

    expect(readFileSync(join(root, 'team', 'team-same-id.jsonl'), 'utf8')).toContain(
      'Team-bound failure',
    );
    expect(readFileSync(join(root, 'team', 'task-same-id.jsonl'), 'utf8')).toContain(
      'Task-only failure A',
    );
    expect(readFileSync(join(root, 'team', 'task-other-task.jsonl'), 'utf8')).toContain(
      'Task-only failure B',
    );
  });

  it('keeps one previous file per stream when the size limit is reached', () => {
    const root = mkdtempSync(join(tmpdir(), 'sprint-coder-log-'));
    const chatDirectory = join(root, 'chat');
    mkdirSync(chatDirectory);
    const filePath = join(chatDirectory, 'task-1.jsonl');
    writeFileSync(filePath, 'old diagnostic data\n');

    const persistentLog = createPersistentLog(root, 10);
    new SecureLogger(persistentLog.sink).info('new session', undefined, {
      category: 'chat',
      event: 'turn.accepted',
      taskId: 'task-1',
    });

    expect(readFileSync(join(chatDirectory, 'task-1.previous.jsonl'), 'utf8')).toBe(
      'old diagnostic data\n',
    );
    expect(readFileSync(filePath, 'utf8')).toContain('new session');
  });

  it('bounds the number of Chat streams by pruning only the oldest regular log', () => {
    const root = mkdtempSync(join(tmpdir(), 'sprint-coder-log-'));
    const persistentLog = createPersistentLog(root, 5 * 1024 * 1024, 2);
    const logger = new SecureLogger(persistentLog.sink);
    for (const taskId of ['task-1', 'task-2', 'task-3'])
      logger.info('Turn accepted', undefined, {
        category: 'chat',
        event: 'turn.accepted',
        taskId,
      });

    expect(() => readFileSync(join(root, 'chat', 'task-1.jsonl'), 'utf8')).toThrow();
    expect(readFileSync(join(root, 'chat', 'task-2.jsonl'), 'utf8')).toContain('turn.accepted');
    expect(readFileSync(join(root, 'chat', 'task-3.jsonl'), 'utf8')).toContain('turn.accepted');
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

  it('refuses to follow a symbolic link at a category log path', () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'sprint-coder-log-'));
    const chatDirectory = join(root, 'chat');
    mkdirSync(chatDirectory);
    const target = join(root, 'target.txt');
    writeFileSync(target, 'keep me');
    symlinkSync(target, join(chatDirectory, 'task-1.jsonl'));

    const persistentLog = createPersistentLog(root);
    expect(() =>
      new SecureLogger(persistentLog.sink).error('blocked', undefined, {
        category: 'chat',
        event: 'turn.failed',
        taskId: 'task-1',
      }),
    ).toThrow('not a regular file');
    expect(readFileSync(target, 'utf8')).toBe('keep me');
  });

  it('refuses to write through a symbolic category directory', () => {
    if (process.platform === 'win32') return;
    const parent = mkdtempSync(join(tmpdir(), 'sprint-coder-log-'));
    const targetDirectory = join(parent, 'target');
    const root = join(parent, 'logs');
    mkdirSync(targetDirectory);
    mkdirSync(root);
    symlinkSync(targetDirectory, join(root, 'chat'));

    expect(() => createPersistentLog(root)).toThrow('not a regular directory');
  });
});

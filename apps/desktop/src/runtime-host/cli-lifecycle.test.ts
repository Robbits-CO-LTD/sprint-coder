import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type * as ChildProcessModule from 'node:child_process';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { ClaudeRuntimeAdapter } from './claude-adapter';
import { CodexRuntimeAdapter } from './codex-adapter';

const processMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcessModule>();
  processMock.spawn.mockImplementation(original.spawn);
  return { ...original, spawn: processMock.spawn };
});

it.each([
  ['usageLimitExceeded', 'RUNTIME_RATE_LIMIT', false],
  ['rateLimitExceeded', 'RUNTIME_RATE_LIMIT', false],
  ['unauthorized', 'RUNTIME_FAILED', false],
  ['serverOverloaded', 'RUNTIME_UNAVAILABLE', true],
  [{ httpConnectionFailed: { httpStatusCode: 503 } }, 'RUNTIME_UNAVAILABLE', true],
] as const)('classifies a failed Codex Turn with %j', async (codexErrorInfo, code, retryable) => {
  const root = await mkdtemp(join(tmpdir(), 'sprint-cli-failure-'));
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: 1,
    signalCode: null,
    pid: undefined,
  });
  processMock.spawn.mockReturnValueOnce(child);
  const adapter = new CodexRuntimeAdapter(500, 'fixture', [], root);
  const failed = vi.fn();
  try {
    adapter.start('failed-turn', 'test', [], vi.fn(), root, 'auto', vi.fn(), failed, vi.fn());
    child.stdout.write(
      JSON.stringify({
        method: 'turn/completed',
        params: {
          turn: {
            id: 'failed-turn',
            status: 'failed',
            error: {
              message: 'private provider text',
              codexErrorInfo,
              additionalDetails: null,
              misalignment: null,
            },
          },
        },
      }) + '\n',
    );
    expect(failed.mock.calls[0]?.[0]).toMatchObject({ code, retryable });
    expect(JSON.stringify(failed.mock.calls)).not.toContain('private provider text');
  } finally {
    child.emit('close', 1);
    adapter.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['claude', 'codex'] as const)(
  'handles %s stdin EPIPE without an uncaught exception',
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'sprint-cli-pipe-'));
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: 1,
      signalCode: null,
      pid: undefined,
    });
    processMock.spawn.mockReturnValueOnce(child);
    const adapter =
      kind === 'claude'
        ? new ClaudeRuntimeAdapter(500)
        : new CodexRuntimeAdapter(500, 'fixture', [], root);
    const exited = vi.fn();
    const failed = vi.fn();
    try {
      adapter.start('pipe-failure', 'test', [], vi.fn(), root, 'auto', vi.fn(), failed, exited);
      expect(() =>
        child.stdin.emit('error', Object.assign(new Error('pipe closed'), { code: 'EPIPE' })),
      ).not.toThrow();
    } finally {
      child.emit('close', 1);
      adapter.dispose();
      await rm(root, { recursive: true, force: true });
    }
    expect(exited).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledTimes(1);
  },
);

it.each(['claude', 'codex'] as const)('finalizes %s when spawning the CLI fails', async (kind) => {
  const root = await mkdtemp(join(tmpdir(), 'sprint-cli-lifecycle-'));
  const missing = join(root, 'missing-cli');
  const adapter =
    kind === 'claude'
      ? new ClaudeRuntimeAdapter(500)
      : new CodexRuntimeAdapter(500, missing, [], root);
  adapter.setCliResolution({
    executable: missing,
    source: 'explicit',
    version: 'fixture',
    compatibility: 'verified',
    capabilities: [],
  });
  const exited = vi.fn();
  const failed = vi.fn();
  try {
    adapter.start('spawn-failure', 'test', [], vi.fn(), root, 'auto', vi.fn(), failed, exited);
    await vi.waitFor(() => expect(failed).toHaveBeenCalled(), { timeout: 1000 });
    await vi.waitFor(() => expect(exited).toHaveBeenCalledTimes(1), { timeout: 1000 });
    expect(await adapter.cancel('spawn-failure')).toBe(false);
    expect(await readdir(root)).toEqual([]);
  } finally {
    adapter.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

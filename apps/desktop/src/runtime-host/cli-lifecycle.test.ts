import { copyFile, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import type * as ChildProcessModule from 'node:child_process';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { ClaudeRuntimeAdapter, resolveClaudeCommand } from './claude-adapter';
import { CodexRuntimeAdapter, resolveCodexCommand } from './codex-adapter';
import type * as OwnedCliProcess from './owned-cli-process';

const processMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcessModule>();
  processMock.spawn.mockImplementation(original.spawn);
  return { ...original, spawn: processMock.spawn };
});
// Fake children exercise stream failures; real missing executables retain Job startup checks.
vi.mock('./owned-cli-process', async (importOriginal) => {
  const actual = await importOriginal<typeof OwnedCliProcess>();
  return {
    ...actual,
    spawnOwnedCliProcess: (...args: Parameters<typeof actual.spawnOwnedCliProcess>) =>
      args[0] === 'fixture'
        ? processMock.spawn(args[0], args[1], args[2])
        : actual.spawnOwnedCliProcess(...args),
  };
});

it.each([
  ['usageLimitExceeded', 'RUNTIME_RATE_LIMIT', false],
  ['rateLimitExceeded', 'RUNTIME_RATE_LIMIT', false],
  ['unauthorized', 'RUNTIME_CLI_AUTH_REQUIRED', false],
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
    adapter.setCliResolution({
      executable: 'fixture',
      source: 'explicit',
      version: 'fixture',
      compatibility: 'verified',
      capabilities: [],
    });
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

it.skipIf(process.platform !== 'win32').each([
  ['claude', true],
  ['claude', false],
  ['codex', true],
  ['codex', false],
] as const)(
  'reports that %s disappeared after detection (retained resolution: %s)',
  async (kind, retainResolution) => {
    const root = await mkdtemp(join(tmpdir(), 'sprint-cli-removed-'));
    const executable = join(root, kind + '.exe');
    const isClaude = kind === 'claude';
    const adapter = isClaude ? new ClaudeRuntimeAdapter() : new CodexRuntimeAdapter();
    try {
      await copyFile(process.execPath, executable);
      vi.stubEnv('PATH', [root, dirname(process.execPath)].join(delimiter));
      for (const name of ['APPDATA', 'LOCALAPPDATA', 'HOME', 'USERPROFILE']) vi.stubEnv(name, root);
      const resolveCommand = isClaude ? resolveClaudeCommand : resolveCodexCommand;
      expect(resolveCommand(kind)).toBe(executable);
      if (retainResolution)
        adapter.setCliResolution({
          executable,
          source: 'path',
          version: 'fixture',
          compatibility: 'verified',
          capabilities: [],
        });
      await mkdir(join(root, 'hold'));
      await rename(executable, join(root, 'hold', kind + '.exe'));
      if (!retainResolution) expect(resolveCommand(kind)).toBe(kind);
      const accepted = vi.fn();
      const failed = vi.fn();
      const exited = vi.fn();
      adapter.start(
        'removed-cli',
        'synthetic request',
        [],
        accepted,
        root,
        'auto',
        vi.fn(),
        failed,
        exited,
      );
      await vi.waitFor(() => expect(exited).toHaveBeenCalledExactlyOnceWith(1, false));
      expect(failed).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ code: 'RUNTIME_CLI_MISSING', retryable: false }),
        expect.objectContaining({ failureStage: 'spawn_error' }),
      );
      expect(accepted).not.toHaveBeenCalled();
      expect(JSON.stringify(failed.mock.calls)).not.toContain(root);
    } finally {
      vi.unstubAllEnvs();
      adapter.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

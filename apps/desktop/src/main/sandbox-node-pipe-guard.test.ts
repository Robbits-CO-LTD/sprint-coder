import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { sandboxNodeOptions } from './sandbox-node-pipe-guard';

const source = readFileSync(
  resolve(__dirname, '../../resources/sandbox-node-pipe-guard.cjs'),
  'utf8',
);

function install(uv = '1.51.0', marker = '1', platform = 'win32') {
  const spawned = vi.fn((..._args: unknown[]) => 'spawned');
  class ChildProcess {
    spawn = spawned;
  }
  ChildProcess.prototype.spawn = spawned;
  const cp = {
    ChildProcess,
    spawnSync: vi.fn((..._args: unknown[]) => 'sync'),
    execSync: vi.fn((..._args: unknown[]) => 'exec'),
    execFileSync: vi.fn((..._args: unknown[]) => 'file'),
  };
  const original = cp.spawnSync;
  const sync = vi.fn();
  runInNewContext(source, {
    process: { platform, versions: { uv }, env: { SPRINT_CODER_SANDBOX_NODE_PIPE_GUARD: marker } },
    require: (name: string) =>
      name === 'node:child_process' ? cp : { syncBuiltinESMExports: sync },
  });
  const asyncSpawn = (stdio?: unknown) => cp.ChildProcess.prototype.spawn.call({}, { stdio });
  return { cp, original, asyncSpawn, spawned, sync };
}

describe('Windows sandbox Node pipe compatibility guard', () => {
  it.each([
    undefined,
    null,
    'pipe',
    'overlapped',
    [],
    ['ignore'],
    ['ignore', 'ignore', null],
    ['ignore', 'ignore', 'ignore', 'ipc'],
  ])('rejects pipe/IPC stdio %j before async native spawn', (stdio) => {
    const guard = install();
    expect(() => guard.asyncSpawn(stdio)).toThrow(/libuv 1.51.0/);
    expect(guard.spawned).not.toHaveBeenCalled();
  });
  it.each([
    'ignore',
    'inherit',
    ['ignore', 'inherit', 2],
    [0, 1, 2],
    [{ fd: 0 }, { fd: 1 }, { fd: 2 }],
  ])('preserves pipe-free stdio %j', (stdio) => {
    const guard = install();
    expect(guard.asyncSpawn(stdio)).toBe('spawned');
    expect(guard.cp.spawnSync('node', [], { stdio } as never)).toBe('sync');
  });
  it.each(['spawnSync', 'execSync', 'execFileSync'] as const)(
    'rejects %s default pipes with a fixed diagnostic',
    (name) => {
      const guard = install();
      expect(() => guard.cp[name]('secret-argv' as never)).toThrow(
        /cannot create child-process pipes\/IPC safely/,
      );
      try {
        guard.cp[name]('secret-argv' as never);
      } catch (error) {
        expect(error).toMatchObject({ code: 'SPRINT_CODER_SANDBOX_NODE_PIPE_UNSUPPORTED' });
        expect(String(error)).not.toContain('secret-argv');
      }
    },
  );
  it('reads stdio getters once and preserves sync overloads', () => {
    const guard = install();
    const get = vi.fn(() => 'ignore');
    const options = {
      get stdio() {
        return get();
      },
    };
    expect(guard.cp.execFileSync('node', options as never)).toBe('file');
    expect(get).toHaveBeenCalledTimes(1);
    expect(guard.cp.execSync('node', { stdio: 'inherit' } as never)).toBe('exec');
  });
  it.each([
    ['1.53.0', '1', 'win32'],
    ['2.0.0', '1', 'win32'],
    ['1.51.0', '', 'win32'],
    ['1.51.0', '1', 'linux'],
  ])('keeps unaffected runtimes unchanged (%s/%s/%s)', (uv, marker, platform) => {
    const guard = install(uv, marker, platform);
    expect(guard.cp.spawnSync).toBe(guard.original);
    expect(guard.sync).not.toHaveBeenCalled();
  });
  it('updates builtin named ESM exports on affected runtimes', () =>
    expect(install().sync).toHaveBeenCalledOnce());
  it('quotes spaces and Japanese paths without introducing additional Node options', () => {
    expect(sandboxNodeOptions('C:\\Program Files\\日本語\\guard.cjs')).toContain(
      '--require "C:/Program Files/日本語/guard.cjs"',
    );
    expect(() => sandboxNodeOptions('C:\\bad" --eval code')).toThrow();
  });
});

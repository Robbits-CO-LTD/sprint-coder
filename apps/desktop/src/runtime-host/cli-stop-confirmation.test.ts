import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ClaudeRuntimeAdapter } from './claude-adapter';
import { CodexRuntimeAdapter } from './codex-adapter';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), stop: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<object>()),
  spawn: mocks.spawn,
}));
vi.mock('./process-tree', () => ({ terminateRuntimeProcessTree: mocks.stop }));
it.each(
  ['claude', 'codex'].flatMap((kind) =>
    ['confirmed', 'unconfirmed', 'rejected'].map((outcome) => ({ kind, outcome })),
  ),
)('$kind retains turn ownership after $outcome stop confirmation', async ({ kind, outcome }) => {
  const root = await mkdtemp(join(tmpdir(), 'sprint-stop-confirmation-'));
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: undefined,
    exitCode: 0,
    signalCode: null,
  });
  mocks.spawn.mockReturnValue(child);
  let confirm!: (value: boolean) => void;
  let rejectStop!: (error: Error) => void;
  mocks.stop.mockReset().mockReturnValue(
    new Promise<boolean>((resolve, reject) => {
      confirm = resolve;
      rejectStop = reject;
    }),
  );
  const adapter =
    kind === 'claude'
      ? new ClaudeRuntimeAdapter(60_000)
      : new CodexRuntimeAdapter(60_000, 'fixture', [], root);
  const exited = vi.fn();
  const failed = vi.fn();
  try {
    adapter.start('turn', 'test', [], vi.fn(), root, 'auto', vi.fn(), failed, exited);
    const canceled = adapter.cancel('turn');
    child.emit('close', 0);
    await Promise.resolve();
    expect(exited).not.toHaveBeenCalled();
    const joined = adapter.cancel('turn');
    expect(mocks.stop).toHaveBeenCalledOnce();
    if (outcome === 'rejected') rejectStop(new Error('synthetic stop failure'));
    else confirm(outcome === 'confirmed');
    expect(await canceled).toBe(outcome !== 'confirmed');
    expect(await joined).toBe(outcome !== 'confirmed');
    if (outcome === 'confirmed') await vi.waitFor(() => expect(exited).toHaveBeenCalledOnce());
    else {
      await vi.waitFor(() =>
        expect(failed).toHaveBeenCalledWith(
          expect.objectContaining({ code: 'RUNTIME_STOP_UNCONFIRMED' }),
          expect.anything(),
        ),
      );
      expect(exited).not.toHaveBeenCalled();
      const spawnCount = mocks.spawn.mock.calls.length;
      adapter.start('another', 'test', [], vi.fn(), root, 'auto', vi.fn(), failed, exited);
      expect(mocks.spawn.mock.calls.length).toBe(spawnCount);
      expect(await adapter.cancel('turn')).toBe(true);
    }
  } finally {
    confirm(true);
    adapter.dispose();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

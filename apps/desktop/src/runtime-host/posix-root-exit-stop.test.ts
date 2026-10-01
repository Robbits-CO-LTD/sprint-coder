import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { CodexRuntimeAdapter } from './codex-adapter';
import { ClaudeRuntimeAdapter } from './claude-adapter';
import type * as StopBudget from './stop-budget';

const mocks = vi.hoisted(() => ({ platform: 'linux', spawn: vi.fn(), stop: vi.fn() }));
vi.mock('./stop-budget', async (original) => {
  const actual = await original<typeof StopBudget>();
  return {
    ...actual,
    runtimeCliStopOnRootExitSupported: () =>
      actual.runtimeCliStopOnRootExitSupported(mocks.platform),
  };
});
vi.mock('./owned-cli-process', () => ({
  spawnOwnedCliProcess: mocks.spawn,
  stopOwnedCliProcess: () => mocks.stop(),
}));

// The pure exit policy models POSIX on Windows; no process.platform mutation or OS signals.
it.each([
  ['codex', 'linux', true, false],
  ['codex', 'darwin', false, false],
  ['claude', 'darwin', true, false],
  ['claude', 'linux', false, false],
  ['codex', 'linux', true, true],
  ['codex', 'darwin', false, true],
  ['claude', 'darwin', true, true],
  ['claude', 'linux', false, true],
] as const)(
  '%s begins stop before inherited pipe close under modeled %s policy (confirmed=%s)',
  async (kind, platform, confirmed, closeBeforeConfirmation) => {
    const root = await mkdtemp(join(tmpdir(), 'sprint-posix-exit-'));
    await mkdir(join(root, '.git'));
    let settle!: (confirmed: boolean) => void;
    mocks.platform = platform;
    mocks.stop.mockReset().mockReturnValue(
      new Promise<boolean>((resolve) => {
        settle = resolve;
      }),
    );
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: undefined,
      exitCode: 0,
      signalCode: null,
    });
    mocks.spawn.mockReturnValue(child);
    const adapter =
      kind === 'codex'
        ? new CodexRuntimeAdapter(60_000, 'fixture', [], root)
        : new ClaudeRuntimeAdapter(60_000);
    adapter.setCliResolution({
      executable: 'fixture',
      source: 'explicit',
      version: 'fixture',
      compatibility: 'verified',
      capabilities: [],
    });
    const failed = vi.fn(),
      exited = vi.fn();
    try {
      adapter.start(
        'turn',
        'Synthetic request',
        [],
        vi.fn(),
        root,
        'auto',
        vi.fn(),
        failed,
        exited,
      );
      child.emit('exit', 0);
      expect(mocks.stop).toHaveBeenCalledOnce();
      expect(exited).not.toHaveBeenCalled();
      if (closeBeforeConfirmation) {
        child.emit('close', 0);
        await Promise.resolve();
        expect(exited).not.toHaveBeenCalled();
      }
      settle(confirmed);
      await Promise.resolve();
      await Promise.resolve();
      if (!confirmed)
        await vi.waitFor(() =>
          expect(failed).toHaveBeenCalledWith(
            expect.objectContaining({ code: 'RUNTIME_STOP_UNCONFIRMED' }),
            expect.anything(),
          ),
        );
      if (!closeBeforeConfirmation) {
        expect(exited).not.toHaveBeenCalled();
        child.emit('close', 0);
      }
      if (confirmed) await vi.waitFor(() => expect(exited).toHaveBeenCalledOnce());
      else {
        await Promise.resolve();
        await Promise.resolve();
        expect(exited).not.toHaveBeenCalled();
        expect(failed).toHaveBeenCalledOnce();
        expect(await adapter.cancel('turn')).toBe(true);
      }
      expect(mocks.stop).toHaveBeenCalledOnce();
    } finally {
      settle(true);
      child.emit('close', 0);
      adapter.dispose();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      await rm(root, { recursive: true, force: true });
    }
  },
);

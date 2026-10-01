import { EventEmitter } from 'node:events';
import type * as ChildProcessModule from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  delays: [] as number[],
  children: [] as Array<{ kill: ReturnType<typeof vi.fn> }>,
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  spawn: vi.fn((_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    fixture.children.push(child);
    const delay = fixture.delays.shift() ?? 0;
    setTimeout(() => {
      child.stdout.emit(
        'data',
        Buffer.from(
          args[0] === '--version'
            ? _command.startsWith('claude')
              ? '2.1.255 (Claude Code)'
              : 'codex-cli 0.144.4'
            : '--strict-config --output-format --include-partial-messages --strict-mcp-config --safe-mode --no-session-persistence',
        ),
      );
      child.emit('exit', 0);
    }, delay);
    return child;
  }),
}));

import { probeCliCommandCandidates } from './cli-command-resolution';
import { probeCodex } from './codex-adapter';
import { probeClaude } from './claude-adapter';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  fixture.delays.length = 0;
  fixture.children.length = 0;
});

describe('CLI candidate selection deadline', () => {
  it.each([probeCodex, probeClaude])(
    'accepts a slow version/help/auth sequence in the real probe',
    async (probe) => {
      vi.useFakeTimers();
      fixture.delays.push(4_100, 4_100, 2_400);
      const result = probe(probe === probeClaude ? 'claude-fixture' : 'codex-fixture', {});
      await vi.advanceTimersByTimeAsync(10_700);
      await expect(result).resolves.toMatchObject({ available: true, readiness: 'ready' });
      expect(fixture.children).toHaveLength(3);
    },
  );

  it('accepts separately valid slow version and help probes', async () => {
    vi.useFakeTimers();
    fixture.delays.push(4_100, 4_100);
    const result = probeCliCommandCandidates({
      kind: 'codex',
      candidates: [{ executable: 'fixture', source: 'explicit' }],
      environment: {},
      timeoutMs: 5_000,
      deadlineAt: Date.now() + 20_000,
    });
    await vi.advanceTimersByTimeAsync(8_200);
    expect(await result).toMatchObject({ executable: 'fixture', compatibility: 'verified' });
    expect(fixture.children.every((child) => child.kill.mock.calls.length === 0)).toBe(true);
  });

  it('bounds an arbitrary Desktop list including fallback without spawning after the deadline', async () => {
    vi.useFakeTimers();
    fixture.delays.push(...Array<number>(20).fill(10_000));
    const result = probeCliCommandCandidates({
      kind: 'codex',
      candidates: [
        ...Array.from({ length: 20 }, (_, i) => ({
          executable: `desktop-${i}`,
          source: 'desktop-versioned' as const,
        })),
        { executable: 'fallback', source: 'path' },
      ],
      environment: {},
      timeoutMs: 5_000,
      deadlineAt: Date.now() + 12_000,
    });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await result).toBeNull();
    expect(fixture.children).toHaveLength(3);
    expect(fixture.children.every((child) => child.kill.mock.calls.length === 1)).toBe(true);
  });
});

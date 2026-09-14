import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandRunner, CommandRunnerError, prepareExecutionSpec } from './command-runner';
import { ManagedCommandSessions } from './managed-command-sessions';
import { probeSandboxRunner } from './sandbox-runner';
import { workspaceMutationBinding } from './path-guard';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Managed command Workspace observation', () => {
  it('pins the root before startup and observes nested or renamed roots without blocking siblings', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'sprint-coder-session-roots-'));
    roots.push(parent);
    const workspace = join(parent, 'workspace');
    const nested = join(workspace, 'nested');
    const sibling = join(parent, 'workspace-other');
    await mkdir(nested, { recursive: true });
    await mkdir(sibling);
    const binding = await workspaceMutationBinding(workspace);
    const spec = await prepareExecutionSpec({
      workspacePath: workspace,
      cwd: 'nested',
      executable: process.execPath,
      argv: ['-e', ''],
    });
    const runner = new CommandRunner();
    let failStart = (): void => undefined;
    const run = vi.spyOn(runner, 'run').mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          failStart = () => reject(new CommandRunnerError('SPAWN_FAILED', 'test startup settled'));
        }),
    );
    const sessions = new ManagedCommandSessions(runner);
    const started = sessions.start(spec, { taskId: 'writer-task', turnId: 'writer-turn' });
    const settled = expect(started).rejects.toThrow('test startup settled');
    const observes = (path: string, rootIdentityDigest?: string) =>
      sessions.hasActiveWorkspaceSessions([{ path, rootIdentityDigest }]);
    try {
      expect(observes(workspace, binding.rootIdentityDigest)).toBe(true);
      expect(observes(nested)).toBe(true);
      expect(observes(parent)).toBe(true);
      expect(observes(sibling)).toBe(false);
      expect(sessions.hasActiveWorkspaceSessions([])).toBe(false);

      const moved = join(parent, 'moved');
      await rename(workspace, moved);
      // Path spelling alone no longer finds this writer. Its sealed root identity survives.
      expect(observes(moved, binding.rootIdentityDigest)).toBe(true);
      expect(observes(sibling)).toBe(false);
      failStart();
      await settled;
      expect(observes(moved, binding.rootIdentityDigest)).toBe(false);
    } finally {
      failStart();
      await settled;
      await sessions.dispose();
      run.mockRestore();
    }
  });
});

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')(
  'ManagedCommandSessions',
  () => {
    it('backgrounds, polls, writes stdin, and returns the terminal result', async () => {
      if (process.platform === 'linux' && !(await probeSandboxRunner()).available) return;
      const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-managed-session-'));
      roots.push(workspace);
      const spec = await prepareExecutionSpec({
        workspacePath: workspace,
        executable: '/bin/sh',
        argv: [
          '-c',
          'IFS= read -r value; printf "%s\\n" "$value"; printf "%s\\n" "$value" > done.txt',
        ],
      });
      const sessions = new ManagedCommandSessions();
      const owner = { taskId: 'task-1', turnId: 'turn-1' };
      const started = await sessions.start(spec, owner);
      expect(started.state).toBe('running');
      expect(sessions.writeStdin(started.sessionId, owner, 'hello\n', true)).toBe(true);
      const completed = await sessions.wait(started.sessionId, owner);
      expect(completed.state).toBe('exited');
      expect(completed.chunks.map(({ text }) => text).join('')).toContain('hello');
      await expect(readFile(join(workspace, 'done.txt'), 'utf8')).resolves.toBe('hello\n');
      await sessions.dispose();
    });

    it('terminates one owned background session without affecting another', async () => {
      if (process.platform === 'linux' && !(await probeSandboxRunner()).available) return;
      const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-managed-terminate-'));
      roots.push(workspace);
      const spec = await prepareExecutionSpec({
        workspacePath: workspace,
        executable: '/bin/sh',
        argv: ['-c', 'while :; do sleep 1; done'],
      });
      const sessions = new ManagedCommandSessions();
      const owner = { taskId: 'task-1', turnId: 'turn-1' };
      const first = await sessions.start(spec, owner);
      expect(sessions.terminate(first.sessionId, owner)).toBe(true);
      await expect(sessions.wait(first.sessionId, owner)).resolves.toMatchObject({
        state: 'canceled',
      });
      await sessions.dispose();
    });

    it('propagates the tool call abort signal to its running command', async () => {
      if (process.platform === 'linux' && !(await probeSandboxRunner()).available) return;
      const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-managed-abort-'));
      roots.push(workspace);
      const spec = await prepareExecutionSpec({
        workspacePath: workspace,
        executable: '/bin/sh',
        argv: ['-c', 'while :; do sleep 1; done'],
      });
      const sessions = new ManagedCommandSessions();
      const owner = { taskId: 'task-1', turnId: 'turn-1' };
      const controller = new AbortController();
      const hooks = { signal: controller.signal, beforeSpawn: () => undefined };
      try {
        const started = await sessions.start(spec, owner, hooks);
        controller.abort();
        await expect(sessions.waitFor(started.sessionId, owner, 5_000)).resolves.toMatchObject({
          state: 'canceled',
        });
      } finally {
        await sessions.dispose();
      }
    });

    it('does not spawn an already canceled command', async () => {
      if (process.platform === 'linux' && !(await probeSandboxRunner()).available) return;
      const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-managed-preabort-'));
      roots.push(workspace);
      const spec = await prepareExecutionSpec({
        workspacePath: workspace,
        executable: '/bin/sh',
        argv: ['-c', 'printf unexpected > spawned.txt'],
      });
      const sessions = new ManagedCommandSessions();
      const owner = { taskId: 'task-1', turnId: 'turn-1' };
      const controller = new AbortController();
      controller.abort();
      try {
        const started = await sessions.start(spec, owner, { signal: controller.signal });
        expect(started.state).toBe('canceled');
        expect(started.executionId).toBe(null);
        await expect(readFile(join(workspace, 'spawned.txt'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        await sessions.dispose();
      }
    });

    it('terminates only the selected Task and Turn after a command has returned a session', async () => {
      if (process.platform === 'linux' && !(await probeSandboxRunner()).available) return;
      const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-managed-turn-'));
      roots.push(workspace);
      const spec = await prepareExecutionSpec({
        workspacePath: workspace,
        executable: '/bin/sh',
        argv: ['-c', 'while :; do sleep 1; done'],
      });
      const sessions = new ManagedCommandSessions();
      const firstOwner = { taskId: 'task-1', turnId: 'turn-1' };
      const secondOwner = { taskId: 'task-1', turnId: 'turn-2' };
      const thirdOwner = { taskId: 'task-2', turnId: 'turn-1' };
      try {
        const first = await sessions.start(spec, firstOwner);
        const second = await sessions.start(spec, secondOwner);
        const third = await sessions.start(spec, thirdOwner);
        await sessions.terminateTurn(firstOwner);
        expect(sessions.poll(first.sessionId, firstOwner).state).toBe('canceled');
        expect(sessions.poll(second.sessionId, secondOwner).state).toBe('running');
        expect(sessions.poll(third.sessionId, thirdOwner).state).toBe('running');
      } finally {
        await sessions.dispose();
      }
    });

    it.each([
      'SPAWN_FAILED',
      'EXECUTION_SPEC_INVALID',
      'EXECUTION_IDENTITY_CHANGED',
      'OUTPUT_OVERFLOW',
    ] as const)('does not quarantine a Turn after a settled %s command error', async (code) => {
      if (process.platform === 'linux' && !(await probeSandboxRunner()).available) return;
      const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-managed-settled-'));
      roots.push(workspace);
      const spec = await prepareExecutionSpec({
        workspacePath: workspace,
        executable: '/bin/sh',
        argv: ['-c', 'exit 0'],
      });
      const runner = new CommandRunner();
      const run = vi
        .spyOn(runner, 'run')
        .mockRejectedValueOnce(new CommandRunnerError(code, 'settled failure'));
      const sessions = new ManagedCommandSessions(runner, 1);
      const owner = { taskId: 'task-1', turnId: 'turn-1' };
      try {
        await expect(sessions.start(spec, owner)).rejects.toThrow('settled failure');
        expect(
          sessions.hasActiveWorkspaceSessions([{ path: workspace, rootIdentityDigest: undefined }]),
        ).toBe(false);
        await expect(sessions.terminateTurn(owner)).resolves.toBeUndefined();
        run.mockRestore();
        const nextOwner = { taskId: 'task-1', turnId: 'turn-2' };
        const next = await sessions.start(spec, nextOwner);
        await expect(sessions.wait(next.sessionId, nextOwner)).resolves.toMatchObject({
          state: 'exited',
        });
      } finally {
        run.mockRestore();
        await sessions.dispose();
      }
    });

    it('retains termination failure before onStarted even when the caller aborted', async () => {
      if (process.platform === 'linux' && !(await probeSandboxRunner()).available) return;
      const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-managed-unconfirmed-'));
      roots.push(workspace);
      const spec = await prepareExecutionSpec({
        workspacePath: workspace,
        executable: '/bin/sh',
        argv: ['-c', 'exit 0'],
      });
      const controller = new AbortController();
      const runner = new CommandRunner();
      const run = vi.spyOn(runner, 'run').mockImplementation(async () => {
        controller.abort();
        throw new CommandRunnerError(
          'PROCESS_TREE_TERMINATION_FAILED',
          'pre-start process remains',
        );
      });
      const sessions = new ManagedCommandSessions(runner, 1);
      const owner = { taskId: 'task-1', turnId: 'turn-1' };
      try {
        await expect(
          sessions.start(
            spec,
            owner,
            { signal: controller.signal },
            '00000000-0000-4000-8000-000000000001',
          ),
        ).rejects.toThrow('pre-start process remains');
        expect(sessions.poll('00000000-0000-4000-8000-000000000001', owner).state).toBe('failed');
        expect(
          sessions.hasActiveWorkspaceSessions([{ path: workspace, rootIdentityDigest: undefined }]),
        ).toBe(true);
        await expect(sessions.start(spec, { taskId: 'task-2', turnId: 'turn-2' })).rejects.toThrow(
          'session limit reached',
        );
        await expect(sessions.terminateTurn(owner)).rejects.toThrow('could not be confirmed');
        await expect(sessions.terminateTurn(owner)).rejects.toThrow('could not be confirmed');
      } finally {
        run.mockRestore();
        await sessions.dispose();
      }
    });

    it('stops every session owned by a Task when its policy epoch changes', async () => {
      if (process.platform === 'linux' && !(await probeSandboxRunner()).available) return;
      const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-managed-policy-'));
      roots.push(workspace);
      const spec = await prepareExecutionSpec({
        workspacePath: workspace,
        executable: '/bin/sh',
        argv: ['-c', 'while :; do sleep 1; done'],
      });
      const sessions = new ManagedCommandSessions();
      const first = await sessions.start(spec, { taskId: 'task-1', turnId: 'turn-1' });
      const second = await sessions.start(spec, { taskId: 'task-2', turnId: 'turn-2' });
      await sessions.terminateTask('task-1');
      expect(sessions.poll(first.sessionId, { taskId: 'task-1', turnId: 'turn-1' }).state).toBe(
        'canceled',
      );
      expect(sessions.poll(second.sessionId, { taskId: 'task-2', turnId: 'turn-2' }).state).toBe(
        'running',
      );
      sessions.terminate(second.sessionId, { taskId: 'task-2', turnId: 'turn-2' });
      await sessions.dispose();
    });
  },
);

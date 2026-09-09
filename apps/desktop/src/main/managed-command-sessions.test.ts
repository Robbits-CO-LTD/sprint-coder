import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandRunner, CommandRunnerError, prepareExecutionSpec } from './command-runner';
import { ManagedCommandSessions } from './managed-command-sessions';
import { probeSandboxRunner } from './sandbox-runner';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
      const sessions = new ManagedCommandSessions(runner);
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

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareExecutionSpec } from './command-runner';
import { ManagedCommandSessions } from './managed-command-sessions';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')(
  'ManagedCommandSessions',
  () => {
    it('backgrounds, polls, writes stdin, and returns the terminal result', async () => {
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
      const started = await sessions.start(spec);
      expect(started.state).toBe('running');
      expect(sessions.writeStdin(started.sessionId, 'hello\n', true)).toBe(true);
      const completed = await sessions.wait(started.sessionId);
      expect(completed.state).toBe('exited');
      expect(completed.chunks.map(({ text }) => text).join('')).toContain('hello');
      await expect(readFile(join(workspace, 'done.txt'), 'utf8')).resolves.toBe('hello\n');
      await sessions.dispose();
    });

    it('terminates one owned background session without affecting another', async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'sprint-coder-managed-terminate-'));
      roots.push(workspace);
      const spec = await prepareExecutionSpec({
        workspacePath: workspace,
        executable: '/bin/sh',
        argv: ['-c', 'while :; do sleep 1; done'],
      });
      const sessions = new ManagedCommandSessions();
      const first = await sessions.start(spec);
      expect(sessions.terminate(first.sessionId)).toBe(true);
      await expect(sessions.wait(first.sessionId)).resolves.toMatchObject({ state: 'canceled' });
      await sessions.dispose();
    });
  },
);

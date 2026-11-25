import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import {
  buildControlledEnvironment,
  CommandRunner,
  CommandRunnerError,
  prepareExecutionSpec,
  resolveBareExecutable,
} from './command-runner';
import { probeSandboxRunner } from './sandbox-runner';

it('records the stage reached by Apple Silicon Homebrew programs and the HOME control', async () => {
  expect(process.platform).toBe('darwin');
  expect(process.arch).toBe('arm64');
  expect((await probeSandboxRunner()).available).toBe(true);
  const workspacePath = await mkdtemp(join(tmpdir(), 'sc-homebrew-probe-'));
  const environment = buildControlledEnvironment();
  const expectedHome = process.env.HOME;
  const labels = [
    { label: 'homebrew-gh-bare', command: 'gh', argv: ['--version'] },
    { label: 'system-first-git-bare', command: 'git', argv: ['--version'] },
    { label: 'homebrew-git-exact', command: '/opt/homebrew/bin/git', argv: ['--version'] },
    {
      label: 'admin-gh-absolute',
      command: '/Library/Application Support/Sprint Coder 1404 CI Probe/bin/gh',
      argv: ['--version'],
    },
    { label: 'HOME-control', command: '/usr/bin/printenv', argv: ['HOME'] },
  ];
  try {
    expect(environment.PATH?.split(':')).toContain('/opt/homebrew/bin');
    expect(expectedHome?.startsWith('/')).toBe(true);
    for (const { label, command, argv } of labels) {
      const found = command.startsWith('/') ? command : await resolveBareExecutable(command, environment);
      const canonical = await realpath(found);
      const binary = await stat(canonical);
      const parent = await stat(dirname(canonical));
      const ancestry = [];
      for (let path = canonical;; path = dirname(path)) {
        const node = await stat(path);
        ancestry.push({ ownerUid: node.uid, mode: (node.mode & 0o777).toString(8) });
        if (dirname(path) === path) break;
      }
      const metadata = {
        label,
        found,
        canonical,
        ownerUid: binary.uid,
        parentOwnerUid: parent.uid,
        uid: process.getuid?.(),
        mode: (binary.mode & 0o777).toString(8),
        parentMode: (parent.mode & 0o777).toString(8),
        links: binary.nlink,
        ...(label.startsWith('admin-') ? { ancestry } : {}),
      };
      let stage = 'prepare';
      let enteredSpawn = false;
      let started = false;
      let output = '';
      try {
        const spec = await prepareExecutionSpec({ workspacePath, executable: command, argv });
        stage = 'run';
        const result = await new CommandRunner({ sandboxed: true }).run(spec, {
          beforeSpawn: () => { enteredSpawn = true; },
          onStarted: () => { started = true; },
          onChunk: (chunk) => { output += chunk.text; },
        });
        const homeMatches = label === 'HOME-control' ? output.trimEnd() === expectedHome : undefined;
        const version = label === 'HOME-control' ? undefined : output.match(/^(?:gh|git) version [0-9A-Za-z.+()-]+/u)?.[0];
        console.log('SC1404 ' + JSON.stringify({
          ...metadata, stage, enteredSpawn, started, exitCode: result.exitCode, homeMatches, version,
        }));
        if (label === 'admin-gh-absolute') expect.fail('The current trusted-image boundary unexpectedly accepted the managed fixture');
        if (label === 'HOME-control') {
          expect(result.exitCode).toBe(0);
          expect(homeMatches).toBe(true);
        }
      } catch (error) {
        const code = error instanceof CommandRunnerError ? error.code : 'other';
        const reason = error instanceof Error && error.message.includes('cannot safely launch this mutable native execution image')
          ? 'mutable-native-image'
          : 'other';
        console.log('SC1404 ' + JSON.stringify({
          ...metadata, stage, enteredSpawn, started, code, reason,
        }));
        if (label === 'admin-gh-absolute') {
          expect(stage).toBe('run');
          expect(enteredSpawn).toBe(false);
          expect(started).toBe(false);
          expect(code).toBe('EXECUTION_IDENTITY_CHANGED');
          expect(reason).toBe('mutable-native-image');
        }
        if (label === 'HOME-control') throw error;
      }
    }
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
}, 60_000);

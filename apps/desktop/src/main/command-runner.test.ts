import { afterEach, describe, expect, it } from 'vitest';
import { access, chmod, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CommandRunner,
  CommandRunnerError,
  buildControlledEnvironment,
  executionSpecPathGuard,
  prepareExecutionSpec,
  waitForOutcomeOrTerminationFailure,
  type CommandOutputChunk,
} from './command-runner';
import { workspaceMutationBinding } from './path-guard';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
        // Windows can report EBUSY briefly after a terminated process releases its cwd handle.
        maxRetries: process.platform === 'win32' ? 5 : 0,
        retryDelay: 50,
      }),
    ),
  );
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sprint-coder-command-runner-'));
  roots.push(root);
  return root;
}

const executionIt = it;

describe('CommandRunner', () => {
  it('inherits Windows command-discovery and user paths case-insensitively but excludes secrets', () => {
    const environment = buildControlledEnvironment('win32', {
      Path: 'C:\\Program Files\\nodejs;C:\\Program Files\\Git\\cmd',
      UserProfile: 'C:\\Users\\example',
      AppData: 'C:\\Users\\example\\AppData\\Roaming',
      localappdata: 'C:\\Users\\example\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      OPENAI_API_KEY: 'must-not-cross',
      AWS_SECRET_ACCESS_KEY: 'must-not-cross',
    });

    expect(environment).toMatchObject({
      PATH: 'C:\\Program Files\\nodejs;C:\\Program Files\\Git\\cmd',
      HOME: 'C:\\Users\\example',
      USERPROFILE: 'C:\\Users\\example',
      APPDATA: 'C:\\Users\\example\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local',
      PROGRAMFILES: 'C:\\Program Files',
    });
    expect(environment).not.toHaveProperty('OPENAI_API_KEY');
    expect(environment).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
  });

  it('keeps the fixed minimal PATH and excludes user state on non-Windows platforms', () => {
    const environment = buildControlledEnvironment('darwin', {
      PATH: '/private/custom/bin',
      HOME: '/Users/example',
      APPDATA: '/private/appdata',
      OPENAI_API_KEY: 'must-not-cross',
      LANG: 'ja_JP.UTF-8',
    });

    expect(environment).toEqual({
      LANG: 'ja_JP.UTF-8',
      PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    });
  });

  it('surfaces termination failure without waiting for a process close that may never arrive', async () => {
    const neverCloses = new Promise<never>(() => undefined);
    const terminationFailure = Promise.reject(
      new CommandRunnerError('PROCESS_TREE_TERMINATION_FAILED', 'tree survived'),
    );

    await expect(
      waitForOutcomeOrTerminationFailure(neverCloses, terminationFailure),
    ).rejects.toMatchObject({ code: 'PROCESS_TREE_TERMINATION_FAILED' });
  });

  it('prepares an immutable spec from a canonical Workspace cwd and rejects escapes', async () => {
    const root = await workspace();
    const spec = await prepareExecutionSpec({
      rootId: 'root-b',
      workspacePath: root,
      executable: process.execPath,
      argv: ['--version'],
      cwd: '.',
    });

    expect(spec.absoluteExecutable).toBe(process.execPath);
    expect(spec.cwdIdentity.canonicalPath).toBe(await realpath(root));
    expect(executionSpecPathGuard(spec).rootId).toBe('root-b');
    expect(Object.isFrozen(spec)).toBe(true);
    await expect(
      prepareExecutionSpec({
        workspacePath: root,
        executable: process.execPath,
        argv: [],
        cwd: '..',
      }),
    ).rejects.toThrow();
  });

  it('rejects a replacement inode at a persisted Project root path', async () => {
    const root = await workspace();
    const binding = await workspaceMutationBinding(root);
    const original = `${root}-original`;
    await rename(root, original);
    roots.push(original);
    await mkdir(root);

    await expect(
      prepareExecutionSpec({
        rootId: 'root-a',
        workspacePath: root,
        expectedRootIdentityDigest: binding.rootIdentityDigest,
        executable: process.execPath,
        argv: ['--version'],
        cwd: '.',
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' });
  });

  executionIt(
    'emits globally sequenced stdout/stderr batches and sanitizes terminal controls',
    async () => {
      const root = await workspace();
      const chunks: CommandOutputChunk[] = [];
      const spec = await prepareExecutionSpec({
        workspacePath: root,
        executable: process.execPath,
        argv: [
          '-e',
          "process.stdout.write('one\\u001b[31m'); setTimeout(() => { process.stderr.write('two\\u001b]8;;x\\u0007'); setTimeout(() => process.stdout.write('three'), 20); }, 20)",
        ],
        cwd: '.',
      });

      const result = await new CommandRunner({
        batchIntervalMs: 100,
        maxBatchBytes: 64 * 1024,
      }).run(spec, {
        onChunk: (chunk) => {
          chunks.push(chunk);
        },
      });

      expect(result.exitCode).toBe(0);
      expect(chunks.map(({ seq }) => seq)).toEqual(chunks.map((_, index) => index + 1));
      const observed = chunks.map(({ text }) => text).join('');
      expect(observed).toContain('one');
      expect(observed).toContain('two');
      expect(observed).toContain('three');
      expect(chunks.every(({ byteLength }) => byteLength <= 64 * 1024)).toBe(true);
    },
  );

  executionIt(
    'cooperatively cancels then terminates a stubborn process tree after the grace period',
    async () => {
      const root = await workspace();
      const controller = new AbortController();
      const spec = await prepareExecutionSpec({
        workspacePath: root,
        executable: process.execPath,
        argv: [
          '-e',
          "const child=require('node:child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)\"],{stdio:['ignore','pipe','ignore']}); child.stdout.once('data',()=>console.log(JSON.stringify({parent:process.pid,child:child.pid}))); setInterval(()=>{},1000)",
        ],
        cwd: '.',
      });
      const runner = new CommandRunner({ cancelGraceMs: 30 });
      let output = '';
      const running = runner.run(spec, {
        signal: controller.signal,
        onChunk: (chunk) => {
          output += chunk.text;
          if (output.includes('"child"')) controller.abort();
        },
      });

      await expect(running).resolves.toMatchObject({ canceled: true, termination: 'forced' });
      expect(runner.activeCount).toBe(0);
      const pids = JSON.parse(output.trim()) as { parent: number; child: number };
      await expectProcessDead(pids.parent);
      await expectProcessDead(pids.child);
    },
  );

  it('fails closed when an unissued or changed ExecutionSpec reaches the execution boundary', async () => {
    const root = await workspace();
    const spec = await prepareExecutionSpec({
      workspacePath: root,
      executable: process.execPath,
      argv: ['--version'],
      cwd: '.',
    });
    const changed = { ...spec, argv: ['-e', 'process.exit(99)'] };

    await expect(new CommandRunner().run(changed)).rejects.toMatchObject({
      code: 'EXECUTION_SPEC_INVALID',
    } satisfies Partial<CommandRunnerError>);
  });

  executionIt(
    'captures a trustworthy process-start identity before publishing started',
    async () => {
      const root = await workspace();
      const spec = await prepareExecutionSpec({
        workspacePath: root,
        executable: process.execPath,
        argv: ['--version'],
        cwd: '.',
      });
      let identity = '';

      await new CommandRunner().run(spec, {
        onStarted: ({ processStartIdentity }) => {
          identity = processStartIdentity;
        },
      });

      expect(identity).not.toBe('');
      expect(identity).not.toBe('unavailable');
    },
  );

  // Regression (CI-only flake on ubuntu, chased down to a real data-loss bug): while a batch is
  // awaiting a slow sink, more output can arrive. `queueText` merged that arrival into the LAST
  // pending segment — but when that segment is already inside the in-flight batch, the batch the
  // sink received is a value snapshot holding the OLD text while `pending` holds the longer one.
  // The post-await `pending.splice(0, count)` then discarded the whole segment including the
  // appended bytes, so they reached no batch at all and `pendingBytes` was decremented by only the
  // snapshot's length.
  //
  // Reproduced by writing continuously (300 bytes every 10ms) against a sink that holds 300ms, so
  // arrivals during an in-flight batch are guaranteed, and by picking a write size that does not
  // divide maxBatchBytes so the trailing segment is reliably partial (a full trailing segment takes
  // the push path and cannot reproduce this).
  executionIt(
    'does not drop output that arrives while a batch is still in the sink',
    async () => {
      const root = await workspace();
      const writes = 100;
      const perWrite = 300;
      const spec = await prepareExecutionSpec({
        workspacePath: root,
        executable: process.execPath,
        argv: [
          '-e',
          `let n=0; const t=setInterval(()=>{ process.stdout.write('x'.repeat(${perWrite})); if(++n>=${writes}) clearInterval(t); },10);`,
        ],
        cwd: '.',
      });

      let observed = 0;
      const result = await new CommandRunner({ maxBatchBytes: 1024 }).run(spec, {
        onBatch: async (batch) => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          observed += batch.reduce((total, chunk) => total + chunk.byteLength, 0);
        },
      });

      expect(result.outputBytes).toBe(writes * perWrite);
      expect(observed).toBe(writes * perWrite);
    },
    30_000,
  );

  executionIt(
    'drains tail output after process exit and applies async sink backpressure in batches',
    async () => {
      const root = await workspace();
      const expectedBytes = 2 * 1024 * 1024;
      const spec = await prepareExecutionSpec({
        workspacePath: root,
        executable: process.execPath,
        argv: ['-e', `process.stdout.write('x'.repeat(${expectedBytes}))`],
        cwd: '.',
      });
      let observedBytes = 0;
      let activeSinks = 0;
      let peakSinks = 0;

      const result = await new CommandRunner({ maxBufferedBytes: 128 * 1024 }).run(spec, {
        onBatch: async (batch) => {
          activeSinks += 1;
          peakSinks = Math.max(peakSinks, activeSinks);
          await new Promise((resolve) => setTimeout(resolve, 2));
          observedBytes += batch.reduce((total, chunk) => total + chunk.byteLength, 0);
          activeSinks -= 1;
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.outputBytes).toBe(expectedBytes);
      expect(observedBytes).toBe(expectedBytes);
      expect(peakSinks).toBe(1);
    },
  );

  executionIt(
    'kills the owned process tree and fails closed when the durable output sink rejects',
    async () => {
      const root = await workspace();
      const spec = await prepareExecutionSpec({
        workspacePath: root,
        executable: process.execPath,
        argv: [
          '-e',
          "const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(JSON.stringify({parent:process.pid,child:child.pid})); setInterval(()=>{},1000)",
        ],
        cwd: '.',
      });
      let output = '';
      const runner = new CommandRunner();

      await expect(
        runner.run(spec, {
          onBatch: (batch) => {
            output += batch.map((chunk) => chunk.text).join('');
            throw new Error('sqlite unavailable');
          },
        }),
      ).rejects.toThrow('sqlite unavailable');
      const pids = JSON.parse(output.trim()) as { parent: number; child: number };
      await expectProcessDead(pids.parent);
      await expectProcessDead(pids.child);
      expect(runner.activeCount).toBe(0);
    },
  );

  executionIt(
    'commits the dispatch boundary before spawn and does not run when it fails',
    async () => {
      const root = await workspace();
      const marker = join(root, 'spawned');
      const spec = await prepareExecutionSpec({
        workspacePath: root,
        executable: process.execPath,
        argv: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`],
        cwd: '.',
      });

      await expect(
        new CommandRunner().run(spec, {
          beforeSpawn: () => {
            throw new Error('durable transition failed');
          },
        }),
      ).rejects.toThrow('durable transition failed');
      await expect(access(marker)).rejects.toThrow();
    },
  );

  it.runIf(process.platform === 'win32')(
    'runs a short-lived Windows command exactly once after the durable dispatch boundary',
    async () => {
      const root = await workspace();
      const marker = join(root, 'spawned');
      const spec = await prepareExecutionSpec({
        workspacePath: root,
        executable: process.execPath,
        argv: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`],
        cwd: '.',
      });
      let beforeSpawnCalled = false;

      await expect(
        new CommandRunner().run(spec, {
          beforeSpawn: () => {
            beforeSpawnCalled = true;
          },
        }),
      ).resolves.toMatchObject({ exitCode: 0, canceled: false });
      expect(beforeSpawnCalled).toBe(true);
      await expect(access(marker)).resolves.toBeUndefined();
      expect(
        await import('node:fs/promises').then(({ readFile }) => readFile(marker, 'utf8')),
      ).toBe('yes');
    },
  );

  it.runIf(process.platform === 'win32')(
    'resolves git, node, and npm from the real Windows PATH used by direct API tools',
    async () => {
      const root = await workspace();
      const spec = await prepareExecutionSpec({
        workspacePath: root,
        executable: process.execPath,
        argv: [
          '-e',
          "const cp=require('node:child_process'); for (const name of ['git.exe','node.exe','npm.cmd']) { const result=cp.spawnSync('where.exe',[name],{encoding:'utf8'}); if (result.status !== 0) process.exit(result.status ?? 1); process.stdout.write(result.stdout ?? ''); }",
        ],
      });
      let output = '';

      await expect(
        new CommandRunner().run(spec, {
          onChunk: (chunk) => {
            output += chunk.text;
          },
        }),
      ).resolves.toMatchObject({ exitCode: 0 });
      expect(output.toLowerCase()).toContain('git.exe');
      expect(output.toLowerCase()).toContain('node.exe');
      expect(output.toLowerCase()).toContain('npm');
    },
  );

  it.runIf(process.platform !== 'win32')(
    'rejects an executable rewritten in place after preparation',
    async () => {
      const root = await workspace();
      const executable = join(root, 'command.sh');
      await writeFile(executable, '#!/bin/sh\nexit 0\n');
      await chmod(executable, 0o700);
      const spec = await prepareExecutionSpec({
        workspacePath: root,
        executable,
        argv: [],
        cwd: '.',
      });
      await writeFile(executable, '#!/bin/sh\nexit 7\n');

      await expect(new CommandRunner().run(spec)).rejects.toMatchObject({
        code: 'EXECUTION_IDENTITY_CHANGED',
      } satisfies Partial<CommandRunnerError>);
    },
  );
});

async function expectProcessDead(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch {
      return;
    }
  }
  throw new Error(`Process ${pid} survived CommandRunner cancellation`);
}

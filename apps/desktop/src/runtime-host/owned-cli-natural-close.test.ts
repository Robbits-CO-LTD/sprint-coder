import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { CodexRuntimeAdapter } from './codex-adapter';
it.runIf(process.platform === 'win32').each(['ignore', 'inherit'] as const)(
  'confirms owned detached descendants with %s stdio exited before natural-close notification',
  async (stdio) => {
    const root = await mkdtemp(join(tmpdir(), 'sprint-natural-close-owned-'));
    const marker = join(root, 'owned-pid.txt');
    const script = join(root, 'synthetic-codex.cjs');
    let descendant: number | undefined;
    const adapter = new CodexRuntimeAdapter(30_000, process.execPath, [script], root);
    const exited = vi.fn();
    try {
      await writeFile(
        script,
        [
          "const { createInterface } = require('node:readline');",
          "const { spawn } = require('node:child_process');",
          "const { writeFileSync } = require('node:fs');",
          "const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
          "createInterface({ input: process.stdin }).on('line', (line) => {",
          'const m = JSON.parse(line);',
          "if (m.method === 'initialize' || m.method === 'skills/extraRoots/set') send({jsonrpc:'2.0',id:m.id,result:{}});",
          "if (m.method === 'skills/list') send({jsonrpc:'2.0',id:m.id,result:{data:[{cwd:m.params.cwds[0],skills:[],errors:[]}]}});",
          "if (m.method === 'thread/start') send({jsonrpc:'2.0',id:m.id,result:{thread:{id:'synthetic-thread'}}});",
          "if (m.method === 'turn/start') {",
          `const child = spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{stdio:${JSON.stringify(stdio === 'ignore' ? 'ignore' : ['ignore', 'inherit', 'inherit'])},windowsHide:true,detached:true});`,
          `writeFileSync(${JSON.stringify(marker)}, String(child.pid));`,
          "send({jsonrpc:'2.0',id:m.id,result:{}});",
          "send({jsonrpc:'2.0',method:'turn/completed',params:{turn:{status:'completed'}}});",
          'setTimeout(() => process.exit(0), 30);',
          '}',
          '});',
        ].join('\n'),
      );
      adapter.start(
        'natural-close',
        'synthetic',
        [],
        vi.fn(),
        root,
        'auto',
        vi.fn(),
        vi.fn(),
        exited,
      );
      await vi.waitFor(() => expect(exited).toHaveBeenCalledOnce(), { timeout: 10_000 });
      descendant = Number(await readFile(marker, 'utf8'));
      expect(Number.isSafeInteger(descendant) && descendant > 0).toBe(true);
      expect(() => process.kill(descendant!, 0)).toThrow();
      expect(exited).toHaveBeenCalledWith(0, false);
    } finally {
      if (descendant === undefined)
        descendant = Number(await readFile(marker, 'utf8').catch(() => '0'));
      if (Number.isSafeInteger(descendant) && descendant > 0)
        spawnSync('taskkill', ['/pid', String(descendant), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      adapter.dispose();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  },
  15_000,
);

it.runIf(process.platform === 'linux' || process.platform === 'darwin').each(['inherit'] as const)(
  'stops a real POSIX original-group descendant with %s stdio exited before natural-close notification',
  async (_stdio) => {
    const root = await mkdtemp(join(tmpdir(), 'sprint-natural-close-owned-'));
    const marker = join(root, 'owned-pid.txt');
    const script = join(root, 'synthetic-codex.cjs');
    let descendant: number | undefined;
    let ownedGroup: number | undefined;
    const adapter = new CodexRuntimeAdapter(30_000, process.execPath, [script], root);
    const exited = vi.fn();
    const failed = vi.fn();
    try {
      await writeFile(
        script,
        [
          "const { createInterface } = require('node:readline');",
          "const { spawn } = require('node:child_process');",
          "const { writeFileSync } = require('node:fs');",
          "const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
          "createInterface({ input: process.stdin }).on('line', (line) => {",
          'const m = JSON.parse(line);',
          "if (m.method === 'initialize' || m.method === 'skills/extraRoots/set') send({jsonrpc:'2.0',id:m.id,result:{}});",
          "if (m.method === 'skills/list') send({jsonrpc:'2.0',id:m.id,result:{data:[{cwd:m.params.cwds[0],skills:[],errors:[]}]}});",
          "if (m.method === 'thread/start') send({jsonrpc:'2.0',id:m.id,result:{thread:{id:'synthetic-thread'}}});",
          "if (m.method === 'turn/start') {",
          `const child = spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{stdio:${JSON.stringify(['ignore', 'inherit', 'inherit'])},windowsHide:true,detached:false});`,
          `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ descendant: child.pid, group: process.pid }));`,
          "send({jsonrpc:'2.0',id:m.id,result:{}});",
          "send({jsonrpc:'2.0',method:'turn/completed',params:{turn:{status:'completed'}}});",
          'setTimeout(() => process.exit(0), 30);',
          '}',
          '});',
        ].join('\n'),
      );
      adapter.start(
        'natural-close',
        'synthetic',
        [],
        vi.fn(),
        root,
        'auto',
        vi.fn(),
        failed,
        exited,
      );
      await vi.waitFor(
        () => expect(exited.mock.calls.length + failed.mock.calls.length).toBeGreaterThan(0),
        { timeout: 10_000 },
      );
      const owned = JSON.parse(await readFile(marker, 'utf8')) as {
        descendant: number;
        group: number;
      };
      descendant = owned.descendant;
      ownedGroup = owned.group;
      expect(Number.isSafeInteger(descendant) && descendant > 0).toBe(true);
      const state =
        execFileSync('ps', ['-axo', 'pid=,stat='], { encoding: 'utf8', timeout: 2_000 })
          .split('\n')
          .map((line) => line.trim().split(/\s+/))
          .find(([pid]) => Number(pid) === descendant)?.[1] ?? '';
      expect(state).toMatch(/^Z|^$/u);
      console.info(
        `POSIX root-exit fixture: ${exited.mock.calls.length ? 'confirmed' : 'unconfirmed'}; descendant=${state.startsWith('Z') ? 'zombie' : 'absent'}`,
      );
      if (exited.mock.calls.length) {
        expect(exited).toHaveBeenCalledWith(0, false);
        expect(failed).not.toHaveBeenCalled();
      } else
        expect(failed).toHaveBeenCalledWith(
          expect.objectContaining({ code: 'RUNTIME_STOP_UNCONFIRMED' }),
          expect.anything(),
        );
    } finally {
      if (descendant === undefined) {
        const owned = JSON.parse(await readFile(marker, 'utf8').catch(() => '{}')) as {
          descendant?: number;
          group?: number;
        };
        descendant = owned.descendant;
        ownedGroup = owned.group;
      }
      if (ownedGroup !== undefined && Number.isSafeInteger(ownedGroup) && ownedGroup > 0) {
        try {
          process.kill(-ownedGroup, 'SIGKILL');
        } catch {
          /* Already absent. */
        }
      }
      if (descendant !== undefined && Number.isSafeInteger(descendant) && descendant > 0)
        try {
          process.kill(descendant, 'SIGKILL');
        } catch {
          /* Already absent. */
        }
      adapter.dispose();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  },
  15_000,
);

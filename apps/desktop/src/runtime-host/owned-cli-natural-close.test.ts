import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
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

import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { spawnOwnedCliProcess, stopOwnedCliProcess } from './owned-cli-process';
import {
  isNativeProcessDescendant,
  queryNativeProcessIdentity,
  type NativeProcessIdentity,
} from '../main/native-process-identity';
it.runIf(process.platform === 'win32')(
  'preserves CLI prefix, Unicode paths, environment and live wrapper ancestry through natural exit',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'sprint-owned-job 日本語 '));
    const script = join(root, 'CLI prefix with spaces.cjs');
    const marker = join(root, 'facts.json');
    await writeFile(
      script,
      [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true,windowsHide:true});",
        `writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,child:child.pid,argv:process.argv.slice(2),home:process.env.HOME,codex:process.env.CODEX_HOME,cwd:process.cwd()}));`,
        'setTimeout(()=>process.exit(0),800);',
      ].join('\n'),
    );
    let identity: NativeProcessIdentity | null = null;
    const child = spawnOwnedCliProcess(
      process.execPath,
      [script, 'argument 日本語 with spaces'],
      {
        cwd: root,
        env: { ...process.env, HOME: 'isolated 日本語 home', CODEX_HOME: 'isolated codex' },
        windowsHide: true,
      },
      (pid) => {
        identity = queryNativeProcessIdentity(pid);
        return identity !== null;
      },
    );
    const closed = new Promise<void>((resolve, reject) => {
      child.once('close', () => resolve());
      child.once('error', reject);
    });
    try {
      let facts!: {
        pid: number;
        child: number;
        argv: string[];
        home: string;
        codex: string;
        cwd: string;
      };
      await vi.waitFor(
        async () => {
          facts = JSON.parse(await readFile(marker, 'utf8'));
        },
        { timeout: 5_000 },
      );
      expect(facts.argv).toEqual(['argument 日本語 with spaces']);
      expect(facts.home).toBe('isolated 日本語 home');
      expect(facts.codex).toBe('isolated codex');
      expect(facts.cwd).toBe(root);
      expect(identity).not.toBeNull();
      const cli = queryNativeProcessIdentity(facts.pid);
      expect(cli).not.toBeNull();
      expect(isNativeProcessDescendant(cli!, identity!)).toBe(true);
      await closed;
      expect(() => process.kill(facts.child, 0)).not.toThrow();
      expect(await stopOwnedCliProcess(child)).toBe(true);
      expect(() => process.kill(facts.child, 0)).toThrow();
    } finally {
      await stopOwnedCliProcess(child);
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  },
  15_000,
);

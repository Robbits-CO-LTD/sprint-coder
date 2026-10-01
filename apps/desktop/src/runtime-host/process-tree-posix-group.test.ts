import { execFileSync, spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import { terminateRuntimeProcessTree } from './process-tree';

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Synthetic process readiness timed out')), 3_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

it.skipIf(process.platform === 'win32')(
  'stops a real surviving original group after the root has naturally closed',
  async () => {
    const script = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.once('data', () => { console.log(child.pid); child.unref(); process.exit(0); });
    `;
    const root = spawn(process.execPath, ['-e', script], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let descendantPid: number | undefined;
    const state = (pid: number): string => {
      const output = execFileSync('ps', ['-axo', 'pid=,stat='], { encoding: 'utf8' });
      return (
        output
          .split('\n')
          .map((line) => line.trim().split(/\s+/))
          .find(([id]) => Number(id) === pid)?.[1] ?? ''
      );
    };
    try {
      descendantPid = await bounded(
        new Promise<number>((resolve, reject) => {
          root.once('error', reject);
          root.stdout.once('data', (data: Buffer) => resolve(Number(data.toString().trim())));
        }),
      );
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      await bounded(
        new Promise<void>((resolve) => {
          if (root.exitCode !== null) resolve();
          else root.once('close', () => resolve());
        }),
      );
      expect(state(descendantPid)).not.toMatch(/^Z|^$/u);
      const stopped = await terminateRuntimeProcessTree(root, process.env);
      expect(state(descendantPid)).toMatch(/^Z|^$/u);
      // Some CI init processes retain an orphan zombie. A still-visible group remains
      // conservatively unconfirmed; no live descendant is ever accepted as stopped.
      let groupAbsent = false;
      try {
        process.kill(-root.pid!, 0);
      } catch (error) {
        groupAbsent =
          typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
      }
      expect(stopped).toBe(groupAbsent);
    } finally {
      if (root.pid !== undefined) {
        try {
          process.kill(-root.pid, 'SIGKILL');
        } catch {
          /* Already absent. */
        }
      }
      if (descendantPid !== undefined) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {
          /* Already absent. */
        }
      }
      root.stdout.destroy();
      root.stderr.destroy();
      root.stdin.destroy();
    }
  },
  15_000,
);

import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  WINDOWS_JOB_WRAPPER,
  assignProcessToOwnedJob,
  closeOwnedJob,
  releaseOwnedJob,
  windowsJobWrapperDetached,
} from './windows-process-job';
import { nativeSafeFsAddonPath } from './native-safe-fs';

describe('Windows command wrapper', () => {
  it('fails closed unless the DLL search policy is installed before target spawn', () => {
    const policy = WINDOWS_JOB_WRAPPER.indexOf('enableSafeDllSearchPolicy');
    const spawn = WINDOWS_JOB_WRAPPER.indexOf('runPreparedExecutionImage');
    expect(policy).toBeGreaterThanOrEqual(0);
    expect(spawn).toBeGreaterThan(policy);
    expect(WINDOWS_JOB_WRAPPER).toContain('process.exitCode = 125');
  });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

describe.skipIf(process.platform !== 'win32')('owned Job release', () => {
  // A command running from its own image (a copy of Node) that, once in its Job, starts a
  // long-lived process of another image (this Node) and keeps running.
  async function startCommandInJob(jobId: string, image: string) {
    const command = spawn(
      image,
      [
        '-e',
        [
          "const { spawn } = require('node:child_process');",
          "process.stdin.once('data', () => {",
          "  const child = spawn(process.argv[1], ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });",
          '  child.unref();',
          '  process.stdout.write(String(child.pid));',
          '  setInterval(() => {}, 1000);',
          '});',
        ].join('\n'),
        process.execPath,
      ],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
    );
    await new Promise<void>((resolve, reject) => {
      command.once('spawn', resolve);
      command.once('error', reject);
    });
    assignProcessToOwnedJob(command.pid!, jobId);
    const startedPid = new Promise<number>((resolve) => {
      let output = '';
      command.stdout!.on('data', (data: Buffer) => {
        output += data.toString();
        if (/^\d+$/u.test(output)) resolve(Number(output));
      });
    });
    command.stdin!.write('go\n');
    return { command: command.pid!, started: await startedPid };
  }

  it('terminates only the command image on release, and every member on close', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'sprint-coder-job-release-'));
    const image = join(folder, 'command-image.exe');
    await copyFile(process.execPath, image);
    const pids: number[] = [];
    try {
      const releasedJob = randomUUID();
      const released = await startCommandInJob(releasedJob, image);
      pids.push(released.command, released.started);
      expect(alive(released.command) && alive(released.started)).toBe(true);
      expect(releaseOwnedJob(releasedJob, image)).toBe(true);
      expect(await waitUntil(() => !alive(released.command))).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(alive(released.started)).toBe(true);
      // The Job is gone once released.
      expect(releaseOwnedJob(releasedJob, image)).toBe(false);

      const closedJob = randomUUID();
      const closed = await startCommandInJob(closedJob, image);
      pids.push(closed.command, closed.started);
      expect(closeOwnedJob(closedJob)).toBe(true);
      expect(await waitUntil(() => !alive(closed.command) && !alive(closed.started))).toBe(true);
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid);
        } catch {
          // Already ended.
        }
      }
      await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 20_000);

  // A command that starts a long-lived process (this Node) and then ends by itself, as a finished
  // desktop-control run does. Its console host is in the Job too and exits around the release.
  // Resolves with that process's pid once the command has ended.
  async function runCommandToEnd(jobId: string, image: string): Promise<number> {
    const command = spawn(
      image,
      [
        '-e',
        [
          "const { spawn } = require('node:child_process');",
          "process.stdin.once('data', () => {",
          "  const child = spawn(process.argv[1], ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });",
          '  child.unref();',
          '  process.stdout.write(String(child.pid), () => process.exit(0));',
          '});',
        ].join('\n'),
        process.execPath,
      ],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
    );
    await new Promise<void>((resolve, reject) => {
      command.once('spawn', resolve);
      command.once('error', reject);
    });
    assignProcessToOwnedJob(command.pid!, jobId);
    let output = '';
    command.stdout!.on('data', (data: Buffer) => (output += data.toString()));
    const exited = new Promise((resolve) => command.once('close', resolve));
    command.stdin!.write('go\n');
    await exited;
    return Number(output);
  }

  it('keeps the started process when members are still exiting at a natural end', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'sprint-coder-job-exiting-'));
    const image = join(folder, 'command-image.exe');
    await copyFile(process.execPath, image);
    const pids: number[] = [];
    try {
      let fellBack = 0;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const jobId = randomUUID();
        pids.push(await runCommandToEnd(jobId, image));
        if (!releaseOwnedJob(jobId, image)) fellBack += 1;
      }
      expect(fellBack).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(pids.filter((pid) => !alive(pid))).toEqual([]);
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid);
        } catch {
          // Already ended.
        }
      }
      await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 60_000);

  // A host standing in for Sprint Coder: it starts the command as the runner does, puts it in an
  // owned Job, lets it start a long-lived process, releases the Job and exits. Reports that pid.
  // Exits 3 when the release fell back to terminating the whole Job.
  async function startedPidAfterHostExits(image: string, detached: boolean): Promise<number> {
    const host = [
      "const { spawn } = require('node:child_process');",
      'const [addonPath, image, launched, detached] = process.argv.slice(1);',
      'const addon = require(addonPath);',
      "const command = spawn(image, ['-e', [",
      `  "const { spawn } = require('node:child_process');",`,
      `  "process.stdin.once('data', () => {",`,
      `  "  const child = spawn(process.argv[1], ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });",`,
      `  "  child.unref();",`,
      `  "  process.stdout.write(String(child.pid));",`,
      `  "  setInterval(() => {}, 1000);",`,
      `  "});",`,
      "].join('\\n'), launched], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, detached: detached === 'true' });",
      "command.once('spawn', () => {",
      "  addon.assignProcessToOwnedJob(command.pid, 'host-exit');",
      "  command.stdout.once('data', (data) => {",
      "    if (!addon.releaseOwnedJob('host-exit', image)) process.exit(3);",
      '    process.stdout.write(String(data));',
      '    process.exit(0);',
      '  });',
      "  command.stdin.write('go\\n');",
      '});',
    ].join('\n');
    const child = spawn(
      process.execPath,
      ['-e', host, nativeSafeFsAddonPath(), image, process.execPath, String(detached)],
      { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
    );
    let output = '';
    child.stdout.on('data', (data: Buffer) => (output += data.toString()));
    const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
    if (code === 3) return 0;
    expect(code).toBe(0);
    expect(output).toMatch(/^\d+$/u);
    return Number(output);
  }

  it('lets only a detached wrapper leave a released process running after its host exits', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'sprint-coder-job-host-exit-'));
    const image = join(folder, 'command-image.exe');
    await copyFile(process.execPath, image);
    const pids: number[] = [];
    try {
      // The desktop-control run: the app it started stays open when Sprint Coder exits.
      const kept = await startedPidAfterHostExits(image, windowsJobWrapperDetached(true));
      expect(kept).toBeGreaterThan(0);
      pids.push(kept);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(alive(kept)).toBe(true);
      // Any other command: the attached wrapper keeps everything in the host's Job, which ends it
      // with the host even after the owned Job let it go.
      const ended = await startedPidAfterHostExits(image, windowsJobWrapperDetached(false));
      expect(ended).toBeGreaterThan(0);
      pids.push(ended);
      expect(await waitUntil(() => !alive(ended))).toBe(true);
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid);
        } catch {
          // Already ended.
        }
      }
      await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 20_000);
});

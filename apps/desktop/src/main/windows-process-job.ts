import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { nativeSafeFsAddonPath } from './native-safe-fs';

type WindowsJobAddon = Readonly<{
  assignProcessToOwnedJob(pid: number, jobId: string): boolean;
  terminateOwnedJob(jobId: string): boolean;
  closeOwnedJob(jobId: string): boolean;
  runPreparedExecutionImage(executable: string, argv: readonly string[]): number;
}>;

let loadedAddon: WindowsJobAddon | null | undefined;
let resolvedNodeCommand: string | undefined;

export function assignProcessToOwnedJob(pid: number, jobId: string): void {
  if (!addon().assignProcessToOwnedJob(pid, jobId))
    throw new Error('Windows process could not be assigned to its Job Object');
}

export function terminateOwnedJob(jobId: string): boolean {
  return addon().terminateOwnedJob(jobId);
}

export function closeOwnedJob(jobId: string): boolean {
  return addon().closeOwnedJob(jobId);
}

function addon(): WindowsJobAddon {
  if (process.platform !== 'win32') throw new Error('Windows Job Objects are unavailable');
  if (loadedAddon === undefined) {
    try {
      const require = createRequire(join(__dirname, 'windows-process-job-loader.cjs'));
      const candidate = require(nativeSafeFsAddonPath()) as Partial<WindowsJobAddon>;
      loadedAddon =
        typeof candidate.assignProcessToOwnedJob === 'function' &&
        typeof candidate.terminateOwnedJob === 'function' &&
        typeof candidate.closeOwnedJob === 'function' &&
        typeof candidate.runPreparedExecutionImage === 'function'
          ? (candidate as WindowsJobAddon)
          : null;
    } catch {
      loadedAddon = null;
    }
  }
  if (loadedAddon === null) throw new Error('Windows Job Object native boundary is unavailable');
  return loadedAddon;
}

export const WINDOWS_JOB_WRAPPER = String.raw`
const fs = require('node:fs');
let input = '';
const control = fs.createReadStream(null, { fd: 3, encoding: 'utf8', autoClose: false });
control.on('data', (chunk) => { input += chunk; });
control.on('end', () => {
  let request;
  let boundary;
  try { request = JSON.parse(input); } catch { process.exitCode = 125; return; }
  try {
    boundary = require(request.nativeAddonPath);
    if (boundary.enableSafeDllSearchPolicy() !== true) throw new Error('policy unavailable');
  } catch { process.exitCode = 125; return; }
  try {
    process.exitCode = boundary.runPreparedExecutionImage(request.executable, request.argv);
  } catch { process.exitCode = 126; }
});
`;

/**
 * Production packages deliberately disable Electron's RunAsNode fuse. Use the same Node runtime
 * available to the supported Claude/Codex CLI workflow instead of weakening that fuse.
 */
export function windowsJobWrapperCommand(): string {
  if (resolvedNodeCommand !== undefined) return resolvedNodeCommand;
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath !== undefined) {
    const bundled = join(resourcesPath, 'node.exe');
    if (existsSync(bundled)) {
      resolvedNodeCommand = bundled;
      return bundled;
    }
  }
  const output = execFileSync('C:\\Windows\\System32\\where.exe', ['node.exe'], {
    encoding: 'utf8',
    env: process.env,
    windowsHide: true,
  });
  const firstMatch = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstMatch === undefined)
    throw new Error('Node.js is required for Windows command isolation');
  resolvedNodeCommand = firstMatch;
  return resolvedNodeCommand;
}

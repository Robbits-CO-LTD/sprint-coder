import { createRequire } from 'node:module';
import { join } from 'node:path';
import { nativeSafeFsAddonPath } from './native-safe-fs';

type WindowsJobAddon = Readonly<{
  assignProcessToOwnedJob(pid: number, jobId: string): boolean;
  terminateOwnedJob(jobId: string): boolean;
  closeOwnedJob(jobId: string): boolean;
}>;

let loadedAddon: WindowsJobAddon | null | undefined;

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
        typeof candidate.closeOwnedJob === 'function'
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
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let request;
  try { request = JSON.parse(input); } catch { process.exit(125); return; }
  const { spawn } = require('node:child_process');
  const child = spawn(request.executable, request.argv, {
    cwd: request.cwd,
    env: request.env,
    shell: false,
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  child.once('error', () => process.exit(126));
  child.once('exit', (code, signal) => {
    if (typeof code === 'number') process.exit(code);
    process.exit(signal ? 128 : 1);
  });
});
`;

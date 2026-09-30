import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { nativeSafeFsAddonPath } from '../main/native-safe-fs';
import {
  assignProcessToOwnedJob,
  closeOwnedJob,
  ownedJobActiveProcesses,
  terminateRetainedOwnedJob,
  WINDOWS_JOB_WRAPPER,
  windowsJobWrapperCommand,
} from '../main/windows-process-job';

export const WINDOWS_CLI_JOB_STOP_TIMEOUT_MS = 2_000;
const JOB_POLL_MS = 25;
type OwnedCli = {
  id: string;
  assigned: boolean;
  canceled: boolean;
  ready: Promise<void>;
  stopped?: Promise<boolean>;
};
const jobs = new WeakMap<ChildProcessWithoutNullStreams, OwnedCli>();

/** The CLI cannot start, or create descendants, before its wrapper belongs to our Job. */
export function spawnOwnedCliProcess(
  executable: string,
  argv: readonly string[],
  options: SpawnOptionsWithoutStdio,
  beforeLaunch: (pid: number) => void | boolean,
): ChildProcessWithoutNullStreams {
  if (process.platform !== 'win32') return spawn(executable, [...argv], options);
  const child = spawn(windowsJobWrapperCommand(), ['-e', WINDOWS_JOB_WRAPPER], {
    ...options,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  let ready!: () => void;
  const ownership: OwnedCli = {
    id: randomUUID(),
    assigned: false,
    canceled: false,
    ready: new Promise<void>((resolve) => {
      ready = resolve;
    }),
  };
  jobs.set(child, ownership);
  child.once('error', ready);
  child.once('spawn', () => {
    try {
      if (child.pid === undefined) throw new Error('CLI wrapper PID is unavailable');
      assignProcessToOwnedJob(child.pid, ownership.id);
      ownership.assigned = true;
      // Also probes the confirmation API before releasing the startup gate.
      ownedJobActiveProcesses(ownership.id);
      if (!ownership.canceled) {
        const gate = child.stdio[3];
        if (gate === null || gate === undefined || !('end' in gate))
          throw new Error('CLI startup gate is unavailable');
        gate.once('error', (error) => {
          void stopOwnedCliProcess(child);
          child.emit('error', error);
        });
        if (beforeLaunch(child.pid) === false)
          throw new Error('CLI process identity is unavailable');
        if (!ownership.canceled)
          gate.end(
            JSON.stringify({
              executable,
              argv,
              env: options.env,
              cwd: options.cwd,
              nativeAddonPath: nativeSafeFsAddonPath(),
            }),
          );
      }
      ready();
    } catch (error) {
      ownership.canceled = true;
      ready();
      // The gate is still closed: no CLI work or descendants have been admitted. Drop the
      // owned Job even when its new confirmation API is missing, then kill the blocked wrapper.
      if (ownership.assigned) {
        try {
          if (closeOwnedJob(ownership.id)) ownership.assigned = false;
        } catch {
          // A retained handle still has KILL_ON_JOB_CLOSE protection at Host teardown.
        }
      }
      child.kill();
      void stopOwnedCliProcess(child);
      child.emit('error', error instanceof Error ? error : new Error('CLI Job setup failed'));
    }
  });
  return child;
}

export function stopOwnedCliProcess(
  child: ChildProcessWithoutNullStreams,
): Promise<boolean> | undefined {
  const ownership = jobs.get(child);
  if (ownership === undefined) return undefined;
  ownership.canceled = true;
  return (ownership.stopped ??= (async () => {
    await ownership.ready;
    if (!ownership.assigned) return false;
    try {
      if (!terminateRetainedOwnedJob(ownership.id)) return false;
      const deadline = Date.now() + WINDOWS_CLI_JOB_STOP_TIMEOUT_MS;
      while (ownedJobActiveProcesses(ownership.id) !== 0) {
        if (Date.now() >= deadline) return false;
        await new Promise<void>((resolve) => setTimeout(resolve, JOB_POLL_MS));
      }
      return closeOwnedJob(ownership.id);
    } catch {
      // Retain the Job on uncertainty: host teardown still has KILL_ON_JOB_CLOSE protection.
      return false;
    }
  })());
}

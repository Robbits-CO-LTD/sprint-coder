import { createHash, randomUUID } from 'node:crypto';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, readFileSync } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { delimiter, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import {
  createExecutionSpec,
  validateExecutionSpec,
  type ExecutionSpec,
} from '@sprint-coder/domain';
import {
  createPathGuard,
  pathGuardIdentityDigest,
  revalidatePathGuard,
  type PathGuard,
} from './path-guard';
import { sanitizeTerminalOutput, type TerminalOutputSanitizer } from './ansi-sanitizer';
import { createStreamingSecretRedactor } from './secret-redactor';
import {
  assignProcessToOwnedJob,
  closeOwnedJob,
  terminateOwnedJob,
  WINDOWS_JOB_WRAPPER,
} from './windows-process-job';

export type CommandOutputChunk = Readonly<{
  seq: number;
  stream: 'stdout' | 'stderr';
  text: string;
  byteLength: number;
}>;

export type CommandResult = Readonly<{
  executionId: string;
  exitCode: number | null;
  signal: string | null;
  canceled: boolean;
  termination: 'natural' | 'cooperative' | 'forced';
  durationMs: number;
  outputBytes: number;
  truncated: boolean;
}>;

export type PrepareExecutionSpecInput = Readonly<{
  workspacePath: string;
  executable: string;
  argv: readonly string[];
  cwd?: string;
}>;

type PreparedIdentity = {
  pathGuard: PathGuard;
  executableCanonicalPath: string;
  executableDev: string;
  executableIno: string;
  executableSize: number;
  executableMtimeMs: number;
  executableCtimeMs: number;
  executableMode: number;
  executableDigest: string;
};

const issuedSpecs = new WeakMap<object, PreparedIdentity>();
const execFileAsync = promisify(execFile);

export class CommandRunnerError extends Error {
  constructor(
    readonly code:
      | 'EXECUTION_SPEC_INVALID'
      | 'EXECUTION_IDENTITY_CHANGED'
      | 'SPAWN_FAILED'
      | 'OUTPUT_OVERFLOW'
      | 'PROCESS_TREE_TERMINATION_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'CommandRunnerError';
  }
}

export async function prepareExecutionSpec(
  input: PrepareExecutionSpecInput,
): Promise<ExecutionSpec> {
  if (!isAbsolute(input.executable))
    throw new CommandRunnerError('EXECUTION_SPEC_INVALID', 'Executable must be absolute');
  const executableCanonicalPath = await realpath(input.executable);
  const executableStats = await stat(executableCanonicalPath);
  if (!executableStats.isFile())
    throw new CommandRunnerError('EXECUTION_SPEC_INVALID', 'Executable must be a regular file');
  const pathGuard = await createPathGuard({
    workspacePath: input.workspacePath,
    targetPath: input.cwd ?? '.',
    operation: 'read',
  });
  if (pathGuard.targetIdentity?.kind !== 'directory')
    throw new CommandRunnerError('EXECUTION_SPEC_INVALID', 'Command cwd must be a directory');
  const spec = createExecutionSpec({
    absoluteExecutable: executableCanonicalPath,
    argv: input.argv,
    cwdIdentity: {
      canonicalPath: pathGuard.resolvedPath,
      identityDigest: pathGuardIdentityDigest(pathGuard),
    },
    envDelta: buildControlledEnvironment(),
    stdinMode: 'closed',
    shell: 'none',
  });
  issuedSpecs.set(spec, {
    pathGuard,
    executableCanonicalPath,
    executableDev: String(executableStats.dev),
    executableIno: String(executableStats.ino),
    executableSize: executableStats.size,
    executableMtimeMs: executableStats.mtimeMs,
    executableCtimeMs: executableStats.ctimeMs,
    executableMode: executableStats.mode,
    executableDigest: await digestFile(executableCanonicalPath),
  });
  return spec;
}

export function executionSpecPathGuard(spec: ExecutionSpec): PathGuard {
  const identity = issuedSpecs.get(spec);
  if (identity === undefined)
    throw new CommandRunnerError(
      'EXECUTION_SPEC_INVALID',
      'ExecutionSpec was not sealed by CommandRunner preparation',
    );
  return identity.pathGuard;
}

type RunnerOptions = Readonly<{
  batchIntervalMs?: number;
  maxBatchBytes?: number;
  maxBufferedBytes?: number;
  maxOutputBytes?: number;
  cancelGraceMs?: number;
}>;

type RunOptions = Readonly<{
  signal?: AbortSignal;
  beforeSpawn?: () => void;
  onChunk?: (chunk: CommandOutputChunk) => void | Promise<void>;
  onBatch?: (chunks: readonly CommandOutputChunk[]) => void | Promise<void>;
  onStarted?: (
    process: Readonly<{
      executionId: string;
      pid: number;
      startedAt: number;
      processStartIdentity: string;
    }>,
  ) => void;
}>;

type ActiveProcess = {
  lease: string;
  child: ChildProcess;
  pid: number;
  startedAt: number;
  processStartIdentity: string;
  settled: Promise<void>;
  resolveSettled: () => void;
  outcome: Promise<{ exitCode: number | null; signal: string | null }>;
  windowsJobId?: string;
  windowsOwnedPids?: Promise<readonly Readonly<{ pid: number; processStartIdentity: string }>[]>;
};

export class CommandRunner {
  private readonly batchIntervalMs: number;
  private readonly maxBatchBytes: number;
  private readonly maxBufferedBytes: number;
  private readonly maxOutputBytes: number;
  private readonly cancelGraceMs: number;
  private readonly active = new Map<string, ActiveProcess>();

  constructor(options: RunnerOptions = {}) {
    this.batchIntervalMs = options.batchIntervalMs ?? 100;
    this.maxBatchBytes = options.maxBatchBytes ?? 64 * 1024;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 1024 * 1024;
    this.maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
    this.cancelGraceMs = options.cancelGraceMs ?? 1_500;
    if (
      this.batchIntervalMs < 1 ||
      this.maxBatchBytes < 1 ||
      this.maxBatchBytes > 64 * 1024 ||
      this.maxBufferedBytes < this.maxBatchBytes ||
      this.maxOutputBytes < 1 ||
      this.cancelGraceMs < 0
    )
      throw new Error('Invalid CommandRunner limits');
  }

  get activeCount(): number {
    return this.active.size;
  }

  async dispose(): Promise<void> {
    const entries = [...this.active.entries()];
    const forceResults = await Promise.allSettled(
      entries.map(([executionId, active]) => this.forceOwnedTree(executionId, active.lease)),
    );
    const settlements = entries.map(([, active]) => active.settled);
    const settled = await Promise.race([
      Promise.allSettled(settlements).then(() => true),
      delay(5_000).then(() => false),
    ]);
    const forceFailure = forceResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (forceFailure !== undefined) throw forceFailure.reason;
    if (!settled)
      throw new CommandRunnerError(
        'PROCESS_TREE_TERMINATION_FAILED',
        'CommandRunner shutdown could not drain every owned process',
      );
  }

  async run(spec: ExecutionSpec, options: RunOptions = {}): Promise<CommandResult> {
    await this.revalidate(spec);
    if (options.signal?.aborted)
      return {
        executionId: randomUUID(),
        exitCode: null,
        signal: null,
        canceled: true,
        termination: 'cooperative',
        durationMs: 0,
        outputBytes: 0,
        truncated: false,
      };
    const executionId = randomUUID();
    const lease = randomUUID();
    const startedAt = Date.now();
    options.beforeSpawn?.();
    let child: ChildProcess;
    try {
      const windows = process.platform === 'win32';
      child = spawn(
        windows ? process.execPath : spec.absoluteExecutable,
        [...(windows ? ['-e', WINDOWS_JOB_WRAPPER] : spec.argv)],
        {
          cwd: spec.cwdIdentity.canonicalPath,
          env: buildEnvironment(spec.envDelta),
          shell: false,
          stdio: [windows ? 'pipe' : 'ignore', 'pipe', 'pipe'],
          detached: !windows,
          windowsHide: true,
        },
      );
    } catch (error) {
      throw new CommandRunnerError('SPAWN_FAILED', errorMessage(error));
    }
    const outcomePromise = waitForClose(child);
    void outcomePromise.catch(() => undefined);
    try {
      await waitForSpawn(child);
    } catch (error) {
      throw new CommandRunnerError('SPAWN_FAILED', errorMessage(error));
    }
    if (child.pid === undefined)
      throw new CommandRunnerError('SPAWN_FAILED', 'Command process did not receive a PID');
    if (process.platform === 'win32') {
      try {
        assignProcessToOwnedJob(child.pid, executionId);
        child.stdin?.end(
          JSON.stringify({
            executable: spec.absoluteExecutable,
            argv: [...spec.argv],
            cwd: spec.cwdIdentity.canonicalPath,
            env: buildEnvironment(spec.envDelta),
          }),
        );
      } catch (error) {
        child.kill();
        throw new CommandRunnerError('SPAWN_FAILED', errorMessage(error));
      }
    }
    let resolveSettled = (): void => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const active: ActiveProcess = {
      lease,
      child,
      pid: child.pid,
      startedAt,
      processStartIdentity: 'pending',
      settled,
      resolveSettled,
      outcome: outcomePromise,
      ...(process.platform === 'win32' ? { windowsJobId: executionId } : {}),
    };
    this.active.set(executionId, active);
    const bufferedOutput: { stream: 'stdout' | 'stderr'; data: Buffer }[] = [];
    let bufferedOutputBytes = 0;
    let outputConsumer = (stream: 'stdout' | 'stderr', data: Buffer): void => {
      const copy = Buffer.from(data);
      bufferedOutput.push({ stream, data: copy });
      bufferedOutputBytes += copy.byteLength;
      if (bufferedOutputBytes >= this.maxBufferedBytes) {
        child.stdout?.pause();
        child.stderr?.pause();
      }
    };
    child.stdout?.on('data', (data: Buffer) => outputConsumer('stdout', data));
    child.stderr?.on('data', (data: Buffer) => outputConsumer('stderr', data));
    const processStartIdentity = await readProcessStartIdentity(child.pid);
    if (processStartIdentity === 'unavailable' || processStartIdentity.startsWith('unsupported:')) {
      try {
        await this.forceUnidentifiedProcess(active);
        this.active.delete(executionId);
        active.resolveSettled();
        throw new CommandRunnerError(
          'SPAWN_FAILED',
          'Command process start identity is unavailable',
        );
      } catch (error) {
        if (error instanceof CommandRunnerError && error.code === 'PROCESS_TREE_TERMINATION_FAILED')
          this.retainUntilOutcome(executionId, active);
        throw error;
      }
    }
    active.processStartIdentity = processStartIdentity;
    try {
      options.onStarted?.({
        executionId,
        pid: child.pid,
        startedAt,
        processStartIdentity,
      });
    } catch (error) {
      try {
        await this.terminateKnownAndWait(executionId, lease, active.outcome);
        this.active.delete(executionId);
        active.resolveSettled();
        throw error;
      } catch (terminationError) {
        if (
          terminationError instanceof CommandRunnerError &&
          terminationError.code === 'PROCESS_TREE_TERMINATION_FAILED'
        )
          this.retainUntilOutcome(executionId, active);
        throw terminationError;
      }
    }

    let nextSeq = 1;
    let outputBytes = 0;
    let pendingBytes = 0;
    let truncated = false;
    let sinkError: unknown;
    let canceled = false;
    let termination: CommandResult['termination'] = 'natural';
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    // `sealed` marks a segment that has already been snapshotted into a batch handed to the sink.
    // `queueText` must not append to such a segment: the batch holds a value copy, so a late append
    // would be invisible to the sink yet still removed by this flush's `pending.splice`, silently
    // losing that output (see the regression test in command-runner.test.ts).
    const pending: {
      stream: 'stdout' | 'stderr';
      text: string;
      byteLength: number;
      sealed?: boolean;
    }[] = [];
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const sanitizers: Record<'stdout' | 'stderr', TerminalOutputSanitizer> = {
      stdout: sanitizeTerminalOutput.createStream(),
      stderr: sanitizeTerminalOutput.createStream(),
    };
    const redactors = {
      stdout: createStreamingSecretRedactor(),
      stderr: createStreamingSecretRedactor(),
    };
    let terminationError: unknown;
    let rejectTerminationFailure: ((error: unknown) => void) | undefined;
    const terminationFailure = new Promise<never>((_resolve, reject) => {
      rejectTerminationFailure = reject;
    });
    let terminationWatchdog: ReturnType<typeof setTimeout> | undefined;

    let flushChain = Promise.resolve();
    const flush = (): Promise<void> => {
      if (flushTimer !== undefined) clearTimeout(flushTimer);
      flushTimer = undefined;
      flushChain = flushChain.then(async () => {
        while (pending.length > 0 && sinkError === undefined) {
          const count = pending.length;
          // Seal before snapshotting: from here until the splice below these segments are in
          // flight, and any further output must start a new segment instead of appending to one
          // the sink has already been handed a copy of. Fields are listed explicitly rather than
          // spread so `sealed` never leaks into the public CommandOutputChunk shape.
          const batch = pending.slice(0, count).map((segment, index) => {
            segment.sealed = true;
            return Object.freeze({
              seq: nextSeq + index,
              stream: segment.stream,
              text: segment.text,
              byteLength: segment.byteLength,
            });
          });
          try {
            if (options.onBatch !== undefined) await options.onBatch(Object.freeze(batch));
            else if (options.onChunk !== undefined)
              for (const chunk of batch) await options.onChunk(chunk);
          } catch (error) {
            sinkError = error;
            truncated = true;
            try {
              await this.forceOwnedTree(executionId, lease);
              terminationWatchdog = setTimeout(() => {
                const failure = new CommandRunnerError(
                  'PROCESS_TREE_TERMINATION_FAILED',
                  'Process did not close after output persistence failed',
                );
                terminationError = failure;
                rejectTerminationFailure?.(failure);
              }, 5_000);
            } catch (terminationFailure) {
              sinkError = terminationFailure;
              terminationError = terminationFailure;
              rejectTerminationFailure?.(terminationFailure);
            }
            break;
          }
          pending.splice(0, count);
          pendingBytes -= batch.reduce((total, chunk) => total + chunk.byteLength, 0);
          nextSeq += count;
        }
        if (pendingBytes < this.maxBufferedBytes) {
          child.stdout?.resume();
          child.stderr?.resume();
        }
      });
      return flushChain;
    };
    const queueText = (stream: 'stdout' | 'stderr', text: string): void => {
      if (text.length === 0) return;
      for (const part of splitUtf8(text, this.maxBatchBytes)) {
        const byteLength = Buffer.byteLength(part);
        if (outputBytes + byteLength > this.maxOutputBytes) {
          truncated = true;
          break;
        }
        outputBytes += byteLength;
        pendingBytes += byteLength;
        const previous = pending.at(-1);
        if (
          previous !== undefined &&
          previous.sealed !== true &&
          previous.stream === stream &&
          previous.byteLength + byteLength <= this.maxBatchBytes
        ) {
          previous.text += part;
          previous.byteLength += byteLength;
        } else pending.push({ stream, text: part, byteLength });
      }
      if (pendingBytes >= this.maxBufferedBytes) {
        child.stdout?.pause();
        child.stderr?.pause();
        void flush();
      } else if (pendingBytes >= this.maxBatchBytes) void flush();
      else if (flushTimer === undefined)
        flushTimer = setTimeout(() => void flush(), this.batchIntervalMs);
    };
    const ingest = (stream: 'stdout' | 'stderr', data: Buffer): void => {
      const decoded = decoders[stream].write(data);
      queueText(stream, redactors[stream].write(sanitizers[stream].write(decoded)));
    };
    outputConsumer = ingest;
    for (const buffered of bufferedOutput) ingest(buffered.stream, buffered.data);
    bufferedOutput.length = 0;
    bufferedOutputBytes = 0;
    if (pendingBytes < this.maxBufferedBytes) {
      child.stdout?.resume();
      child.stderr?.resume();
    }
    let streamsFinalized = false;
    const finalizeStreams = async (): Promise<void> => {
      if (streamsFinalized) return;
      streamsFinalized = true;
      queueText(
        'stdout',
        redactors.stdout.write(
          sanitizers.stdout.write(decoders.stdout.end()) + sanitizers.stdout.end(),
        ) + redactors.stdout.end(),
      );
      queueText(
        'stderr',
        redactors.stderr.write(
          sanitizers.stderr.write(decoders.stderr.end()) + sanitizers.stderr.end(),
        ) + redactors.stderr.end(),
      );
      await flush();
    };

    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveForce: (() => void) | undefined;
    let forcePromise: Promise<void> | undefined;
    const cancel = (): void => {
      if (canceled) return;
      canceled = true;
      termination = 'cooperative';
      if (process.platform !== 'win32') this.signalOwnedTree(executionId, lease, 'SIGTERM');
      forcePromise = new Promise<void>((resolve) => {
        resolveForce = resolve;
      });
      forceTimer = setTimeout(() => {
        void (async () => {
          try {
            if (await this.forceOwnedTree(executionId, lease)) termination = 'forced';
            if (terminationWatchdog === undefined)
              terminationWatchdog = setTimeout(() => {
                const failure = new CommandRunnerError(
                  'PROCESS_TREE_TERMINATION_FAILED',
                  'Canceled process tree did not close after forced termination',
                );
                terminationError = failure;
                rejectTerminationFailure?.(failure);
              }, 5_000);
          } catch (error) {
            terminationError = error;
            rejectTerminationFailure?.(error);
          }
          resolveForce?.();
        })();
      }, this.cancelGraceMs);
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();

    let retainActive = false;
    try {
      const outcome = await waitForOutcomeOrTerminationFailure(outcomePromise, terminationFailure);
      if (canceled && this.ownedTreeAlive(executionId, lease)) await forcePromise;
      else if (forceTimer !== undefined) {
        clearTimeout(forceTimer);
        forceTimer = undefined;
        resolveForce?.();
      }
      if (terminationError !== undefined) throw terminationError;
      if (terminationWatchdog !== undefined) clearTimeout(terminationWatchdog);
      await finalizeStreams();
      if (sinkError !== undefined) throw sinkError;
      return Object.freeze({
        executionId,
        ...outcome,
        canceled,
        termination,
        durationMs: Date.now() - startedAt,
        outputBytes,
        truncated,
      });
    } catch (error) {
      if (error instanceof CommandRunnerError && error.code === 'PROCESS_TREE_TERMINATION_FAILED') {
        retainActive = true;
        sinkError = error;
        const release = async (): Promise<void> => {
          try {
            await finalizeStreams();
          } finally {
            if (this.active.get(executionId) === active) this.active.delete(executionId);
            if (active.windowsJobId !== undefined) closeOwnedJob(active.windowsJobId);
            active.resolveSettled();
          }
        };
        void active.outcome.then(release, release);
      }
      throw error;
    } finally {
      if (flushTimer !== undefined) clearTimeout(flushTimer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      if (terminationWatchdog !== undefined) clearTimeout(terminationWatchdog);
      options.signal?.removeEventListener('abort', cancel);
      if (!retainActive && this.active.get(executionId) === active) this.active.delete(executionId);
      if (!retainActive) {
        if (active.windowsJobId !== undefined) closeOwnedJob(active.windowsJobId);
        active.resolveSettled();
      }
    }
  }

  private async revalidate(spec: ExecutionSpec): Promise<void> {
    const identity = issuedSpecs.get(spec);
    if (!validateExecutionSpec(spec) || identity === undefined)
      throw new CommandRunnerError(
        'EXECUTION_SPEC_INVALID',
        'ExecutionSpec was not sealed by CommandRunner preparation',
      );
    try {
      await revalidatePathGuard(identity.pathGuard);
      const executableCanonicalPath = await realpath(spec.absoluteExecutable);
      const executableStats = await stat(executableCanonicalPath);
      if (
        executableCanonicalPath !== identity.executableCanonicalPath ||
        String(executableStats.dev) !== identity.executableDev ||
        String(executableStats.ino) !== identity.executableIno ||
        executableStats.size !== identity.executableSize ||
        executableStats.mtimeMs !== identity.executableMtimeMs ||
        executableStats.ctimeMs !== identity.executableCtimeMs ||
        executableStats.mode !== identity.executableMode ||
        (await digestFile(executableCanonicalPath)) !== identity.executableDigest
      )
        throw new Error('Executable identity changed');
    } catch (error) {
      throw new CommandRunnerError('EXECUTION_IDENTITY_CHANGED', errorMessage(error));
    }
  }

  private signalOwnedTree(
    executionId: string,
    lease: string,
    signal: 'SIGTERM' | 'SIGKILL',
  ): boolean {
    const active = this.active.get(executionId);
    if (
      active === undefined ||
      active.lease !== lease ||
      active.child.exitCode !== null ||
      active.child.signalCode !== null
    )
      return false;
    if (readProcessStartIdentity(active.pid) !== active.processStartIdentity) return false;
    try {
      if (process.platform === 'win32') return false;
      process.kill(-active.pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  private async forceOwnedTree(executionId: string, lease: string): Promise<boolean> {
    const active = this.active.get(executionId);
    if (active === undefined || active.lease !== lease) return false;
    if (active.processStartIdentity === 'pending') {
      await this.forceUnidentifiedProcess(active);
      return true;
    }
    try {
      if (process.platform === 'win32') {
        if (active.windowsJobId !== undefined) return terminateOwnedJob(active.windowsJobId);
        let descendants: readonly Readonly<{ pid: number; processStartIdentity: string }>[];
        try {
          descendants = await (active.windowsOwnedPids ?? captureWindowsProcessTree(active.pid));
        } catch {
          descendants = await captureWindowsProcessTree(active.pid);
        }
        const candidates = [
          ...[...descendants].reverse(),
          { pid: active.pid, processStartIdentity: active.processStartIdentity },
        ];
        const current = await queryWindowsProcesses();
        const targets = candidates.filter(
          (candidate) =>
            current.get(candidate.pid)?.processStartIdentity === candidate.processStartIdentity,
        );
        await Promise.allSettled(targets.map(({ pid }) => runTaskkill(pid, true)));
        await verifyWindowsProcessesExited(targets, 3_000);
        return targets.length > 0;
      }
      const leaderAlive = active.child.exitCode === null && active.child.signalCode === null;
      if (leaderAlive && readProcessStartIdentity(active.pid) !== active.processStartIdentity)
        return false;
      process.kill(-active.pid, 'SIGKILL');
      return true;
    } catch (error) {
      if (error instanceof CommandRunnerError) throw error;
      if (process.platform === 'win32')
        throw new CommandRunnerError('PROCESS_TREE_TERMINATION_FAILED', errorMessage(error));
      return false;
    }
  }

  private async terminateKnownAndWait(
    executionId: string,
    lease: string,
    outcome: Promise<unknown>,
  ): Promise<void> {
    await this.forceOwnedTree(executionId, lease);
    await waitWithTimeout(outcome, 5_000, 'Owned process did not close after forced termination');
  }

  private async forceUnidentifiedProcess(active: ActiveProcess): Promise<void> {
    try {
      if (process.platform === 'win32' && active.windowsJobId !== undefined)
        terminateOwnedJob(active.windowsJobId);
      else if (process.platform === 'win32') await runTaskkill(active.pid, true);
      else process.kill(-active.pid, 'SIGKILL');
      await waitWithTimeout(
        active.outcome,
        5_000,
        'Unidentified process did not close after forced termination',
      );
    } catch (error) {
      if (error instanceof CommandRunnerError && error.code === 'PROCESS_TREE_TERMINATION_FAILED')
        throw error;
      throw new CommandRunnerError('PROCESS_TREE_TERMINATION_FAILED', errorMessage(error));
    }
  }

  private retainUntilOutcome(executionId: string, active: ActiveProcess): void {
    const release = (): void => {
      if (this.active.get(executionId) === active) this.active.delete(executionId);
      if (active.windowsJobId !== undefined) closeOwnedJob(active.windowsJobId);
      active.resolveSettled();
    };
    void active.outcome.then(release, release);
  }

  private ownedTreeAlive(executionId: string, lease: string): boolean {
    const active = this.active.get(executionId);
    if (active === undefined || active.lease !== lease) return false;
    if (process.platform === 'win32') return true;
    try {
      process.kill(-active.pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

async function captureWindowsProcessTree(
  rootPid: number,
): Promise<readonly Readonly<{ pid: number; processStartIdentity: string }>[]> {
  if (process.platform !== 'win32') return [];
  const processes = await queryWindowsProcesses();
  const descendants: Readonly<{ pid: number; processStartIdentity: string }>[] = [];
  let frontier = [rootPid];
  while (frontier.length > 0) {
    const parents = new Set(frontier);
    const children = [...processes.values()].filter((process) => parents.has(process.parentPid));
    descendants.push(...children);
    frontier = children.map(({ pid }) => pid);
  }
  return descendants;
}

async function runTaskkill(pid: number, force: boolean): Promise<void> {
  const args = ['/PID', String(pid), '/T'];
  if (force) args.push('/F');
  await execFileAsync('C:\\Windows\\System32\\taskkill.exe', args, {
    shell: false,
    windowsHide: true,
    timeout: 3_000,
  });
}

type WindowsProcessIdentity = Readonly<{
  pid: number;
  parentPid: number;
  processStartIdentity: string;
}>;

async function queryWindowsProcesses(): Promise<ReadonlyMap<number, WindowsProcessIdentity>> {
  if (process.platform !== 'win32') return new Map();
  const script =
    `Get-CimInstance Win32_Process | ForEach-Object { ` +
    `[PSCustomObject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;` +
    `identity=('win32:' + $_.CreationDate.ToUniversalTime().Ticks)} } | ConvertTo-Json -Compress`;
  const { stdout } = await execFileAsync(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 3_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  );
  if (stdout.trim().length === 0) return new Map();
  const parsed = JSON.parse(stdout) as
    | { pid: number; parentPid: number; identity: string }
    | { pid: number; parentPid: number; identity: string }[];
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return new Map(
    rows
      .filter(
        (row) =>
          Number.isInteger(row.pid) &&
          row.pid > 0 &&
          Number.isInteger(row.parentPid) &&
          typeof row.identity === 'string',
      )
      .map((row) => [
        row.pid,
        {
          pid: row.pid,
          parentPid: row.parentPid,
          processStartIdentity: row.identity,
        },
      ]),
  );
}

async function verifyWindowsProcessesExited(
  targets: readonly Readonly<{ pid: number; processStartIdentity: string }>[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const current = await queryWindowsProcesses();
    const survivors = targets.filter(
      (target) => current.get(target.pid)?.processStartIdentity === target.processStartIdentity,
    );
    if (survivors.length === 0) return;
    await delay(50);
  }
  throw new CommandRunnerError(
    'PROCESS_TREE_TERMINATION_FAILED',
    'Windows process tree did not terminate before the deadline',
  );
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      child.off('error', onError);
      resolve();
    };
    const onError = (error: Error): void => {
      child.off('spawn', onSpawn);
      reject(error);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function waitForClose(
  child: ChildProcess,
): Promise<{ exitCode: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', (error) => reject(new CommandRunnerError('SPAWN_FAILED', error.message)));
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

export function waitForOutcomeOrTerminationFailure<T>(
  outcome: Promise<T>,
  terminationFailure: Promise<never>,
): Promise<T> {
  return Promise.race([outcome, terminationFailure]);
}

export function readProcessStartIdentity(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) return 'invalid';
  try {
    if (process.platform === 'linux') {
      const statLine = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = statLine.lastIndexOf(')');
      return `linux:${statLine.slice(close + 2).split(' ')[19] ?? ''}`;
    }
    if (process.platform === 'darwin' || process.platform === 'freebsd')
      return `${process.platform}:${execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 1_000,
      }).trim()}`;
    if (process.platform === 'win32')
      return `win32:${execFileSync(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CreationDate.ToUniversalTime().Ticks`,
        ],
        { encoding: 'utf8', timeout: 2_000, windowsHide: true },
      ).trim()}`;
  } catch {
    return 'unavailable';
  }
  return `unsupported:${pid}`;
}

function buildEnvironment(delta: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(delta));
}

function buildControlledEnvironment(): Readonly<Record<string, string>> {
  const allowed = [
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
  ];
  const environment: Record<string, string> = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment['PATH'] =
    process.platform === 'win32'
      ? ['C:\\Windows\\System32', 'C:\\Windows'].join(delimiter)
      : ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter);
  return environment;
}

function splitUtf8(text: string, maxBytes: number): string[] {
  const parts: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character);
    if (currentBytes > 0 && currentBytes + characterBytes > maxBytes) {
      parts.push(current);
      current = '';
      currentBytes = 0;
    }
    current += character;
    currentBytes += characterBytes;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

function digestFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitWithTimeout<T>(outcome: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return Promise.race([
    outcome,
    delay(timeoutMs).then(() => {
      throw new CommandRunnerError('PROCESS_TREE_TERMINATION_FAILED', message);
    }),
  ]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

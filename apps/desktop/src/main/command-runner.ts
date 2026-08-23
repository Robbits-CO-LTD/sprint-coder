import { randomUUID } from 'node:crypto';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { delimiter, extname, isAbsolute, join, relative, win32 as windowsPath } from 'node:path';
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
import { nativeSafeFsAddonPath } from './native-safe-fs';
import { queryNativeProcessIdentity } from './native-process-identity';
import {
  getTrustedWindowsSystemDirectory,
  prepareExecutionImage,
  sealExecutablePath,
  sealedExecutableIdentityDigest,
  type PreparedExecutionImage,
  type SealedExecutableIdentity,
} from './prepared-execution-image';
import { createStreamingSecretRedactor } from './secret-redactor';
import {
  assignProcessToOwnedJob,
  closeOwnedJob,
  terminateOwnedJob,
  WINDOWS_JOB_WRAPPER,
  windowsJobWrapperCommand,
} from './windows-process-job';
import { sandboxRunnerPath, verifySandboxRunnerDigest } from './sandbox-runner';

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
  rootId?: string | undefined;
  workspacePath: string;
  expectedRootIdentityDigest?: string | undefined;
  executable: string;
  argv: readonly string[];
  cwd?: string;
}>;

type PreparedIdentity = {
  pathGuard: PathGuard;
  executable: SealedExecutableIdentity;
};

const issuedSpecs = new WeakMap<object, PreparedIdentity>();
const execFileAsync = promisify(execFile);

// The platform shell is available in packaged macOS/Linux builds, unlike Electron's fused-off
// RunAsNode mode. It remains the process-group leader, reports the target outcome on fd 3, then
// execs an ignored-TERM sleep in place so its captured PID/start identity stays verifiable.
const POSIX_COMMAND_WRAPPER = String.raw`
IFS= read -r control_nonce <&4 || exit 125
exec 4<&-
trap '' TERM
exec 6<&0
if [ ! -x "$1" ]; then
  printf '{"nonce":"%s","type":"spawnError","status":126}\n' "$control_nonce" >&3
  exec /bin/sleep 2147483647
fi
(
  trap - TERM
  IFS= read -r gate <&5 || exit 125
  exec 5<&-
  exec "$@" 3>&- <&6 6<&-
) &
target_pid=$!
printf '{"nonce":"%s","type":"started","pid":%s}\n' "$control_nonce" "$target_pid" >&3
# Linux shells may diagnose a signal-terminated asynchronous job from wait on the shell's
# stderr. That supervisor-owned diagnostic must not contaminate the requested command's stderr.
wait "$target_pid" 2>/dev/null
status=$?
printf '{"nonce":"%s","type":"outcome","exitCode":%s,"signal":null}\n' "$control_nonce" "$status" >&3
exec /bin/sleep 2147483647
`;

export function posixSupervisorCommand(): string {
  return '/bin/sh';
}

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
  const controlledEnvironment = buildControlledEnvironment();
  const executablePath = isAbsolute(input.executable)
    ? input.executable
    : await resolveBareExecutable(input.executable, controlledEnvironment);
  const executableCanonicalPath = await realpath(executablePath);
  const executableStats = await stat(executableCanonicalPath, { bigint: true });
  if (!executableStats.isFile())
    throw new CommandRunnerError('EXECUTION_SPEC_INVALID', 'Executable must be a regular file');
  const allowSourceHardlinks = await isTrustedWindowsMultiLinkExecutable(executableCanonicalPath);
  if (executableStats.nlink !== 1n && !allowSourceHardlinks)
    throw new CommandRunnerError('EXECUTION_SPEC_INVALID', 'Executable must have one link');
  const pathGuard = await createPathGuard({
    rootId: input.rootId,
    workspacePath: input.workspacePath,
    expectedRootIdentityDigest: input.expectedRootIdentityDigest,
    targetPath: input.cwd ?? '.',
    operation: 'read',
  });
  if (pathGuard.targetIdentity?.kind !== 'directory')
    throw new CommandRunnerError('EXECUTION_SPEC_INVALID', 'Command cwd must be a directory');
  const executableIdentity = await sealExecutablePath(
    executableCanonicalPath,
    allowSourceHardlinks,
  );
  const spec = createExecutionSpec({
    absoluteExecutable: executableCanonicalPath,
    executionIdentityDigest: sealedExecutableIdentityDigest(executableIdentity),
    argv: input.argv,
    cwdIdentity: {
      canonicalPath: pathGuard.resolvedPath,
      identityDigest: pathGuardIdentityDigest(pathGuard),
    },
    envDelta: controlledEnvironment,
    stdinMode: 'closed',
    shell: 'none',
  });
  issuedSpecs.set(spec, {
    pathGuard,
    executable: executableIdentity,
  });
  return spec;
}

async function resolveBareExecutable(
  executable: string,
  environment: Readonly<Record<string, string>>,
): Promise<string> {
  if (
    executable.length < 1 ||
    executable.length > 255 ||
    executable.includes('/') ||
    executable.includes('\\') ||
    !/^[a-zA-Z0-9._+-]+$/u.test(executable)
  )
    throw new CommandRunnerError(
      'EXECUTION_SPEC_INVALID',
      'Executable must be absolute or one sanitized bare name',
    );
  const searchPath = environment['PATH'];
  if (searchPath === undefined)
    throw new CommandRunnerError('EXECUTION_SPEC_INVALID', 'Sanitized executable PATH is empty');
  const names =
    process.platform === 'win32' && extname(executable) === ''
      ? [`${executable}.exe`, `${executable}.com`]
      : [executable];
  for (const directory of searchPath.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        const candidateStats = await stat(candidate);
        if (!candidateStats.isFile()) continue;
        if (process.platform !== 'win32' && (candidateStats.mode & 0o111) === 0) continue;
        return candidate;
      } catch {
        // Continue through the sealed, fixed PATH. No shell lookup or cwd fallback is allowed.
      }
    }
  }
  throw new CommandRunnerError(
    'EXECUTION_SPEC_INVALID',
    'Executable was not found on the sanitized PATH',
  );
}

async function isTrustedWindowsMultiLinkExecutable(canonicalPath: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  if (canonicalPath.toLowerCase() === (await realpath(process.execPath)).toLowerCase()) return true;
  const systemDirectory = await realpath(getTrustedWindowsSystemDirectory());
  const childPath = relative(systemDirectory, canonicalPath);
  return childPath !== '' && !childPath.startsWith('..') && !isAbsolute(childPath);
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
  sandboxed?: boolean;
}>;

export type RunOptions = Readonly<{
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
      executionImageDigest: string;
      executionImageIdentity: string;
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
  posixOwnedMembers?: Map<number, string>;
  posixIdentityMonitor?: ReturnType<typeof setTimeout>;
  windowsJobId?: string;
  windowsOwnedPids?: Promise<readonly Readonly<{ pid: number; processStartIdentity: string }>[]>;
  executionImage?: PreparedExecutionImage;
};

export class CommandRunner {
  private readonly batchIntervalMs: number;
  private readonly maxBatchBytes: number;
  private readonly maxBufferedBytes: number;
  private readonly maxOutputBytes: number;
  private readonly cancelGraceMs: number;
  private readonly sandboxed: boolean;
  private readonly active = new Map<string, ActiveProcess>();

  constructor(options: RunnerOptions = {}) {
    this.batchIntervalMs = options.batchIntervalMs ?? 100;
    this.maxBatchBytes = options.maxBatchBytes ?? 64 * 1024;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 1024 * 1024;
    this.maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
    this.cancelGraceMs = options.cancelGraceMs ?? 1_500;
    this.sandboxed = options.sandboxed ?? false;
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

  writeStdin(executionId: string, chars: string, close = false): boolean {
    const active = this.active.get(executionId);
    if (active === undefined || active.child.stdin === null || active.child.stdin.destroyed)
      return false;
    if (chars.length > 0) active.child.stdin.write(chars);
    if (close) active.child.stdin.end();
    return true;
  }

  terminate(executionId: string, force = false): boolean {
    const active = this.active.get(executionId);
    if (active === undefined) return false;
    return this.signalOwnedTree(executionId, active.lease, force ? 'SIGKILL' : 'SIGTERM');
  }

  async dispose(): Promise<void> {
    const entries = [...this.active.entries()];
    const forceResults = await Promise.allSettled(
      entries.map(([executionId, active]) => this.forceOwnedTree(executionId, active.lease)),
    );
    await Promise.all(
      entries.map(async ([executionId, active], index) => {
        if (
          process.platform === 'win32' ||
          forceResults[index]?.status !== 'fulfilled' ||
          (active.child.exitCode === null && active.child.signalCode === null)
        )
          return;
        if (await this.waitForOwnedTreeExit(executionId, active.lease, 3_000))
          this.releaseActive(executionId, active);
      }),
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
    const executionImage = await this.revalidate(spec);
    const preparedIdentity = issuedSpecs.get(spec);
    if (preparedIdentity === undefined)
      throw new CommandRunnerError(
        'EXECUTION_SPEC_INVALID',
        'ExecutionSpec identity is unavailable',
      );
    let retainedExecutionImage = false;
    try {
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
      const posixControlNonce = randomUUID();
      const startedAt = Date.now();
      options.beforeSpawn?.();
      let child: ChildProcess;
      const sandboxExecutable = !this.sandboxed ? null : sandboxRunnerPath();
      try {
        const windows = process.platform === 'win32';
        if (sandboxExecutable !== null) verifySandboxRunnerDigest(sandboxExecutable);
        child = spawn(
          windows ? windowsJobWrapperCommand() : posixSupervisorCommand(),
          [
            ...(windows
              ? ['-e', WINDOWS_JOB_WRAPPER]
              : [
                  '-c',
                  POSIX_COMMAND_WRAPPER,
                  'sprint-coder-command-supervisor',
                  ...(sandboxExecutable === null
                    ? []
                    : [
                        sandboxExecutable,
                        '--exec',
                        'workspace-write',
                        preparedIdentity.pathGuard.workspacePath,
                        '--protected-home',
                        homedir(),
                        '--',
                      ]),
                  executionImage.launchPath,
                  ...executionImage.argvPrefix,
                  ...spec.argv,
                ]),
          ],
          {
            cwd: spec.cwdIdentity.canonicalPath,
            env: buildEnvironment(spec.envDelta, executionImage.environment),
            shell: false,
            stdio: windows
              ? ['pipe', 'pipe', 'pipe', 'pipe']
              : ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', ...executionImage.descriptors],
            detached: !windows,
            windowsHide: true,
          },
        );
      } catch (error) {
        throw new CommandRunnerError('SPAWN_FAILED', errorMessage(error));
      }
      const processClosePromise = waitForClose(child);
      const posixControl =
        process.platform === 'win32'
          ? undefined
          : waitForPosixCommandOutcome(child, posixControlNonce);
      const outcomePromise = posixControl?.outcome ?? processClosePromise;
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
          const controlInput = child.stdio[3] as NodeJS.WritableStream | null | undefined;
          controlInput?.end(
            JSON.stringify({
              executable: sandboxExecutable ?? executionImage.launchPath,
              nativeAddonPath: nativeSafeFsAddonPath(),
              argv:
                sandboxExecutable === null
                  ? [...executionImage.argvPrefix, ...spec.argv]
                  : [
                      '--exec',
                      'workspace-write',
                      preparedIdentity.pathGuard.workspacePath,
                      '--protected-home',
                      homedir(),
                      '--',
                      executionImage.launchPath,
                      ...executionImage.argvPrefix,
                      ...spec.argv,
                    ],
              cwd: spec.cwdIdentity.canonicalPath,
              env: buildEnvironment(spec.envDelta, executionImage.environment),
            }),
          );
        } catch (error) {
          child.kill();
          throw new CommandRunnerError('SPAWN_FAILED', errorMessage(error));
        }
      } else {
        const nonceInput = child.stdio[4] as NodeJS.WritableStream | null | undefined;
        nonceInput?.end(`${posixControlNonce}\n`);
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
        outcome: processClosePromise,
        ...(process.platform === 'win32' ? {} : { posixOwnedMembers: new Map<number, string>() }),
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
      const processStartIdentity = readProcessStartIdentity(child.pid);
      if (
        processStartIdentity === 'unavailable' ||
        processStartIdentity.startsWith('unsupported:')
      ) {
        try {
          await this.forceUnidentifiedProcess(active);
          this.active.delete(executionId);
          active.resolveSettled();
          throw new CommandRunnerError(
            'SPAWN_FAILED',
            'Command process start identity is unavailable',
          );
        } catch (error) {
          if (
            error instanceof CommandRunnerError &&
            error.code === 'PROCESS_TREE_TERMINATION_FAILED'
          ) {
            retainedExecutionImage = true;
            active.executionImage = executionImage;
            this.retainUntilOutcome(executionId, active);
          }
          throw error;
        }
      }
      active.processStartIdentity = processStartIdentity;
      try {
        if (posixControl !== undefined) {
          const targetPid = await posixControl.started;
          const targetStartIdentity = readProcessStartIdentity(targetPid);
          const targetGroupId = readPosixProcessGroupId(targetPid);
          if (
            targetStartIdentity === 'unavailable' ||
            targetStartIdentity.startsWith('unsupported:') ||
            targetGroupId !== active.pid
          )
            throw new CommandRunnerError('SPAWN_FAILED', 'POSIX target identity is unavailable');
          active.posixOwnedMembers?.set(targetPid, targetStartIdentity);
        }
      } catch (error) {
        try {
          await this.terminateKnownAndWait(executionId, lease, active.outcome);
          this.releaseActive(executionId, active);
        } catch (terminationError) {
          if (
            terminationError instanceof CommandRunnerError &&
            terminationError.code === 'PROCESS_TREE_TERMINATION_FAILED'
          ) {
            retainedExecutionImage = true;
            active.executionImage = executionImage;
            this.retainUntilOutcome(executionId, active);
          }
          throw terminationError;
        }
        throw error;
      }
      try {
        options.onStarted?.({
          executionId,
          pid: child.pid,
          startedAt,
          processStartIdentity,
          executionImageDigest: executionImage.digest,
          executionImageIdentity: executionImage.identity,
        });
        if (posixControl !== undefined) {
          const targetGate = (
            child.stdio as unknown as readonly (NodeJS.WritableStream | null | undefined)[]
          )[5];
          targetGate?.end('run\n');
          this.startPosixIdentityMonitor(active);
        }
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
          ) {
            retainedExecutionImage = true;
            active.executionImage = executionImage;
            this.retainUntilOutcome(executionId, active);
          }
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
      const ownedCancellationSignals = new Set<'SIGTERM' | 'SIGKILL'>();
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
        if (process.platform !== 'win32' && this.signalOwnedTree(executionId, lease, 'SIGTERM'))
          ownedCancellationSignals.add('SIGTERM');
        forcePromise = new Promise<void>((resolve) => {
          resolveForce = resolve;
        });
        forceTimer = setTimeout(() => {
          void (async () => {
            try {
              if (await this.forceOwnedTree(executionId, lease)) {
                termination = 'forced';
                if (process.platform !== 'win32') ownedCancellationSignals.add('SIGKILL');
              }
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
      let outcomeObserved = false;
      try {
        const outcome = await waitForOutcomeOrTerminationFailure(
          outcomePromise,
          terminationFailure,
        );
        outcomeObserved = true;
        if (
          canceled &&
          process.platform !== 'win32' &&
          this.ownedTreeAlive(executionId, lease) &&
          !this.ownedPosixGroupHasDescendants(executionId, lease)
        ) {
          if (forceTimer !== undefined) clearTimeout(forceTimer);
          forceTimer = undefined;
          resolveForce?.();
          await this.forceOwnedTree(executionId, lease);
          if (!(await this.waitForOwnedTreeExit(executionId, lease, 5_000)))
            throw new CommandRunnerError(
              'PROCESS_TREE_TERMINATION_FAILED',
              'Cooperatively canceled command supervisor did not close',
            );
        } else if (canceled && this.ownedTreeAlive(executionId, lease)) await forcePromise;
        else if (forceTimer !== undefined) {
          clearTimeout(forceTimer);
          forceTimer = undefined;
          resolveForce?.();
        }
        if (terminationError !== undefined) throw terminationError;
        if (terminationWatchdog !== undefined) clearTimeout(terminationWatchdog);
        if (!canceled && process.platform !== 'win32')
          await this.drainNaturalPosixTree(executionId, lease);
        if (process.platform !== 'win32')
          await waitWithTimeout(
            processClosePromise,
            5_000,
            'POSIX command supervisor did not close after group drain',
          );
        await finalizeStreams();
        if (sinkError !== undefined) throw sinkError;
        const reportedOutcome =
          process.platform === 'win32'
            ? outcome
            : outcomeFromOwnedCancellationSignal(outcome, ownedCancellationSignals);
        return Object.freeze({
          executionId,
          ...reportedOutcome,
          canceled,
          termination,
          durationMs: Date.now() - startedAt,
          outputBytes,
          truncated,
        });
      } catch (error) {
        if (
          process.platform !== 'win32' &&
          (!(error instanceof CommandRunnerError) ||
            error.code !== 'PROCESS_TREE_TERMINATION_FAILED')
        ) {
          if (this.ownedTreeAlive(executionId, lease)) {
            await this.forceOwnedTree(executionId, lease);
            await waitWithTimeout(
              processClosePromise,
              5_000,
              'POSIX command supervisor did not close after outcome rejection',
            );
          }
        }
        if (
          error instanceof CommandRunnerError &&
          error.code === 'PROCESS_TREE_TERMINATION_FAILED'
        ) {
          retainActive = true;
          retainedExecutionImage = true;
          active.executionImage = executionImage;
          sinkError = error;
          const release = async (): Promise<void> => {
            try {
              await finalizeStreams();
            } finally {
              this.releaseActive(executionId, active);
            }
          };
          if (!outcomeObserved) void active.outcome.then(release, release);
          else if (process.platform !== 'win32')
            void this.releaseWhenOwnedTreeExits(executionId, active).then(release, release);
        }
        throw error;
      } finally {
        if (flushTimer !== undefined) clearTimeout(flushTimer);
        if (forceTimer !== undefined) clearTimeout(forceTimer);
        if (terminationWatchdog !== undefined) clearTimeout(terminationWatchdog);
        options.signal?.removeEventListener('abort', cancel);
        if (!retainActive) this.releaseActive(executionId, active);
      }
    } finally {
      if (!retainedExecutionImage) await executionImage.close();
    }
  }

  private async revalidate(spec: ExecutionSpec): Promise<PreparedExecutionImage> {
    const identity = issuedSpecs.get(spec);
    if (!validateExecutionSpec(spec) || identity === undefined)
      throw new CommandRunnerError(
        'EXECUTION_SPEC_INVALID',
        'ExecutionSpec was not sealed by CommandRunner preparation',
      );
    try {
      await revalidatePathGuard(identity.pathGuard);
      if (spec.executionIdentityDigest !== sealedExecutableIdentityDigest(identity.executable))
        throw new Error('Approved execution identity changed');
      return await prepareExecutionImage(identity.executable);
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
    if (active === undefined || active.lease !== lease) return false;
    const leaderAlive = active.child.exitCode === null && active.child.signalCode === null;
    try {
      if (process.platform === 'win32') return false;
      if (!leaderAlive) return this.signalRecordedPosixMembers(active, signal);
      if (!this.posixLeaderSignalIsOwned(active)) return false;
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
      if (!leaderAlive) return this.signalRecordedPosixMembers(active, 'SIGKILL');
      if (!this.posixLeaderSignalIsOwned(active)) return false;
      process.kill(-active.pid, 'SIGKILL');
      return true;
    } catch (error) {
      if (error instanceof CommandRunnerError) throw error;
      if (process.platform === 'win32')
        throw new CommandRunnerError('PROCESS_TREE_TERMINATION_FAILED', errorMessage(error));
      return false;
    }
  }

  private async drainNaturalPosixTree(executionId: string, lease: string): Promise<void> {
    if (!this.ownedTreeAlive(executionId, lease)) return;
    this.signalOwnedTree(executionId, lease, 'SIGTERM');
    await this.waitForOwnedDescendantsExit(executionId, lease, this.cancelGraceMs);
    await this.forceOwnedTree(executionId, lease);
    if (await this.waitForOwnedTreeExit(executionId, lease, 5_000)) return;
    throw new CommandRunnerError(
      'PROCESS_TREE_TERMINATION_FAILED',
      'Naturally completed command left an owned process group that could not be drained',
    );
  }

  private async waitForOwnedDescendantsExit(
    executionId: string,
    lease: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.ownedPosixGroupHasDescendants(executionId, lease)) {
      if (Date.now() >= deadline) return false;
      await delay(Math.min(20, Math.max(1, deadline - Date.now())));
    }
    return true;
  }

  private ownedPosixGroupHasDescendants(executionId: string, lease: string): boolean {
    const active = this.active.get(executionId);
    if (active === undefined || active.lease !== lease || process.platform === 'win32')
      return false;
    try {
      return readPosixGroupMembers(active.pid).some((pid) => pid !== active.pid);
    } catch {
      // An unverifiable group is treated as still populated; force remains identity-gated.
      return true;
    }
  }

  private posixLeaderSignalIsOwned(active: ActiveProcess): boolean {
    return posixGroupSignalIsAuthorized({
      leaderAlive: true,
      expectedGroupId: active.pid,
      observedGroupId: readPosixProcessGroupId(active.pid),
      expectedStartIdentity: active.processStartIdentity,
      observedStartIdentity: readProcessStartIdentity(active.pid),
    });
  }

  private signalRecordedPosixMembers(
    active: ActiveProcess,
    signal: 'SIGTERM' | 'SIGKILL',
  ): boolean {
    let signaled = false;
    for (const [pid, startIdentity] of active.posixOwnedMembers ?? []) {
      if (
        readPosixProcessGroupId(pid) !== active.pid ||
        readProcessStartIdentity(pid) !== startIdentity
      )
        continue;
      try {
        // Do not enumerate the group between this identity check and the per-PID signal. If the
        // witness disappears, an unrelated reused PGID is never signaled as a group.
        process.kill(pid, signal);
        signaled = true;
      } catch {
        // The verified member exited before the signal; retain ownership and fail closed.
      }
    }
    return signaled;
  }

  private startPosixIdentityMonitor(active: ActiveProcess): void {
    const startedAt = Date.now();
    const capture = async (): Promise<void> => {
      try {
        const members = await readPosixGroupMemberIdentities(active.pid);
        if (members.get(active.pid) !== active.processStartIdentity) return;
        for (const [pid, startIdentity] of members)
          if (pid !== active.pid) active.posixOwnedMembers?.set(pid, startIdentity);
      } catch {
        // Monitoring is advisory. Signal-time identity checks remain fail-closed.
      } finally {
        if (
          active.child.exitCode === null &&
          active.child.signalCode === null &&
          active.posixIdentityMonitor !== undefined
        ) {
          const intervalMs = Date.now() - startedAt < 500 ? 25 : 100;
          active.posixIdentityMonitor = setTimeout(() => void capture(), intervalMs);
          active.posixIdentityMonitor.unref();
        }
      }
    };
    active.posixIdentityMonitor = setTimeout(() => void capture(), 0);
    active.posixIdentityMonitor.unref();
  }

  private async waitForOwnedTreeExit(
    executionId: string,
    lease: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.ownedTreeAlive(executionId, lease)) {
      if (Date.now() >= deadline) return false;
      await delay(Math.min(20, Math.max(1, deadline - Date.now())));
    }
    return true;
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
    const release = (): void => this.releaseActive(executionId, active);
    void active.outcome.then(release, release);
  }

  private async releaseWhenOwnedTreeExits(
    executionId: string,
    active: ActiveProcess,
  ): Promise<void> {
    while (
      this.active.get(executionId) === active &&
      this.ownedTreeAlive(executionId, active.lease)
    )
      await delay(100);
  }

  private releaseActive(executionId: string, active: ActiveProcess): void {
    if (this.active.get(executionId) === active) this.active.delete(executionId);
    if (active.posixIdentityMonitor !== undefined) {
      clearTimeout(active.posixIdentityMonitor);
      delete active.posixIdentityMonitor;
    }
    if (active.windowsJobId !== undefined) closeOwnedJob(active.windowsJobId);
    const executionImage = active.executionImage;
    delete active.executionImage;
    if (executionImage === undefined) active.resolveSettled();
    else void executionImage.close().finally(active.resolveSettled);
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

export function posixGroupIdentityMatches(
  input: Readonly<{
    expectedGroupId: number;
    observedGroupId: number | null;
    expectedStartIdentity: string;
    observedStartIdentity: string;
  }>,
): boolean {
  return (
    input.observedGroupId === input.expectedGroupId &&
    input.observedStartIdentity === input.expectedStartIdentity
  );
}

export function posixGroupSignalIsAuthorized(
  input: Readonly<{
    leaderAlive: boolean;
    expectedGroupId: number;
    observedGroupId: number | null;
    expectedStartIdentity: string;
    observedStartIdentity: string;
  }>,
): boolean {
  return input.leaderAlive && posixGroupIdentityMatches(input);
}

function readPosixProcessGroupId(pid: number): number | null {
  if (process.platform === 'win32') return null;
  try {
    const value = execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1_000,
    }).trim();
    const groupId = Number.parseInt(value, 10);
    return Number.isInteger(groupId) && groupId > 0 ? groupId : null;
  } catch {
    return null;
  }
}

function readPosixGroupMembers(groupId: number): number[] {
  return execFileSync('/bin/ps', ['-axo', 'pid=,pgid='], {
    encoding: 'utf8',
    timeout: 1_000,
  })
    .trim()
    .split('\n')
    .flatMap((line) => {
      const [pidText, groupText] = line.trim().split(/\s+/);
      const pid = Number(pidText);
      return Number(groupText) === groupId && Number.isInteger(pid) && pid > 0 ? [pid] : [];
    });
}

async function readPosixGroupMemberIdentities(groupId: number): Promise<Map<number, string>> {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,pgid=,lstart='], {
    encoding: 'utf8',
    timeout: 1_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const identities = new Map<number, string>();
  for (const line of stdout.trim().split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null || Number(match[2]) !== groupId) continue;
    const pid = Number(match[1]);
    const startIdentity =
      process.platform === 'linux'
        ? readProcessStartIdentity(pid)
        : `${process.platform}:${match[3]?.trim() ?? ''}`;
    if (startIdentity !== 'unavailable' && !startIdentity.startsWith('unsupported:'))
      identities.set(pid, startIdentity);
  }
  return identities;
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
  await execFileAsync(join(getTrustedWindowsSystemDirectory(), 'taskkill.exe'), args, {
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
    join(getTrustedWindowsSystemDirectory(), 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 3_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  );
  if (stdout.trim().length === 0) return new Map();
  const parsed = JSON.parse(stdout) as
    | { pid: number; parentPid: number; identity: string }
    | { pid: number; parentPid: number; identity: string }[];
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return new Map(
    rows.flatMap((row) => {
      if (!Number.isInteger(row.pid) || row.pid <= 0) return [];
      const identity = queryNativeProcessIdentity(row.pid);
      const pid = identity?.pid ?? row.pid;
      const parentPid = identity?.parentPid ?? row.parentPid;
      const processStartIdentity = identity?.startIdentity ?? row.identity;
      if (!Number.isInteger(parentPid) || parentPid < 0 || typeof processStartIdentity !== 'string')
        return [];
      return [[pid, { pid, parentPid, processStartIdentity }] as const];
    }),
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

function waitForPosixCommandOutcome(
  child: ChildProcess,
  expectedNonce: string,
): Readonly<{
  started: Promise<number>;
  outcome: Promise<{ exitCode: number | null; signal: string | null }>;
}> {
  const control = child.stdio[3] as NodeJS.ReadableStream | null | undefined;
  if (control === null || control === undefined)
    return {
      started: Promise.reject(new CommandRunnerError('SPAWN_FAILED', 'Missing POSIX control pipe')),
      outcome: waitForClose(child),
    };
  let resolveStarted: (pid: number) => void = () => undefined;
  let rejectStarted: (error: unknown) => void = () => undefined;
  const started = new Promise<number>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  const outcome = new Promise<{ exitCode: number | null; signal: string | null }>(
    (resolve, reject) => {
      let settled = false;
      let startSettled = false;
      let buffer = '';
      const finish = (outcome: { exitCode: number | null; signal: string | null }): void => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
      control.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        if (buffer.length > 64 * 1024 && !settled) {
          settled = true;
          reject(new CommandRunnerError('SPAWN_FAILED', 'POSIX control message exceeded limit'));
          return;
        }
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const value = JSON.parse(line) as Partial<{
              nonce: string;
              type: string;
              pid: number;
              status: number;
              exitCode: number | null;
              signal: string | null;
            }>;
            if (value.nonce !== expectedNonce)
              throw new Error('POSIX control message authentication failed');
            if (value.type === 'started' && Number.isInteger(value.pid) && Number(value.pid) > 0) {
              if (!startSettled) {
                startSettled = true;
                resolveStarted(Number(value.pid));
              }
            } else if (value.type === 'spawnError' && typeof value.status === 'number') {
              const spawnError = new CommandRunnerError(
                'SPAWN_FAILED',
                `POSIX target exec failed with status ${value.status}`,
              );
              if (!startSettled) {
                startSettled = true;
                rejectStarted(spawnError);
              }
              settled = true;
              reject(spawnError);
            } else if (
              value.type === 'outcome' &&
              (typeof value.exitCode === 'number' || value.exitCode === null) &&
              (typeof value.signal === 'string' || value.signal === null)
            )
              finish({ exitCode: value.exitCode, signal: value.signal });
            else throw new Error('Malformed POSIX command outcome');
          } catch (error) {
            if (!settled) {
              settled = true;
              reject(new CommandRunnerError('SPAWN_FAILED', errorMessage(error)));
            }
          }
          newline = buffer.indexOf('\n');
        }
      });
      child.once('error', (error) => {
        const spawnError = new CommandRunnerError('SPAWN_FAILED', error.message);
        if (!startSettled) rejectStarted(spawnError);
        if (!settled) reject(spawnError);
      });
      const finishFromSupervisorExit = (exitCode: number | null, signal: string | null): void => {
        if (!startSettled)
          rejectStarted(new CommandRunnerError('SPAWN_FAILED', 'POSIX target did not start'));
        finish({ exitCode, signal });
      };
      // `close` waits for inherited stdout/stderr handles. A hostile target can kill the shell
      // leader while retaining those handles, so use `exit` to begin the owned-group drain.
      child.once('exit', finishFromSupervisorExit);
      child.once('close', finishFromSupervisorExit);
    },
  );
  void started.catch(() => undefined);
  return { started, outcome };
}

function outcomeFromOwnedCancellationSignal(
  outcome: Readonly<{ exitCode: number | null; signal: string | null }>,
  sentSignals: ReadonlySet<'SIGTERM' | 'SIGKILL'>,
): { exitCode: number | null; signal: string | null } {
  // A POSIX shell exposes both explicit exit(128 + N) and signal N as the same status. Preserve
  // high explicit exit codes unless this runner sent the matching cancellation signal itself.
  const matchingSignal =
    outcome.exitCode === 128 + 15 && sentSignals.has('SIGTERM')
      ? 'SIGTERM'
      : outcome.exitCode === 128 + 9 && sentSignals.has('SIGKILL')
        ? 'SIGKILL'
        : undefined;
  return matchingSignal === undefined
    ? { exitCode: outcome.exitCode, signal: outcome.signal }
    : { exitCode: null, signal: matchingSignal };
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
    if (process.platform === 'win32') {
      const nativeIdentity = queryNativeProcessIdentity(pid);
      if (nativeIdentity !== null) return nativeIdentity.startIdentity;
      return `win32:${execFileSync(
        join(getTrustedWindowsSystemDirectory(), 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
        ],
        { encoding: 'utf8', timeout: 3_000, windowsHide: true },
      ).trim()}`;
    }
  } catch {
    return 'unavailable';
  }
  return `unsupported:${pid}`;
}

function buildEnvironment(
  delta: Readonly<Record<string, string>>,
  internal?: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const environment = Object.fromEntries([
    ...Object.entries(delta),
    ...Object.entries(internal ?? {}),
  ]);
  if (process.platform === 'linux') {
    for (const key of Object.keys(environment)) {
      if (/^LD_(?:AUDIT|LIBRARY_PATH|PRELOAD)$/u.test(key)) delete environment[key];
    }
  }
  return environment;
}

export function buildControlledEnvironment(
  platform: NodeJS.Platform = process.platform,
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): Readonly<Record<string, string>> {
  const commonAllowed = [
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
  const windowsAllowed = [
    'PATH',
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMW6432',
    'SYSTEMDRIVE',
    'NUMBER_OF_PROCESSORS',
    'PSMODULEPATH',
  ];
  const environment: Record<string, string> = {};
  const sourceByCaseInsensitiveKey = new Map(
    Object.entries(source).map(([key, value]) => [key.toUpperCase(), value]),
  );
  for (const key of platform === 'win32' ? [...commonAllowed, ...windowsAllowed] : commonAllowed) {
    const value =
      platform === 'win32' ? sourceByCaseInsensitiveKey.get(key.toUpperCase()) : source[key];
    if (value !== undefined) environment[key] = value;
  }
  if (platform === 'win32') {
    const systemDirectory =
      process.platform === 'win32' ? getTrustedWindowsSystemDirectory() : 'C:\\Windows\\System32';
    const windowsRoot = windowsPath.dirname(systemDirectory);
    environment['SYSTEMROOT'] = windowsRoot;
    environment['WINDIR'] = windowsRoot;
    environment['COMSPEC'] = windowsPath.join(systemDirectory, 'cmd.exe');
    environment['PATH'] = sanitizedWindowsPath(environment['PATH'], windowsRoot);
    const home = environment['HOME'];
    const userProfile = environment['USERPROFILE'];
    if (home === undefined && userProfile !== undefined) environment['HOME'] = userProfile;
    if (userProfile === undefined && home !== undefined) environment['USERPROFILE'] = home;
  } else {
    environment['PATH'] = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  }
  return environment;
}

function sanitizedWindowsPath(sourcePath: string | undefined, windowsRoot: string): string {
  const candidates = [
    windowsPath.join(windowsRoot, 'System32'),
    windowsRoot,
    ...(sourcePath?.split(';') ?? []),
  ];
  const seen = new Set<string>();
  const accepted: string[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!/^[a-zA-Z]:[\\/]/u.test(trimmed) || trimmed.includes('\0')) continue;
    const normalizedPath = windowsPath.normalize(trimmed);
    const normalized =
      normalizedPath.length > 3 ? normalizedPath.replace(/[\\/]+$/u, '') : normalizedPath;
    const identity = normalized.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    accepted.push(normalized);
  }
  return accepted.join(';');
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

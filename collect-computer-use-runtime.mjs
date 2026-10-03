import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createCaptureDecoder } from './computer-use-capture-wire.mjs';
import {
  immutableCaptureResult,
  summarizeComputerUseCaptureRounds,
} from './computer-use-capture-rounds.mjs';

const safeEnvironmentKeys = new Set([
  'PATH',
  'Path',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'LANG',
  'LC_ALL',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'SPRINT_CODER_USER_DATA_DIR',
  'SPRINT_CODER_E2E_HIDDEN',
  'SPRINT_CODER_E2E_BACKGROUND',
  'SPRINT_CODER_COMPUTER_USE_DESKTOP_V1',
]);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function hashExecutable(path, maxBytes = 1024 * 1024 * 1024) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024 * 1024)
    throw new Error('executable_size');
  const fd = openSync(path, 'r');
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) throw new Error('executable_size');
    const buffer = Buffer.alloc(64 * 1024);
    const hash = createHash('sha256');
    let size = 0;
    for (;;) {
      const count = readSync(fd, buffer);
      if (count === 0) break;
      size += count;
      if (size > before.size || size > maxBytes) throw new Error('executable_changed');
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(fd);
    if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error('executable_changed');
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

/**
 * The same collector receives normal Main startup and live recorder events. An inherited pipe
 * establishes ownership of the stream, NOT package/signature authenticity. The protected caller
 * must verify those separately before using the result as verifiedOwnedRunFacts in schema v4.
 * No file/replay input or authenticity flag is accepted here; stdout/stderr are not persisted.
 */
export function startOwnedComputerUseCapture({
  executable,
  args = [],
  environment = process.env,
  handshakeTimeoutMs = 30_000,
  retainOwnedProcess,
}) {
  if (
    (retainOwnedProcess !== undefined && typeof retainOwnedProcess !== 'function') ||
    !isAbsolute(executable) ||
    !Array.isArray(args) ||
    args.length > 32 ||
    args.some((value) => typeof value !== 'string' || value.length > 4096) ||
    !Number.isSafeInteger(handshakeTimeoutMs) ||
    handshakeTimeoutMs < 1 ||
    handshakeTimeoutMs > 60_000
  )
    throw new Error('Computer Use collector launch is invalid');
  const path = realpathSync(executable);
  const executableSha256 = hashExecutable(path);
  const nonce = randomBytes(32).toString('hex');
  const childEnvironment = Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) => safeEnvironmentKeys.has(key) && typeof value === 'string',
    ),
  );
  childEnvironment.SPRINT_CODER_COMPUTER_USE_CAPTURE_PIPE = '1';
  childEnvironment.SPRINT_CODER_COMPUTER_USE_CAPTURE_NONCE = nonce;
  const child = spawn(path, args, {
    env: childEnvironment,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  });
  const closed = new Promise((resolve) => child.once('close', () => resolve()));
  const frames = [];
  let hello;
  let retainedProcess;
  let processIdentity;
  const releaseProcess = (requireConfirmedClose = false) => {
    if (!retainedProcess) return;
    const receipt = retainedProcess;
    retainedProcess = undefined;
    try {
      receipt.close();
    } catch {
      if (requireConfirmedClose) throw new Error('owned_process_close_unconfirmed');
      /* cleanup never emits backend details */
    }
  };
  let failed = false;
  let resolveHello, rejectHello, resolveCompleted, rejectCompleted;
  const handshake = new Promise((resolve, reject) => {
    resolveHello = resolve;
    rejectHello = reject;
  });
  const completed = new Promise((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  // Handshake-only callers still own child cleanup; a deliberately truncated capture must not
  // produce an unhandled rejection or be mistaken for a completed run.
  handshake.catch(() => undefined);
  completed.catch(() => undefined);
  const fail = () => {
    if (failed) return;
    failed = true;
    frames.length = 0;
    releaseProcess();
    clearTimeout(timer);
    const error = new Error('Computer Use live capture is incomplete');
    rejectHello(error);
    rejectCompleted(error);
  };
  const decoder = createCaptureDecoder(nonce, (frame) => {
    if (frame.kind === 'hello') {
      if (
        frame.payload.pid !== child.pid ||
        frame.payload.parentPid !== process.pid ||
        frame.payload.platform !== process.platform ||
        hashExecutable(path) !== executableSha256
      )
        throw new Error('owned_child_mismatch');
      hello = frame.payload;
      clearTimeout(timer);
      resolveHello(Object.freeze({ ...hello, executableSha256, runIdDigest: digest(nonce) }));
    }
    frames.push(frame);
  });
  const timer = setTimeout(fail, handshakeTimeoutMs);
  timer.unref();
  const pipe = child.stdio[3];
  child.on('error', fail);
  if (pipe) {
    pipe.on('data', (chunk) => {
      if (!failed) {
        try {
          decoder.push(chunk);
        } catch {
          fail();
        }
      }
    });
    pipe.on('error', fail);
  } else fail();
  child.on('close', (code) => {
    clearTimeout(timer);
    if (failed) return;
    try {
      if (code !== 0 || !hello) throw new Error('child_exit');
      const summary = decoder.finish();
      if (
        retainOwnedProcess !== undefined &&
        (!retainedProcess || retainedProcess.verifyUnchanged() !== true)
      )
        throw new Error('owned_process_continuity');
      releaseProcess(true);
      resolveCompleted(
        immutableCaptureResult({
          ...summary,
          hello,
          ...(processIdentity
            ? {
                processIdentityDigest: digest(
                  JSON.stringify([
                    'sprint-coder-owned-process-identity-v1',
                    process.platform,
                    digest(nonce),
                    executableSha256,
                    processIdentity.pid,
                    processIdentity.parentPid,
                    processIdentity.startIdentity,
                    processIdentity.imagePath,
                  ]),
                ),
              }
            : {}),
          frames,
          sessions: summarizeComputerUseCaptureRounds(frames),
          executableSha256,
          runIdDigest: digest(nonce),
        }),
      );
    } catch {
      fail();
    }
  });
  if (retainOwnedProcess !== undefined) {
    try {
      retainedProcess = retainOwnedProcess(
        Object.freeze({
          pid: child.pid,
          executable: path,
          executableSha256,
          runIdDigest: digest(nonce),
        }),
      );
      if (
        !retainedProcess ||
        retainedProcess.isRunning() !== true ||
        retainedProcess.verifyUnchanged() !== true
      )
        throw new Error('owned_process_unavailable');
      const measured = retainedProcess.snapshot();
      processIdentity = Object.freeze({
        pid: measured?.pid,
        parentPid: measured?.parentPid,
        startIdentity: measured?.startIdentity,
        imagePath: measured?.imagePath,
      });
      if (
        processIdentity.pid !== child.pid ||
        processIdentity.parentPid !== process.pid ||
        typeof processIdentity.startIdentity !== 'string' ||
        !/^win32:[1-9][0-9]*$/u.test(processIdentity.startIdentity) ||
        processIdentity.startIdentity.length > 128 ||
        typeof processIdentity.imagePath !== 'string' ||
        !isAbsolute(processIdentity.imagePath) ||
        processIdentity.imagePath.length > 32768
      )
        throw new Error('owned_process_mismatch');
    } catch {
      fail();
      if (!child.killed) child.kill();
    }
  }
  return Object.freeze({
    handshake,
    completed,
    closed,
    abandon() {
      // A bounded caller may stop waiting even when another process inherited the pipe.
      // Invalidate first: abandoning transport can never establish normal completion.
      fail();
      pipe?.destroy();
      child.unref();
    },
    stopOwnedChild() {
      if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill();
    },
  });
}

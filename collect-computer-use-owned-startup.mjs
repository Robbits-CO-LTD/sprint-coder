import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashExecutable, startOwnedComputerUseCapture } from './collect-computer-use-runtime.mjs';

/** Protected workflow startup/shutdown checkpoint, never parent acceptance or verified facts. */
export async function collectOwnedComputerUseStartup(
  input,
  startCapture = startOwnedComputerUseCapture,
) {
  let capture;
  let profile;
  let timer;
  let signal;
  let onAbort;
  let closed = false;
  let transportValidated = false;
  try {
    const {
      executable,
      expectedSourceCommit,
      expectedExecutableSha256,
      packageSha256,
      outputPath,
      timeoutMs = 120_000,
    } = input;
    if (
      typeof executable !== 'string' ||
      typeof outputPath !== 'string' ||
      !isAbsolute(executable) ||
      !isAbsolute(outputPath) ||
      typeof expectedSourceCommit !== 'string' ||
      !/^(?!0{40}$)[a-f0-9]{40}$/u.test(expectedSourceCommit) ||
      ![expectedExecutableSha256, packageSha256].every(
        (value) => typeof value === 'string' && /^(?!0{64}$)[a-f0-9]{64}$/u.test(value),
      ) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 120_000
    )
      throw new Error();
    if (hashExecutable(executable) !== expectedExecutableSha256) throw new Error();
    signal = input.signal;
    if (signal !== undefined && !(signal instanceof globalThis.AbortSignal)) throw new Error();
    if (signal?.aborted) throw new Error();
    const canceled = new Promise((_, reject) => {
      onAbort = () => reject(new Error());
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    profile = mkdtempSync(join(dirname(outputPath), 'owned-startup-profile-'));
    capture = startCapture({
      executable,
      environment: {
        ...process.env,
        SPRINT_CODER_USER_DATA_DIR: profile,
        SPRINT_CODER_COMPUTER_USE_DESKTOP_V1: '0',
        SPRINT_CODER_E2E_HIDDEN: '0',
        SPRINT_CODER_E2E_BACKGROUND: '0',
      },
    });
    void capture.closed.then(() => {
      closed = true;
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error()), timeoutMs);
    });
    const completed = await Promise.race([capture.completed, timeout, canceled]);
    if (signal?.aborted) throw new Error();
    if (
      completed.hello.packaged !== true ||
      completed.hello.sourceCommit !== expectedSourceCommit ||
      completed.executableSha256 !== expectedExecutableSha256 ||
      completed.sessions.length !== 0
    )
      throw new Error();
    transportValidated = true;
    const report = Object.freeze({
      schemaVersion: 1,
      evidenceKind: 'owned-startup-shutdown-checkpoint',
      finalGateEligible: false,
      sourceCommit: expectedSourceCommit,
      platform: completed.hello.platform,
      packageSha256,
      executableSha256: completed.executableSha256,
      runIdDigest: completed.runIdDigest,
      eventChainDigest: completed.eventChainDigest,
      transportCompleted: true,
      sessionCount: 0,
      frameCount: completed.frameCount,
    });
    const bytes = `${JSON.stringify(report)}\n`;
    if (Buffer.byteLength(bytes) > 4096) throw new Error();
    writeFileSync(outputPath, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return report;
  } catch {
    throw new Error('COMPUTER_USE_OWNED_STARTUP_CHECKPOINT_FAILED');
  } finally {
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
    clearTimeout(timer);
    capture?.stopOwnedChild();
    if (capture !== undefined && !closed) capture.abandon();
    // Only normal fully closed children permit profile cleanup. An unconfirmed forced stop
    // leaves its isolated profile local; never confuse root kill with descendant completion.
    if (profile !== undefined && closed && transportValidated) {
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        /* Local isolated state only. */
      }
    }
  }
}

async function main() {
  const keys = ['executable', 'source-commit', 'executable-sha256', 'package-sha256', 'output'];
  const options = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.slice(2);
    if (
      !args[index]?.startsWith('--') ||
      !keys.includes(key) ||
      options[key] !== undefined ||
      args[index + 1] === undefined
    )
      throw new Error();
    options[key] = args[index + 1];
  }
  if (Object.keys(options).length !== keys.length) throw new Error();
  const controller = new globalThis.AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    await collectOwnedComputerUseStartup({
      executable: options.executable,
      expectedSourceCommit: options['source-commit'],
      expectedExecutableSha256: options['executable-sha256'],
      packageSha256: options['package-sha256'],
      outputPath: options.output,
      signal: controller.signal,
    });
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {
    process.stderr.write('COMPUTER_USE_OWNED_STARTUP_CHECKPOINT_FAILED\n');
    process.exitCode = 1;
  });
}

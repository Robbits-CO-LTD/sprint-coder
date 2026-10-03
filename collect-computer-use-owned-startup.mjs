import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashExecutable, startOwnedComputerUseCapture } from './collect-computer-use-runtime.mjs';
import { startPinnedOwnedComputerUseProcessCapture } from './computer-use-owned-process-receipt.mjs';

const DIGEST = /^(?!0{64}$)[a-f0-9]{64}$/u;

/**
 * Protected workflow startup/shutdown checkpoint, never parent acceptance or verified facts.
 * On win32 the process identity producer is connected through the pinned addon retainer; the
 * report carries only a digest (startupProcessIdentityDigest, deliberately not the parent
 * closure's processIdentityDigest owned-run fact). On other platforms the digest is null,
 * meaning "not measured", never "no process". load is only a test seam for the addon loader.
 */
export async function collectOwnedComputerUseStartup(input, startCapture, load) {
  let capture;
  let profile;
  let timer;
  let signal;
  let onAbort;
  let closed = false;
  let transportValidated = false;
  let reportWritten = false;
  try {
    const {
      executable,
      expectedSourceCommit,
      expectedExecutableSha256,
      packageSha256,
      outputPath,
      timeoutMs = 120_000,
      addonPath,
      addonSha256,
    } = input;
    const windows = process.platform === 'win32';
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
    if (windows) {
      if (
        typeof addonPath !== 'string' ||
        !isAbsolute(addonPath) ||
        !addonPath.endsWith('.node') ||
        typeof addonSha256 !== 'string' ||
        !DIGEST.test(addonSha256) ||
        hashExecutable(addonPath, 64 * 1024 * 1024) !== addonSha256
      )
        throw new Error();
    } else if (addonPath !== undefined || addonSha256 !== undefined) throw new Error();
    if (hashExecutable(executable) !== expectedExecutableSha256) throw new Error();
    signal = input.signal;
    if (signal !== undefined && !(signal instanceof globalThis.AbortSignal)) throw new Error();
    if (signal?.aborted) throw new Error();
    const canceled = new Promise((_, reject) => {
      onAbort = () => reject(new Error());
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    profile = mkdtempSync(join(dirname(outputPath), 'owned-startup-profile-'));
    const start =
      startCapture ??
      (windows
        ? (launch) =>
            startPinnedOwnedComputerUseProcessCapture(
              { capture: launch, addonPath, addonSha256 },
              load,
            )
        : startOwnedComputerUseCapture);
    capture = start({
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
      completed.sessions.length !== 0 ||
      (windows &&
        !(
          typeof completed.processIdentityDigest === 'string' &&
          DIGEST.test(completed.processIdentityDigest)
        ))
    )
      throw new Error();
    transportValidated = true;
    const report = Object.freeze({
      schemaVersion: 2,
      evidenceKind: 'owned-startup-shutdown-checkpoint',
      finalGateEligible: false,
      sourceCommit: expectedSourceCommit,
      platform: completed.hello.platform,
      packageSha256,
      executableSha256: completed.executableSha256,
      runIdDigest: completed.runIdDigest,
      eventChainDigest: completed.eventChainDigest,
      startupProcessIdentityDigest: windows ? completed.processIdentityDigest : null,
      transportCompleted: true,
      sessionCount: 0,
      frameCount: completed.frameCount,
    });
    const bytes = `${JSON.stringify(report)}\n`;
    if (Buffer.byteLength(bytes) > 4096) throw new Error();
    writeFileSync(outputPath, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    reportWritten = true;
    return report;
  } catch {
    throw new Error('COMPUTER_USE_OWNED_STARTUP_CHECKPOINT_FAILED');
  } finally {
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
    clearTimeout(timer);
    capture?.stopOwnedChild();
    if (capture !== undefined && !closed) capture.abandon();
    // Only a saved checkpoint from a normal fully closed child permits profile cleanup. Failed
    // publication or an unconfirmed forced stop retains local state; root kill is not descendant proof.
    if (profile !== undefined && closed && transportValidated && reportWritten) {
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        /* Local isolated state only. */
      }
    }
  }
}

/** Complete per-platform key set: win32 requires the addon pair, other platforms forbid it. */
export function parseOwnedStartupArguments(args, platform = process.platform) {
  const base = ['executable', 'source-commit', 'executable-sha256', 'package-sha256', 'output'];
  const addon = ['owned-process-addon', 'owned-process-addon-sha256'];
  const keys = platform === 'win32' ? [...base, ...addon] : base;
  const options = {};
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
  return options;
}

async function main() {
  const options = parseOwnedStartupArguments(process.argv.slice(2));
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
      ...(process.platform === 'win32'
        ? {
            addonPath: options['owned-process-addon'],
            addonSha256: options['owned-process-addon-sha256'],
          }
        : {}),
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

import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { homedir } from 'node:os';
import {
  RECOGNIZED_CODEX_NOTIFICATION_NAMES,
  type ResolvedCliCommand,
  type RuntimeFailureDiagnostic,
  type RuntimeFailureStage,
} from './protocol';

export const RUNTIME_DIAGNOSTIC_MAX_BYTES = 16 * 1024;
const STDERR_TAIL_MAX_BYTES = 8 * 1024;
const UNSUPPORTED_NOTIFICATION = '[unsupported]';
const SAFE_NOTIFICATION_METHOD = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u;
const SENSITIVE_NOTIFICATION_NAMESPACE =
  /^(?:auth|credential|private|request|secret|token|user)(?:[/:]|$)/iu;

export class RuntimeFailureDiagnosticCollector {
  private readonly startedAt: number;
  private stderrBytes = 0;
  private stderrObserved = false;
  private stderrTruncated = false;
  private lastReceivedNotification: string | null = null;
  private lastRecognizedNotification: string | null = null;
  private unsupportedNotificationCount = 0;
  private cliResolution: ResolvedCliCommand | null = null;

  constructor(
    private readonly runtimeKind: 'codex' | 'claude',
    private readonly appVersion: string,
    private cliVersion: string | null,
    private readonly teamMcpEnabled: boolean,
    /** Unix epoch milliseconds. Invalid values safely degrade to the construction time. */
    startedAtMs: number = Date.now(),
  ) {
    this.startedAt = safeEpochMilliseconds(startedAtMs, Date.now());
  }

  setCliVersion(version: string | null): void {
    this.cliVersion = safeCliVersion(this.runtimeKind, version);
  }

  setCliResolution(cli: ResolvedCliCommand | null): void {
    this.cliResolution = cli === null ? null : safeCliResolution(cli);
  }

  recordNotification(method: string): void {
    if (this.runtimeKind === 'codex' && RECOGNIZED_CODEX_NOTIFICATION_NAMES.has(method)) {
      this.lastReceivedNotification = method;
      this.lastRecognizedNotification = method;
      return;
    }
    // Preserve a bounded protocol method for diagnosis, but collapse anything content-bearing,
    // path-like, or malformed to a constant marker before it crosses the Runtime boundary.
    this.lastReceivedNotification =
      SAFE_NOTIFICATION_METHOD.test(method) && !SENSITIVE_NOTIFICATION_NAMESPACE.test(method)
        ? method
        : UNSUPPORTED_NOTIFICATION;
    this.unsupportedNotificationCount += 1;
  }

  recordStderr(chunk: Buffer | string): void {
    const bytes = Buffer.byteLength(chunk);
    if (bytes === 0) return;
    this.stderrObserved = true;
    this.stderrBytes += bytes;
    if (this.stderrBytes > STDERR_TAIL_MAX_BYTES) this.stderrTruncated = true;
  }

  snapshot(stage: RuntimeFailureStage, now = Date.now()): RuntimeFailureDiagnostic {
    const diagnostic: RuntimeFailureDiagnostic = {
      version: 1,
      diagnosticId: randomUUID(),
      runtimeKind: this.runtimeKind,
      failureStage: stage,
      elapsedMs: safeElapsedMilliseconds(this.startedAt, now),
      appVersion: boundedText(this.appVersion, 64) ?? 'unknown',
      cliVersion: safeCliVersion(this.runtimeKind, this.cliVersion),
      ...(this.cliResolution === null ? {} : { cliResolution: this.cliResolution }),
      teamMcp: {
        enabled: this.teamMcpEnabled,
        status: this.teamMcpEnabled ? 'configured' : 'not_configured',
      },
      lastRecognizedNotification: this.lastRecognizedNotification,
      lastReceivedNotification: this.lastReceivedNotification,
      unsupportedNotificationCount: this.unsupportedNotificationCount,
      stderrObserved: this.stderrObserved,
      stderrTruncated: this.stderrTruncated,
      recordedAt: new Date(now).toISOString(),
    };
    return diagnostic;
  }
}

function safeCliResolution(cli: ResolvedCliCommand): ResolvedCliCommand {
  const home = homedir();
  const executable =
    home !== '' && cli.executable.startsWith(home)
      ? `<home>${cli.executable.slice(home.length)}`
      : cli.executable;
  return {
    source: cli.source,
    executable: executable.slice(0, 2_048),
    version: cli.version.slice(0, 128),
    compatibility: cli.compatibility,
    capabilities: cli.capabilities.slice(0, 32),
  };
}

type ResolveRuntimeFailureDiagnosticInput = Readonly<{
  errorCode: string;
  diagnostic: RuntimeFailureDiagnostic | undefined;
  runtimeKind: 'codex' | 'claude';
  appVersion: string;
  /** Unix epoch milliseconds captured when Main dispatched the Turn. */
  startedAtMs: number | undefined;
  teamMcpEnabled: boolean;
  /** Unix epoch milliseconds used to make elapsed-time calculation deterministic in tests. */
  nowMs?: number;
}>;

/**
 * Keeps adapter diagnostics intact and creates a structure-only fallback for a missing protocol
 * diagnostic. Raw errors, messages, prompts, tool arguments, environment values, and paths are
 * deliberately absent from this API so Main cannot accidentally persist them.
 */
export function resolveRuntimeFailureDiagnostic({
  errorCode,
  diagnostic,
  runtimeKind,
  appVersion,
  startedAtMs,
  teamMcpEnabled,
  nowMs = Date.now(),
}: ResolveRuntimeFailureDiagnosticInput): RuntimeFailureDiagnostic | undefined {
  if (
    diagnostic !== undefined &&
    diagnostic.runtimeKind === runtimeKind &&
    diagnostic.reasonCode === undefined
  )
    return diagnostic;
  if (errorCode !== 'RUNTIME_PROTOCOL_ERROR') return undefined;
  const safeNow = safeEpochMilliseconds(nowMs, Date.now());
  const reasonCode = diagnostic?.runtimeKind === runtimeKind ? diagnostic.reasonCode : undefined;
  const resolved = new RuntimeFailureDiagnosticCollector(
    runtimeKind,
    appVersion,
    null,
    teamMcpEnabled,
    safeEpochMilliseconds(startedAtMs, safeNow),
  ).snapshot('protocol_error', safeNow);
  return reasonCode === undefined ? resolved : { ...resolved, reasonCode };
}

function safeEpochMilliseconds(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function safeElapsedMilliseconds(startedAtMs: number, nowMs: number): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return 0;
  const elapsed = nowMs - startedAtMs;
  return Number.isSafeInteger(elapsed) ? Math.max(0, elapsed) : 0;
}

function boundedText(value: string | null, maxLength: number): string | null {
  if (value === null || value.trim() === '') return null;
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function safeCliVersion(runtimeKind: 'codex' | 'claude', value: string | null): string | null {
  const bounded = boundedText(value, 128);
  const pattern =
    runtimeKind === 'codex'
      ? /^(?:codex|codex-cli) v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
      : /^(?:claude-code )?v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?(?: \(Claude Code\))?$/;
  return bounded !== null && pattern.test(bounded) ? bounded : null;
}

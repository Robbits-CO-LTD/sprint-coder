import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  RECOGNIZED_CODEX_NOTIFICATION_NAMES,
  type RuntimeFailureDiagnostic,
  type RuntimeFailureStage,
} from './protocol';

export const RUNTIME_DIAGNOSTIC_MAX_BYTES = 16 * 1024;
const STDERR_TAIL_MAX_BYTES = 8 * 1024;
const UNSUPPORTED_NOTIFICATION = '[unsupported]';

export class RuntimeFailureDiagnosticCollector {
  private readonly startedAt = Date.now();
  private stderrBytes = 0;
  private stderrObserved = false;
  private stderrTruncated = false;
  private lastReceivedNotification: string | null = null;
  private lastRecognizedNotification: string | null = null;
  private unsupportedNotificationCount = 0;

  constructor(
    private readonly runtimeKind: 'codex' | 'claude',
    private readonly appVersion: string,
    private cliVersion: string | null,
    private readonly teamMcpEnabled: boolean,
  ) {}

  setCliVersion(version: string | null): void {
    this.cliVersion = safeCliVersion(version);
  }

  recordNotification(method: string): void {
    if (this.runtimeKind === 'codex' && RECOGNIZED_CODEX_NOTIFICATION_NAMES.has(method)) {
      this.lastReceivedNotification = method;
      this.lastRecognizedNotification = method;
      return;
    }
    // Notification methods are supplied by the child process. Unknown values may contain user
    // content, paths, or credentials, so only their count and a constant marker cross the boundary.
    this.lastReceivedNotification = UNSUPPORTED_NOTIFICATION;
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
      elapsedMs: Math.max(0, Math.round(now - this.startedAt)),
      appVersion: boundedText(this.appVersion, 64) ?? 'unknown',
      cliVersion: safeCliVersion(this.cliVersion),
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

function boundedText(value: string | null, maxLength: number): string | null {
  if (value === null || value.trim() === '') return null;
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function safeCliVersion(value: string | null): string | null {
  const bounded = boundedText(value, 128);
  return bounded !== null &&
    /^(?:codex|codex-cli) v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(bounded)
    ? bounded
    : null;
}

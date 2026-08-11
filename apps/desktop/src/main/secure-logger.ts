import { redactSecrets } from './secret-redactor';

export type SecureLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type SecureLogCategory = 'system' | 'chat' | 'team';
export type SecureLogMetadata = Readonly<{
  category?: SecureLogCategory;
  event?: string;
  taskId?: string;
  turnId?: string;
  teamId?: string;
  missionId?: string;
  workerId?: string;
  runtime?: string;
  provider?: string;
  status?: string;
  result?: string;
  durationMs?: number;
}>;
export type SecureLogEntry = Readonly<{
  timestamp: string;
  level: SecureLogLevel;
  category: SecureLogCategory;
  event: string;
  message: string;
  taskId?: string;
  turnId?: string;
  teamId?: string;
  missionId?: string;
  workerId?: string;
  runtime?: string;
  provider?: string;
  status?: string;
  result?: string;
  durationMs?: number;
  context?: unknown;
}>;
export type SecureLogSink = (entry: SecureLogEntry) => void;

const SECRET_KEY =
  /^(?:authorization|proxy-authorization|api[-_]?key|x-api-key|access[-_]?token|refresh[-_]?token|cookie|set-cookie|password|passwd|secret|client[-_]?secret)$/i;
const SECRET_QUERY_KEY =
  /^(?:api[-_]?key|key|token|access[-_]?token|refresh[-_]?token|authorization|auth|signature|sig|secret)$/i;

export class SecureLogger {
  constructor(private sink: SecureLogSink = writeSecureLogEntry) {}

  setSink(sink: SecureLogSink): void {
    this.sink = sink;
  }

  debug(message: string, context?: unknown, metadata?: SecureLogMetadata): void {
    this.write('debug', message, context, metadata);
  }

  info(message: string, context?: unknown, metadata?: SecureLogMetadata): void {
    this.write('info', message, context, metadata);
  }

  warn(message: string, context?: unknown, metadata?: SecureLogMetadata): void {
    this.write('warn', message, context, metadata);
  }

  error(message: string, context?: unknown, metadata?: SecureLogMetadata): void {
    this.write('error', message, context, metadata);
  }

  private write(
    level: SecureLogLevel,
    message: string,
    context?: unknown,
    metadata: SecureLogMetadata = {},
  ): void {
    const safeMetadata = redactLogValue(metadata) as SecureLogMetadata;
    this.sink({
      timestamp: new Date().toISOString(),
      level,
      category: safeMetadata.category ?? 'system',
      event: safeMetadata.event ?? 'diagnostic',
      message: redactLogString(message),
      ...(safeMetadata.taskId === undefined ? {} : { taskId: safeMetadata.taskId }),
      ...(safeMetadata.turnId === undefined ? {} : { turnId: safeMetadata.turnId }),
      ...(safeMetadata.teamId === undefined ? {} : { teamId: safeMetadata.teamId }),
      ...(safeMetadata.missionId === undefined ? {} : { missionId: safeMetadata.missionId }),
      ...(safeMetadata.workerId === undefined ? {} : { workerId: safeMetadata.workerId }),
      ...(safeMetadata.runtime === undefined ? {} : { runtime: safeMetadata.runtime }),
      ...(safeMetadata.provider === undefined ? {} : { provider: safeMetadata.provider }),
      ...(safeMetadata.status === undefined ? {} : { status: safeMetadata.status }),
      ...(safeMetadata.result === undefined ? {} : { result: safeMetadata.result }),
      ...(safeMetadata.durationMs === undefined ? {} : { durationMs: safeMetadata.durationMs }),
      ...(context === undefined ? {} : { context: redactLogValue(context) }),
    });
  }
}

export const secureLogger = new SecureLogger();

export function redactLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactLogString(value);
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'undefined'
  )
    return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error)
    return {
      name: value.name,
      message: redactLogString(value.message),
      ...(value.stack === undefined ? {} : { stack: redactLogString(value.stack) }),
    };
  if (typeof value !== 'object') return redactLogString(String(value));
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactLogValue(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value))
    output[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redactLogValue(item, seen);
  return output;
}

function redactLogString(value: string): string {
  const redacted = redactSecrets(value);
  try {
    const url = new URL(redacted);
    let changed = false;
    for (const key of url.searchParams.keys())
      if (SECRET_QUERY_KEY.test(key)) {
        url.searchParams.set(key, '[REDACTED]');
        changed = true;
      }
    return changed ? url.toString() : redacted;
  } catch {
    return redacted;
  }
}

export function writeSecureLogEntry(entry: SecureLogEntry): void {
  const line = `${JSON.stringify(entry)}\n`;
  if (entry.level === 'error' || entry.level === 'warn') process.stderr.write(line);
  else process.stdout.write(line);
}

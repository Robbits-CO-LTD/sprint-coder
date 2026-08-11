import { redactSecrets } from './secret-redactor';

export type SecureLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type SecureLogEntry = Readonly<{
  timestamp: string;
  level: SecureLogLevel;
  message: string;
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

  debug(message: string, context?: unknown): void {
    this.write('debug', message, context);
  }

  info(message: string, context?: unknown): void {
    this.write('info', message, context);
  }

  warn(message: string, context?: unknown): void {
    this.write('warn', message, context);
  }

  error(message: string, context?: unknown): void {
    this.write('error', message, context);
  }

  private write(level: SecureLogLevel, message: string, context?: unknown): void {
    this.sink({
      timestamp: new Date().toISOString(),
      level,
      message: redactLogString(message),
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

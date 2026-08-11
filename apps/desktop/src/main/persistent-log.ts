import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { SecureLogEntry, SecureLogSink } from './secure-logger';

const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;
const LOG_FILE_NAME = 'sprint-coder.log';
const PREVIOUS_LOG_FILE_NAME = 'sprint-coder.previous.log';

export type PersistentLog = Readonly<{
  filePath: string;
  sink: SecureLogSink;
}>;

export function createPersistentLog(
  logDirectory: string,
  maxLogBytes = DEFAULT_MAX_LOG_BYTES,
): PersistentLog {
  if (!Number.isSafeInteger(maxLogBytes) || maxLogBytes <= 0)
    throw new RangeError('maxLogBytes must be a positive safe integer');

  mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  if (!lstatSync(logDirectory).isDirectory())
    throw new Error('Diagnostic log directory is not a regular directory');
  chmodSync(logDirectory, 0o700);
  const filePath = join(logDirectory, LOG_FILE_NAME);
  const previousFilePath = join(logDirectory, PREVIOUS_LOG_FILE_NAME);
  ensurePrivateFile(filePath);

  let currentBytes = statSync(filePath).size;
  const rotate = (): void => {
    assertRegularFileOrMissing(previousFilePath);
    copyFileSync(filePath, previousFilePath);
    chmodSync(previousFilePath, 0o600);
    truncateSync(filePath, 0);
    currentBytes = 0;
  };
  if (currentBytes >= maxLogBytes) rotate();

  return {
    filePath,
    sink: (entry: SecureLogEntry): void => {
      const line = `${JSON.stringify(entry)}\n`;
      const lineBytes = Buffer.byteLength(line);
      if (currentBytes > 0 && currentBytes + lineBytes > maxLogBytes) rotate();
      writeFileSync(filePath, line, { encoding: 'utf8', flag: 'a', mode: 0o600 });
      currentBytes += lineBytes;
    },
  };
}

export function combineLogSinks(...sinks: readonly SecureLogSink[]): SecureLogSink {
  return (entry): void => {
    for (const sink of sinks)
      try {
        sink(entry);
      } catch {
        // Diagnostics must never become a new application failure. The remaining sink (normally
        // stderr/stdout) still receives the entry when disk access becomes unavailable.
      }
  };
}

function ensurePrivateFile(filePath: string): void {
  assertRegularFileOrMissing(filePath);
  const descriptor = openSync(filePath, 'a', 0o600);
  closeSync(descriptor);
  chmodSync(filePath, 0o600);
}

function assertRegularFileOrMissing(filePath: string): void {
  try {
    if (!lstatSync(filePath).isFile()) throw new Error('Diagnostic log path is not a regular file');
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

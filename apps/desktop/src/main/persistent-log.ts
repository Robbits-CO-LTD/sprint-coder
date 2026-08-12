import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';
import type { SecureLogEntry, SecureLogSink } from './secure-logger';

const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_STREAMS_PER_CATEGORY = 100;
const SAFE_STREAM_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export type PersistentLog = Readonly<{
  rootPath: string;
  /** Compatibility alias for the primary System log. */
  filePath: string;
  filePathFor: (entry: Pick<SecureLogEntry, 'category' | 'taskId' | 'teamId'>) => string;
  sink: SecureLogSink;
}>;

export function resolveDiagnosticLogRoot(input: {
  homeDirectory: string;
  userDataOverride?: string | undefined;
  platform?: NodeJS.Platform;
}): string {
  const flavor = input.platform === 'win32' ? win32 : posix;
  const base = input.userDataOverride?.trim();
  if (base !== undefined && base.length > 0) return flavor.join(flavor.resolve(base), 'logs');
  return flavor.join(flavor.resolve(input.homeDirectory), '.sprintcoder', 'logs');
}

export function createPersistentLog(
  logRoot: string,
  maxLogBytes = DEFAULT_MAX_LOG_BYTES,
  maxStreamsPerCategory = DEFAULT_MAX_STREAMS_PER_CATEGORY,
): PersistentLog {
  if (!Number.isSafeInteger(maxLogBytes) || maxLogBytes <= 0)
    throw new RangeError('maxLogBytes must be a positive safe integer');
  if (!Number.isSafeInteger(maxStreamsPerCategory) || maxStreamsPerCategory <= 0)
    throw new RangeError('maxStreamsPerCategory must be a positive safe integer');

  mkdirSync(logRoot, { recursive: true, mode: 0o700 });
  assertRegularDirectory(dirname(logRoot), 'Diagnostic log parent is not a regular directory');
  ensurePrivateDirectory(logRoot);
  for (const category of ['system', 'chat', 'team'] as const)
    ensurePrivateDirectory(join(logRoot, category));

  const currentBytes = new Map<string, number>();
  const filePathFor = (entry: Pick<SecureLogEntry, 'category' | 'taskId' | 'teamId'>): string => {
    const streamId = streamIdFor(entry);
    return join(logRoot, entry.category, `${streamId}.jsonl`);
  };
  const systemFilePath = filePathFor({ category: 'system' });
  ensurePrivateFile(systemFilePath);
  currentBytes.set(systemFilePath, statSync(systemFilePath).size);

  const rotate = (filePath: string): void => {
    const previousFilePath = previousPathFor(filePath);
    assertRegularFileOrMissing(previousFilePath);
    copyFileSync(filePath, previousFilePath);
    chmodSync(previousFilePath, 0o600);
    truncateSync(filePath, 0);
    currentBytes.set(filePath, 0);
  };
  if ((currentBytes.get(systemFilePath) ?? 0) >= maxLogBytes) rotate(systemFilePath);

  return {
    rootPath: logRoot,
    filePath: systemFilePath,
    filePathFor,
    sink: (entry: SecureLogEntry): void => {
      const filePath = filePathFor(entry);
      if (!currentBytes.has(filePath)) {
        if (entry.category !== 'system' && !existsSync(filePath))
          pruneOldestStreams(dirname(filePath), maxStreamsPerCategory, currentBytes);
        ensurePrivateFile(filePath);
        currentBytes.set(filePath, statSync(filePath).size);
        if ((currentBytes.get(filePath) ?? 0) >= maxLogBytes) rotate(filePath);
      }
      const line = `${JSON.stringify(entry)}\n`;
      const lineBytes = Buffer.byteLength(line);
      if (
        (currentBytes.get(filePath) ?? 0) > 0 &&
        (currentBytes.get(filePath) ?? 0) + lineBytes > maxLogBytes
      )
        rotate(filePath);
      writeFileSync(filePath, line, { encoding: 'utf8', flag: 'a', mode: 0o600 });
      currentBytes.set(filePath, (currentBytes.get(filePath) ?? 0) + lineBytes);
    },
  };
}

function pruneOldestStreams(
  categoryDirectory: string,
  maxStreams: number,
  currentBytes: Map<string, number>,
): void {
  const streams = readdirSync(categoryDirectory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.endsWith('.previous.jsonl'),
    )
    .map((entry) => {
      const filePath = join(categoryDirectory, entry.name);
      return { filePath, modifiedAt: lstatSync(filePath).mtimeMs };
    })
    .sort((left, right) => left.modifiedAt - right.modifiedAt);
  while (streams.length >= maxStreams) {
    const oldest = streams.shift();
    if (oldest === undefined) break;
    unlinkVerifiedLogFile(oldest.filePath);
    currentBytes.delete(oldest.filePath);
    const previousFilePath = previousPathFor(oldest.filePath);
    if (existsSync(previousFilePath)) {
      unlinkVerifiedLogFile(previousFilePath);
      currentBytes.delete(previousFilePath);
    }
  }
}

function unlinkVerifiedLogFile(filePath: string): void {
  if (!lstatSync(filePath).isFile()) throw new Error('Refusing to prune a non-regular log file');
  unlinkSync(filePath);
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

function streamIdFor(entry: Pick<SecureLogEntry, 'category' | 'taskId' | 'teamId'>): string {
  if (entry.category === 'system') return 'system';
  if (entry.category === 'chat')
    return entry.taskId !== undefined && SAFE_STREAM_ID.test(entry.taskId)
      ? entry.taskId
      : 'unknown';
  // Team logs prefer their durable Team identity, but failures can arrive before a Team exists or
  // after it has been discarded. Preserve those by Task rather than pooling unrelated failures in
  // unknown.jsonl. Explicit namespaces prevent a Team id from colliding with a Task fallback.
  if (entry.teamId !== undefined && SAFE_STREAM_ID.test(entry.teamId))
    return `team-${entry.teamId}`;
  if (entry.taskId !== undefined && SAFE_STREAM_ID.test(entry.taskId))
    return `task-${entry.taskId}`;
  return 'unknown';
}

function previousPathFor(filePath: string): string {
  return filePath.endsWith('.jsonl')
    ? `${filePath.slice(0, -'.jsonl'.length)}.previous.jsonl`
    : `${filePath}.previous`;
}

function ensurePrivateDirectory(directoryPath: string): void {
  mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  assertRegularDirectory(directoryPath, 'Diagnostic log directory is not a regular directory');
  chmodSync(directoryPath, 0o700);
}

function assertRegularDirectory(directoryPath: string, message: string): void {
  if (!lstatSync(directoryPath).isDirectory()) throw new Error(message);
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

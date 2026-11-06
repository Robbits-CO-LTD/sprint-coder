import type { Writable } from 'node:stream';
import { GRAPH_WORKER_OUTPUT_MAX_BYTES } from '@sprint-coder/contracts';
import type { GraphWorkerResult } from '@sprint-coder/contracts';

function captureWrites(
  stream: Writable,
  capture: (chunk: string | Uint8Array, encoding: BufferEncoding) => void,
): () => void {
  const original = stream.write;
  const write = original.bind(stream);
  stream.write = (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    capture(chunk, typeof encoding === 'string' ? encoding : 'utf8');
    return typeof encoding === 'string'
      ? write(chunk, encoding, callback)
      : write(chunk, encoding ?? callback);
  };
  return () => {
    stream.write = original;
  };
}

function drain(stream: Writable): Promise<boolean> {
  if (stream.destroyed || stream.writableEnded) return Promise.resolve(false);
  return new Promise((resolve) => {
    // Keep an error listener until process exit: a failed write can emit its error after its callback.
    stream.once('error', () => resolve(false));
    stream.write('', (error) => resolve(!error));
  });
}

/** Adapt one pinned CLI invocation without letting its process.exit truncate piped output. */
export async function runWithDrainedOutput(
  run: () => Promise<void>,
  onComplete?: (result: GraphWorkerResult) => Promise<void>,
): Promise<never> {
  const realExit = process.exit;
  const requestedExit = new Error('Graph CLI requested exit');
  const outputLimit = new Error('Graph worker output limit');
  const chunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let exceeded = false;
  const record = (chunk: string | Uint8Array, encoding: BufferEncoding, stderr: boolean) => {
    const size = typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
    if (stderr) stderrBytes += size;
    else stdoutBytes += size;
    if (stdoutBytes + stderrBytes > GRAPH_WORKER_OUTPUT_MAX_BYTES) {
      exceeded = true;
      throw outputLimit;
    }
    if (!stderr)
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, encoding) : Buffer.from(chunk));
  };
  const restoreStdout = captureWrites(process.stdout, (chunk, encoding) =>
    record(chunk, encoding, false),
  );
  const restoreStderr = captureWrites(process.stderr, (chunk, encoding) =>
    record(chunk, encoding, true),
  );
  process.exit = (code): never => {
    process.exitCode = code ?? process.exitCode ?? 0;
    // A no-op would let a CLI continue past a fatal validation error.
    throw requestedExit;
  };
  try {
    await run();
  } catch (error) {
    if (error !== requestedExit) {
      process.exitCode = 1;
      if (error !== outputLimit) {
        // Restore before reporting so a nearly full capture cannot throw again in this catch.
        restoreStderr();
        stderrBytes += Buffer.byteLength('Graph worker failed\n');
        console.error('Graph worker failed');
      }
    }
  } finally {
    process.exit = realExit;
    restoreStdout();
    restoreStderr();
  }
  // A queued empty write completes after preceding writes, including console.log/error.
  const flushed = await Promise.all([drain(process.stdout), drain(process.stderr)]);
  const code = ((Number(process.exitCode ?? 0) % 256) + 256) % 256;
  exceeded ||= stdoutBytes + stderrBytes > GRAPH_WORKER_OUTPUT_MAX_BYTES;
  const exitCode = exceeded || !flushed.every(Boolean) ? code || 1 : code;
  try {
    await onComplete?.({
      type: 'sprint-graph-result',
      output: exceeded ? '' : Buffer.concat(chunks).toString('utf8'),
      exitCode,
      stderrBytes: Math.min(stderrBytes, GRAPH_WORKER_OUTPUT_MAX_BYTES),
    });
  } catch {
    return realExit(exitCode || 1);
  }
  return realExit(exitCode);
}

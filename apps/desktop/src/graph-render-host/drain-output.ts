import type { Writable } from 'node:stream';

function drain(stream: Writable): Promise<boolean> {
  if (stream.destroyed || stream.writableEnded) return Promise.resolve(false);
  return new Promise((resolve) => {
    // Keep an error listener until process exit: a failed write can emit its error after its callback.
    stream.once('error', () => resolve(false));
    stream.write('', (error) => resolve(!error));
  });
}

/** Adapt one pinned CLI invocation without letting its process.exit truncate piped output. */
export async function runWithDrainedOutput(run: () => Promise<void>): Promise<never> {
  const realExit = process.exit;
  const requestedExit = new Error('Graph CLI requested exit');
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
      console.error('Graph worker failed');
    }
  } finally {
    process.exit = realExit;
  }
  // A queued empty write completes after preceding writes, including console.log/error.
  const flushed = await Promise.all([drain(process.stdout), drain(process.stderr)]);
  return realExit(flushed.every(Boolean) ? (process.exitCode ?? 0) : process.exitCode || 1);
}

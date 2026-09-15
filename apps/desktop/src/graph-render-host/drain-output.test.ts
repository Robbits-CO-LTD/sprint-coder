import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const report = { ok: true, payload: 'x'.repeat(160 * 1024) };
const diagnostic = 'd'.repeat(80 * 1024) + '\n';
const output = `console.log(JSON.stringify(${JSON.stringify(report)}));
process.stderr.write(${JSON.stringify(diagnostic)});`;
let directory: string;
let worker: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'graph-worker-drain-'));
  worker = join(directory, 'worker.mjs');
  const built = await build({
    entryPoints: [resolve('src/graph-render-host/index.ts')],
    platform: 'node',
    format: 'esm',
    bundle: true,
    write: false,
  });
  await writeFile(worker, built.outputFiles[0]!.contents);
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function fixture(name: string, source: string) {
  const vendor = join(directory, name);
  await mkdir(join(vendor, 'scripts'), { recursive: true });
  const entry = join(vendor, 'scripts', 'check-render-output.mjs');
  await writeFile(entry, source);
  return { vendor, entry };
}

async function runChild(args: string[]) {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const events: string[] = [];
  let exitObservation:
    | { stdoutBytes: number; stderrBytes: number; stdoutEnded: boolean; stderrEnded: boolean }
    | undefined;
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.stdout.once('end', () => events.push('stdout:end'));
  child.stderr.once('end', () => events.push('stderr:end'));
  child.once('exit', () => {
    events.push('exit');
    exitObservation = {
      stdoutBytes: Buffer.concat(stdout).byteLength,
      stderrBytes: Buffer.concat(stderr).byteLength,
      stdoutEnded: child.stdout.readableEnded,
      stderrEnded: child.stderr.readableEnded,
    };
  });
  child.stdout.pause();
  child.stderr.pause();
  // Exercise a real full pipe, not a mocked write callback. Total output stays below Main's 256 KiB cap.
  const resume = setTimeout(() => {
    child.stdout.resume();
    child.stderr.resume();
  }, 200);
  const timeout = setTimeout(() => child.kill(), 10_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      // Wait for pipe EOF too, so a parent-side exit/data ordering race cannot explain truncation.
      child.once('close', resolve);
    });
    events.push('close');
    return {
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      exitObservation,
      events,
    };
  } finally {
    clearTimeout(resume);
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

describe('graph worker output drain', () => {
  it.each([0, 3])('flushes full JSON and stderr before requested exit %i', async (code) => {
    const { vendor } = await fixture(
      `exit-${code}`,
      `${output}\nprocess.exit(${code});\nconsole.log('unreachable');`,
    );
    const result = await runChild([worker, 'check', 'architecture', vendor, directory]);
    expect(result.code).toBe(code);
    expect(result.stdout).toBe(JSON.stringify(report) + '\n');
    expect(JSON.parse(result.stdout)).toEqual(report);
    expect(result.stderr).toBe(diagnostic);
  });

  it('preserves an exitCode set by a CLI that returns normally', async () => {
    const { vendor } = await fixture('implicit', `${output}\nprocess.exitCode = 7;`);
    const result = await runChild([worker, 'check', 'architecture', vendor, directory]);
    expect(result.code).toBe(7);
    expect(result.stdout).toBe(JSON.stringify(report) + '\n');
    expect(result.stderr).toBe(diagnostic);
  });

  it('flushes output and emits only the generic diagnostic for import errors', async () => {
    const { vendor } = await fixture('error', `${output}\nthrow new Error('private detail');`);
    const result = await runChild([worker, 'check', 'architecture', vendor, directory]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(JSON.stringify(report) + '\n');
    expect(result.stderr).toBe(diagnostic + 'Graph worker failed\n');
  });

  it('rejects invalid worker arguments', async () => {
    const result = await runChild([worker]);
    expect(result).toMatchObject({ code: 1, stdout: '', stderr: 'Graph worker failed\n' });
  });

  it('keeps the pinned checker nonzero JSON result intact', async () => {
    await writeFile(join(directory, 'diagram.html'), '<html>invalid graph</html>');
    const result = await runChild([
      worker,
      'check',
      'architecture',
      resolve('vendor/archify'),
      directory,
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
    expect(result.stderr).toBe('');
  });

  it('compares the original exit path with the adapter under identical backpressure', async () => {
    const { vendor, entry } = await fixture('before-after', `${output}\nprocess.exit(0);`);
    const legacy = `await import(${JSON.stringify(pathToFileURL(entry).href)}); process.exit(0);`;
    const before = await runChild(['--input-type=module', '-e', legacy]);
    const after = await runChild([worker, 'check', 'architecture', vendor, directory]);
    console.info('Graph worker pipe comparison', {
      expectedBytes: Buffer.byteLength(JSON.stringify(report) + '\n'),
      beforeBytes: Buffer.byteLength(before.stdout),
      afterBytes: Buffer.byteLength(after.stdout),
      beforeCode: before.code,
      afterCode: after.code,
      beforeExit: before.exitObservation,
      afterExit: after.exitObservation,
      afterEvents: after.events,
    });
    expect(before.code).toBe(0);
    // Some platforms synchronously write stdout; do not require a platform-specific bug in CI.
    if (before.stdout !== after.stdout) expect(() => JSON.parse(before.stdout)).toThrow();
    expect(after.stdout).toBe(JSON.stringify(report) + '\n');
    expect(after.stderr).toBe(diagnostic);
    expect(after.code).toBe(0);
    expect(await readFile(entry, 'utf8')).toBe(`${output}\nprocess.exit(0);`);
  });

  it('observes parent exit versus pipe EOF for a small fully flushed report', async () => {
    const reportLine = JSON.stringify({ ok: true }) + '\n';
    const { vendor } = await fixture(
      'parent-exit-order',
      `console.log(JSON.stringify({ok:true})); console.error('diagnostic'); process.exit(0);`,
    );
    const result = await runChild([worker, 'check', 'architecture', vendor, directory]);
    console.info('Graph worker parent exit observation', {
      expectedStdoutBytes: Buffer.byteLength(reportLine),
      exit: result.exitObservation,
      closeStdoutBytes: Buffer.byteLength(result.stdout),
      closeStderrBytes: Buffer.byteLength(result.stderr),
      events: result.events,
    });
    // Event order is platform-dependent; only EOF establishes the complete received output.
    expect(result.stdout).toBe(reportLine);
    expect(result.stderr).toBe('diagnostic\n');
    expect(result.code).toBe(0);
    expect(result.exitObservation).toBeDefined();
    expect(result.events.at(-1)).toBe('close');
  });
});

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROTOCOL_VERSION = 1;

export type SandboxRunnerCapability = Readonly<{
  available: boolean;
  backend: string;
  reason: string | null;
}>;

export async function probeSandboxRunner(
  executable = sandboxRunnerPath(),
): Promise<SandboxRunnerCapability> {
  try {
    verifySandboxRunnerDigest(executable);
    const result = await execFileAsync(executable, ['--probe-json'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    if (
      parsed['protocolVersion'] !== PROTOCOL_VERSION ||
      typeof parsed['available'] !== 'boolean' ||
      typeof parsed['backend'] !== 'string' ||
      (parsed['reason'] !== null && typeof parsed['reason'] !== 'string')
    )
      throw new Error('Invalid sandbox runner probe response');
    return Object.freeze({
      available: parsed['available'],
      backend: parsed['backend'],
      reason: parsed['reason'] as string | null,
    });
  } catch (error) {
    const failure =
      typeof error === 'object' && error !== null
        ? (error as { code?: unknown; signal?: unknown; killed?: unknown })
        : {};
    const detail =
      failure.killed === true
        ? 'timeout'
        : typeof failure.code === 'number' || typeof failure.code === 'string'
          ? `exit_${String(failure.code)
              .replace(/[^a-zA-Z0-9_-]/gu, '_')
              .slice(0, 32)}`
          : typeof failure.signal === 'string'
            ? `signal_${failure.signal.replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 32)}`
            : error instanceof SyntaxError
              ? 'invalid_response'
              : 'unknown';
    return Object.freeze({
      available: false,
      backend: `${process.platform}-unavailable`,
      reason: `sandbox_runner_probe_failed_${detail}`,
    });
  }
}

export function sandboxRunnerPath(): string {
  const name =
    process.platform === 'win32'
      ? 'sprint-coder-sandbox-runner.exe'
      : 'sprint-coder-sandbox-runner';
  if (__dirname.includes('app.asar')) {
    if (typeof process.resourcesPath !== 'string' || process.resourcesPath.length === 0)
      throw new Error('Packaged sandbox runner resource root is unavailable');
    return join(process.resourcesPath, name);
  }
  return join(__dirname, '..', '..', 'sandbox-runner', 'build', 'Release', name);
}

export function verifySandboxRunnerDigest(executable: string): void {
  const expected = readFileSync(`${executable}.sha256`, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/u.test(expected)) throw new Error('Invalid sandbox runner digest manifest');
  const actual = createHash('sha256').update(readFileSync(executable)).digest('hex');
  if (actual !== expected) throw new Error('Sandbox runner digest mismatch');
}

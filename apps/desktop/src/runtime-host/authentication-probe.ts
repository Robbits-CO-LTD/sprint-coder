import { spawn } from 'node:child_process';

export type AuthenticationState = 'authenticated' | 'unauthenticated' | 'unknown';
export type AuthenticationProbeKind = 'codex' | 'claude';

const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;

export function classifyAuthenticationResult(
  kind: AuthenticationProbeKind,
  code: number | null,
  output: string,
): AuthenticationState {
  if (code === 0) return 'authenticated';
  if (code !== 1) return 'unknown';
  if (kind === 'codex') {
    return /\b(?:not logged in|not authenticated)\b/i.test(output) ? 'unauthenticated' : 'unknown';
  }
  for (const candidate of [output, ...output.split(/\r?\n/).reverse()]) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (parsed['loggedIn'] === false || parsed['authenticated'] === false)
        return 'unauthenticated';
    } catch {
      // A usage error or unsupported command is not evidence that credentials are missing.
    }
  }
  return 'unknown';
}

export async function probeCliAuthentication(
  kind: AuthenticationProbeKind,
  command: string,
  args: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  timeoutMs: number,
): Promise<AuthenticationState> {
  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    const child = spawn(command, args, {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const append = (chunk: Buffer): void => {
      if (Buffer.byteLength(output, 'utf8') >= MAX_PROBE_OUTPUT_BYTES) return;
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output, 'utf8') > MAX_PROBE_OUTPUT_BYTES)
        output = Buffer.from(output, 'utf8').subarray(0, MAX_PROBE_OUTPUT_BYTES).toString('utf8');
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const finish = (result: AuthenticationState): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.once('error', () => finish('unknown'));
    child.once('exit', (code) => finish(classifyAuthenticationResult(kind, code, output)));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish('unknown');
    }, timeoutMs);
  });
}

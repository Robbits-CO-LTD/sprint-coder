import { spawn } from 'node:child_process';
import type { ResolvedCliCommand } from './protocol';

export type CliCommandCandidate = Readonly<{
  executable: string;
  source: ResolvedCliCommand['source'];
}>;

export function environmentValue(
  environment: Readonly<NodeJS.ProcessEnv>,
  key: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== 'win32') return environment[key];
  const matched = Object.keys(environment).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return matched === undefined ? undefined : environment[matched];
}

type ParsedVersion = Readonly<{
  major: number;
  minor: number;
  patch: number;
  prerelease: boolean;
}>;

const SOURCE_PRIORITY: Readonly<Record<ResolvedCliCommand['source'], number>> = {
  explicit: 0,
  'desktop-direct': 1,
  'desktop-versioned': 2,
  'user-local': 3,
  path: 4,
  npm: 5,
  fallback: 6,
};

const COMPATIBILITY_PRIORITY: Readonly<Record<ResolvedCliCommand['compatibility'], number>> = {
  verified: 0,
  compatible: 1,
  untested: 2,
  unsupported: 3,
};

export async function probeCliCommandCandidates(input: {
  kind: 'codex' | 'claude';
  candidates: readonly CliCommandCandidate[];
  environment: Readonly<NodeJS.ProcessEnv>;
  timeoutMs: number;
}): Promise<ResolvedCliCommand | null> {
  return probeFirstCapableCliCommand(input.kind, input.candidates, async (candidate) => {
    const version = await probeVersion(candidate.executable, input.environment, input.timeoutMs);
    if (version === null) return null;
    const capabilities = await probeRequiredCapabilities(
      input.kind,
      candidate.executable,
      input.environment,
      input.timeoutMs,
    );
    if (capabilities === null) return null;
    return {
      ...candidate,
      version,
      compatibility: compatibilityFor(input.kind, version),
      capabilities,
    } satisfies ResolvedCliCommand;
  });
}

export async function probeFirstCapableCliCommand(
  kind: 'codex' | 'claude',
  candidates: readonly CliCommandCandidate[],
  probe: (candidate: CliCommandCandidate) => Promise<ResolvedCliCommand | null>,
): Promise<ResolvedCliCommand | null> {
  const unique = deduplicateCandidates(candidates);
  const explicit = unique.filter(({ source }) => source === 'explicit');
  const desktop = unique.filter(
    ({ source }) => source === 'desktop-direct' || source === 'desktop-versioned',
  );
  const userLocal = unique.filter(({ source }) => source === 'user-local');
  const admissible =
    explicit.length > 0
      ? explicit.slice(0, 1)
      : kind === 'codex' && desktop.length > 0
        ? desktop
        : kind === 'claude' && userLocal.length > 0
          ? userLocal.slice(0, 1)
          : unique.slice(0, 1);
  const resolved: ResolvedCliCommand[] = [];
  for (const candidate of admissible) {
    const candidateResolution = await probe(candidate);
    if (candidateResolution !== null) resolved.push(candidateResolution);
  }
  return selectResolvedCliCommand(resolved);
}

export function selectResolvedCliCommand(
  candidates: readonly ResolvedCliCommand[],
): ResolvedCliCommand | null {
  return (
    [...candidates]
      .filter(({ compatibility }) => compatibility !== 'unsupported')
      .sort((left, right) => {
        const source = SOURCE_PRIORITY[left.source] - SOURCE_PRIORITY[right.source];
        if (source !== 0) return source;
        const compatibility =
          COMPATIBILITY_PRIORITY[left.compatibility] - COMPATIBILITY_PRIORITY[right.compatibility];
        if (compatibility !== 0) return compatibility;
        const leftVersion = parseVersion(left.version);
        const rightVersion = parseVersion(right.version);
        if (leftVersion !== null && rightVersion !== null) {
          const version = compareVersion(rightVersion, leftVersion);
          if (version !== 0) return version;
        }
        return left.executable.localeCompare(right.executable);
      })[0] ?? null
  );
}

export function compatibilityFor(
  kind: 'codex' | 'claude',
  versionText: string,
): ResolvedCliCommand['compatibility'] {
  const version = parseVersion(versionText);
  if (version === null || version.prerelease) return 'untested';
  const verified = kind === 'codex' ? [0, 144, 4] : [2, 1, 218];
  if (
    version.major === verified[0] &&
    version.minor === verified[1] &&
    version.patch === verified[2]
  )
    return 'verified';
  const minimum: ParsedVersion =
    kind === 'codex'
      ? { major: 0, minor: 136, patch: 0, prerelease: false }
      : { major: 2, minor: 1, patch: 170, prerelease: false };
  return compareVersion(version, minimum) >= 0 ? 'compatible' : 'unsupported';
}

function deduplicateCandidates(candidates: readonly CliCommandCandidate[]): CliCommandCandidate[] {
  const seen = new Set<string>();
  const result: CliCommandCandidate[] = [];
  for (const candidate of candidates) {
    const key =
      process.platform === 'win32' ? candidate.executable.toLowerCase() : candidate.executable;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

async function probeVersion(
  executable: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  timeoutMs: number,
): Promise<string | null> {
  const result = await probeCommand(executable, ['--version'], environment, timeoutMs, 512);
  const version = result?.output.trim() ?? '';
  return result?.code === 0 &&
    version !== '' &&
    version.length <= 128 &&
    ![...version].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
    ? version
    : null;
}

async function probeRequiredCapabilities(
  kind: 'codex' | 'claude',
  executable: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  timeoutMs: number,
): Promise<string[] | null> {
  if (kind === 'codex') {
    const result = await probeCommand(
      executable,
      ['app-server', '--help'],
      environment,
      timeoutMs,
      8 * 1024,
    );
    return result?.code === 0 ? ['version_probe', 'app_server'] : null;
  }
  const result = await probeCommand(executable, ['--help'], environment, timeoutMs, 64 * 1024);
  if (result?.code !== 0) return null;
  const capabilities = capabilitiesFromClaudeHelp(result.output);
  return capabilities.length === 6 ? capabilities : null;
}

export function capabilitiesFromClaudeHelp(help: string): string[] {
  const required = [
    ['--output-format', 'stream_json'],
    ['--include-partial-messages', 'partial_messages'],
    ['--strict-mcp-config', 'strict_mcp_config'],
    ['--safe-mode', 'safe_mode'],
    ['--no-session-persistence', 'no_session_persistence'],
  ] as const;
  return [
    'version_probe',
    ...required
      .filter(([flag]) => new RegExp(`(?:^|\\s)${flag}(?:[=\\s,]|$)`, 'mu').test(help))
      .map(([, capability]) => capability),
  ];
}

function probeCommand(
  executable: string,
  args: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  timeoutMs: number,
  outputLimit: number,
): Promise<{ code: number | null; output: string } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let child;
    try {
      child = spawn(executable, args, {
        env: { ...environment },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    const finish = (value: { code: number | null; output: string } | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const collect = (chunk: Buffer): void => {
      if (outputBytes >= outputLimit) return;
      const accepted = chunk.subarray(0, outputLimit - outputBytes);
      chunks.push(accepted);
      outputBytes += accepted.byteLength;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', () => finish(null));
    child.once('exit', (code) => {
      finish({ code, output: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

function parseVersion(value: string): ParsedVersion | null {
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)([-+][0-9A-Za-z.-]+)?(?:\s|$)/u.exec(value);
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, prerelease: match[4]?.startsWith('-') === true };
}

function compareVersion(left: ParsedVersion, right: ParsedVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

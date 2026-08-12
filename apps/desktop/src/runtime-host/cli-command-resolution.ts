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
  path: 1,
  'user-local': 2,
  npm: 3,
  'desktop-direct': 4,
  'desktop-versioned': 5,
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
  const unique = deduplicateCandidates(input.candidates);
  const probed = (
    await Promise.all(
      unique.map(async (candidate): Promise<ResolvedCliCommand | null> => {
        const version = await probeVersion(
          candidate.executable,
          input.environment,
          input.timeoutMs,
        );
        if (version === null) return null;
        return {
          ...candidate,
          version,
          compatibility: compatibilityFor(input.kind, version),
          capabilities: ['version_probe'],
        } satisfies ResolvedCliCommand;
      }),
    )
  ).filter((candidate): candidate is ResolvedCliCommand => candidate !== null);
  return selectResolvedCliCommand(probed);
}

export function selectResolvedCliCommand(
  candidates: readonly ResolvedCliCommand[],
): ResolvedCliCommand | null {
  return (
    [...candidates].sort((left, right) => {
      const compatibility =
        COMPATIBILITY_PRIORITY[left.compatibility] - COMPATIBILITY_PRIORITY[right.compatibility];
      if (compatibility !== 0) return compatibility;
      const leftVersion = parseVersion(left.version);
      const rightVersion = parseVersion(right.version);
      if (leftVersion !== null && rightVersion !== null) {
        const version = compareVersion(rightVersion, leftVersion);
        if (version !== 0) return version;
      }
      const source = SOURCE_PRIORITY[left.source] - SOURCE_PRIORITY[right.source];
      return source !== 0 ? source : left.executable.localeCompare(right.executable);
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

function probeVersion(
  executable: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let child;
    try {
      child = spawn(executable, ['--version'], {
        env: { ...environment },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
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
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunks.reduce((total, item) => total + item.byteLength, 0) < 512) chunks.push(chunk);
    });
    child.once('error', () => finish(null));
    child.once('exit', (code) => {
      const version = Buffer.concat(chunks).toString('utf8').trim();
      finish(code === 0 && version !== '' ? version.slice(0, 128) : null);
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

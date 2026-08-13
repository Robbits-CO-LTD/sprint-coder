import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

export type ExecutionSpec = Readonly<{
  version: 2;
  absoluteExecutable: string;
  executionIdentityDigest: string;
  argv: readonly string[];
  cwdIdentity: Readonly<{
    canonicalPath: string;
    identityDigest: string;
  }>;
  envDelta: Readonly<Record<string, string>>;
  stdinMode: 'closed';
  shell: 'none';
  commandBytesHash: string;
}>;

export type ExecutionSpecInput = Omit<ExecutionSpec, 'version' | 'commandBytesHash'>;

const DIGEST = /^[a-f0-9]{64}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const WINDOWS_PROGRAM_FILES_X86_KEY = /^PROGRAMFILES\(X86\)$/i;

export function createExecutionSpec(input: ExecutionSpecInput): ExecutionSpec {
  validateText(input.absoluteExecutable, 'absolute executable', 32_768);
  if (!isAbsolute(input.absoluteExecutable))
    throw new Error('ExecutionSpec requires an absolute executable');
  if (input.argv.length > 4_096) throw new Error('ExecutionSpec has too many argv entries');
  for (const value of input.argv) validateText(value, 'argv', 1_000_000, true);
  validateText(input.cwdIdentity.canonicalPath, 'cwd identity path', 32_768);
  if (!isAbsolute(input.cwdIdentity.canonicalPath))
    throw new Error('ExecutionSpec cwd identity must be absolute');
  if (!DIGEST.test(input.cwdIdentity.identityDigest))
    throw new Error('ExecutionSpec cwd identity digest is invalid');
  if (!DIGEST.test(input.executionIdentityDigest))
    throw new Error('ExecutionSpec execution identity digest is invalid');
  if (input.stdinMode !== 'closed') throw new Error('ExecutionSpec stdin mode is unsupported');
  if (input.shell !== 'none') throw new Error('ExecutionSpec shell mode is unsupported');

  const envDelta: Record<string, string> = {};
  for (const key of Object.keys(input.envDelta).sort()) {
    if (!ENV_KEY.test(key) && !WINDOWS_PROGRAM_FILES_X86_KEY.test(key))
      throw new Error('ExecutionSpec environment key is invalid');
    const value = input.envDelta[key];
    if (value === undefined) throw new Error('ExecutionSpec environment value is missing');
    validateText(value, 'environment value', 1_000_000, true);
    envDelta[key] = value;
  }
  const canonical = {
    version: 2 as const,
    absoluteExecutable: input.absoluteExecutable,
    executionIdentityDigest: input.executionIdentityDigest,
    argv: [...input.argv],
    cwdIdentity: { ...input.cwdIdentity },
    envDelta,
    stdinMode: input.stdinMode,
    shell: input.shell,
  };
  if (Buffer.byteLength(stableStringify(canonical), 'utf8') > 99_000)
    throw new Error('ExecutionSpec exceeds the approval display limit');
  return deepFreeze({
    ...canonical,
    commandBytesHash: digest(canonical),
  });
}

export function executionSpecDigest(spec: ExecutionSpec): string {
  return digest(spec);
}

export function validateExecutionSpec(value: unknown): value is ExecutionSpec {
  if (typeof value !== 'object' || value === null) return false;
  try {
    const candidate = value as ExecutionSpec;
    const rebuilt = createExecutionSpec({
      absoluteExecutable: candidate.absoluteExecutable,
      executionIdentityDigest: candidate.executionIdentityDigest,
      argv: candidate.argv,
      cwdIdentity: candidate.cwdIdentity,
      envDelta: candidate.envDelta,
      stdinMode: candidate.stdinMode,
      shell: candidate.shell,
    });
    return candidate.version === 2 && candidate.commandBytesHash === rebuilt.commandBytesHash;
  } catch {
    return false;
  }
}

function validateText(value: unknown, label: string, maxLength: number, allowEmpty = false): void {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maxLength)
    throw new Error(`ExecutionSpec ${label} is invalid`);
  if (value.includes('\0')) throw new Error(`ExecutionSpec ${label} contains NUL`);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object' && value !== null)
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

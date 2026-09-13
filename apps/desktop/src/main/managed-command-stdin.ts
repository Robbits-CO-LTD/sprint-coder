import { createHash } from 'node:crypto';
import type { ManagedCommandIdentity } from './managed-command-sessions';

/**
 * The approval subject of `write_stdin` (Issue #473).
 *
 * `exec_command` spawns with a writable stdin, so whatever is written afterwards becomes part of
 * what the approved command actually does — `tee`, `python3`, `node`, `sh -s` and `xargs` all take
 * their real instructions from stdin. The write therefore carries `shell.execute` like the command
 * itself, and the user is shown both the command the bytes reach and the bytes themselves.
 *
 * The prepared value is issued only by `createManagedStdinRequest`, and recognised only through the
 * WeakSet below, so no Tool input can present itself as one.
 */
export type ManagedStdinRequest = Readonly<{
  sessionId: string;
  chars: string;
  close: boolean;
  command: ManagedCommandIdentity;
}>;

const issuedStdinRequests = new WeakSet<object>();

/** Characters of stdin shown verbatim on the approval card before the value is summarised. */
const PREVIEW_CHARACTERS = 256;
/** Characters of the command line kept in the approval target, which persistence caps at 500. */
const TARGET_COMMAND_CHARACTERS = 300;

export function createManagedStdinRequest(
  input: Readonly<{ chars: string; close: boolean; command: ManagedCommandIdentity }>,
): ManagedStdinRequest {
  const request: ManagedStdinRequest = Object.freeze({
    sessionId: input.command.sessionId,
    chars: input.chars,
    close: input.close,
    command: Object.freeze({
      sessionId: input.command.sessionId,
      executable: input.command.executable,
      argv: Object.freeze([...input.command.argv]),
      cwd: input.command.cwd,
    }),
  });
  issuedStdinRequests.add(request);
  return request;
}

export function managedStdinAuthorizationFacts(input: unknown): ManagedStdinRequest | undefined {
  if (typeof input !== 'object' || input === null || !issuedStdinRequests.has(input))
    return undefined;
  return input as ManagedStdinRequest;
}

/** Approval target: the running command the bytes are delivered to, not the bytes. */
export function managedStdinApprovalTarget(request: ManagedStdinRequest): string {
  const commandLine = [request.command.executable, ...request.command.argv].join(' ');
  const shown =
    commandLine.length > TARGET_COMMAND_CHARACTERS
      ? `${commandLine.slice(0, TARGET_COMMAND_CHARACTERS)}…`
      : commandLine;
  return `stdin → ${shown} (session ${request.sessionId})`;
}

/**
 * Approval execution text. Long input is summarised rather than pasted in full, but the byte count
 * and digest are always present so the audit record identifies the exact bytes that were approved.
 */
export function managedStdinApprovalExecution(
  request: ManagedStdinRequest,
): Record<string, unknown> {
  const truncated = request.chars.length > PREVIEW_CHARACTERS;
  return {
    tool: 'write_stdin',
    sessionId: request.sessionId,
    executable: request.command.executable,
    argv: [...request.command.argv],
    cwd: request.command.cwd,
    close: request.close,
    charsBytes: Buffer.byteLength(request.chars, 'utf8'),
    charsSha256: createHash('sha256').update(request.chars, 'utf8').digest('hex'),
    charsTruncated: truncated,
    ...(truncated
      ? { charsPreview: request.chars.slice(0, PREVIEW_CHARACTERS) }
      : { chars: request.chars }),
  };
}

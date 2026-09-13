import { createHash } from 'node:crypto';
import type { ManagedCommandIdentity } from './managed-command-sessions';
import { redactSecrets } from './secret-redactor';

/**
 * The approval subject of `write_stdin` (Issue #473).
 *
 * `exec_command` spawns with a writable stdin, so whatever is written afterwards becomes part of
 * what the approved command does — `tee`, `python3`, `node`, `sh -s` and `xargs` all take their
 * real instructions from stdin. The write therefore carries `shell.execute` like the command
 * itself, and the user is shown both the command the bytes reach and the bytes themselves.
 *
 * The prepared value is issued only by `createManagedStdinRequest`, and recognised only through
 * the WeakSet below, so no Tool input can present itself as one.
 */
export type ManagedStdinRequest = Readonly<{
  sessionId: string;
  chars: string;
  close: boolean;
  command: ManagedCommandIdentity;
}>;

/**
 * One write is capped so the approval card can show all of it.
 *
 * A summarised card is a bypass, not a nicety: 256 harmless characters followed by a newline and
 * `rm -rf .` would have shown the user a comment and a digest they cannot verify, while the whole
 * value ran once they approved. Anything longer is refused before authorization with a message the
 * provider can act on, and consecutive writes are each approved on their own.
 */
export const MANAGED_STDIN_MAX_CHARACTERS = 2_048;

/** Characters of redacted stdin kept in the durable audit record. */
const AUDIT_PREVIEW_CHARACTERS = 64;

export class ManagedStdinRejection extends Error {
  constructor(
    readonly code: 'STDIN_TOO_LARGE',
    message: string,
  ) {
    super(message);
    this.name = 'ManagedStdinRejection';
  }
}

const issuedStdinRequests = new WeakSet<object>();

/**
 * Refuses a write the approval card could not show in full.
 *
 * Checked before the session is even resolved: the limit is a property of the call, and a value
 * this size can never become a card the user could read.
 */
export function assertManagedStdinSize(chars: string): void {
  if (chars.length <= MANAGED_STDIN_MAX_CHARACTERS) return;
  throw new ManagedStdinRejection(
    'STDIN_TOO_LARGE',
    `write_stdin accepts at most ${MANAGED_STDIN_MAX_CHARACTERS} characters per call so the approval card can show the whole value; this call sent ${chars.length}. Split the input into consecutive write_stdin calls of that size or less — each one is approved on its own — and send the final call with close: true.`,
  );
}

export function createManagedStdinRequest(
  input: Readonly<{ chars: string; close: boolean; command: ManagedCommandIdentity }>,
): ManagedStdinRequest {
  assertManagedStdinSize(input.chars);
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
  const commandLine = visibleStdinText(
    [request.command.executable, ...request.command.argv].join(' '),
  );
  const shown = commandLine.length > 300 ? `${commandLine.slice(0, 300)}…` : commandLine;
  return `stdin → ${shown} (session ${request.sessionId})`;
}

/**
 * The durable audit projection, which is what `requestApproval` writes to `display_json` and to
 * the persisted `approval.requested` event.
 *
 * It deliberately carries no raw stdin. A password, Bearer token, or private key sent to a
 * command would otherwise survive in plaintext — and reach the unprivileged Renderer's history —
 * even after the user refused the write. The byte count and digest still identify the exact bytes
 * that were offered, and the short preview is passed through the same secret scanner used for
 * command output before it is stored.
 */
export function managedStdinApprovalExecution(
  request: ManagedStdinRequest,
): Record<string, unknown> {
  return {
    tool: 'write_stdin',
    sessionId: request.sessionId,
    executable: request.command.executable,
    argv: [...request.command.argv],
    cwd: request.command.cwd,
    close: request.close,
    charsBytes: Buffer.byteLength(request.chars, 'utf8'),
    charsSha256: createHash('sha256').update(request.chars, 'utf8').digest('hex'),
    charsPreview: visibleStdinText(redactSecrets(request.chars).slice(0, AUDIT_PREVIEW_CHARACTERS)),
  };
}

/**
 * The live card text: every character that will be written, unsummarised and unredacted.
 *
 * This is the value the user is actually deciding on, so it is never stored — the coordinator
 * hands it to the pending approval only, and persistence drops it before writing anything. The
 * durable record keeps the digest above.
 */
export function managedStdinEphemeralExecution(request: ManagedStdinRequest): string {
  return [
    visibleStdinText([request.command.executable, ...request.command.argv].join(' ')),
    `session=${request.sessionId} cwd=${request.command.cwd} close=${request.close} bytes=${Buffer.byteLength(request.chars, 'utf8')} sha256=${createHash('sha256').update(request.chars, 'utf8').digest('hex')}`,
    '--- stdin ---',
    visibleStdinText(request.chars),
  ].join('\n');
}

/**
 * Makes every character visible.
 *
 * Newlines stay newlines — the card renders the execution block with `white-space: pre-wrap`, so a
 * line break is shown as a line break rather than swallowed. Everything else that a display can
 * hide behind is written out: C0/C1 controls (a lone carriage return can overwrite what came
 * before it), and the bidi and zero-width formatting characters that let text claim to say one
 * thing and run another.
 */
export function visibleStdinText(value: string): string {
  return value.replace(HIDEABLE_CHARACTERS, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return `\\x{${code.toString(16).toUpperCase().padStart(2, '0')}}`;
  });
}

// Tab and newline are kept as themselves: the card renders the execution block with
// `white-space: pre-wrap`, so they are shown rather than swallowed. Everything else a display can
// hide behind is written out.
const HIDEABLE_CHARACTERS =
  // eslint-disable-next-line no-control-regex -- matching hideable characters is the point
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu;

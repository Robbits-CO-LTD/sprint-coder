import { createHash } from 'node:crypto';
import { APPROVAL_EPHEMERAL_EXECUTION_MAX_CHARACTERS } from '@sprint-coder/contracts';
import type { ManagedCommandIdentity } from './managed-command-sessions';

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

/** How much of the command line and cwd the card header keeps, so its length stays bounded. */
const HEADER_FIELD_CHARACTERS = 300;

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
  // The card text is what the approval event carries, and an event the contract rejects is an
  // event the Renderer never receives — the Turn would then wait forever on an approval nobody
  // can see. Escaping can multiply length eightfold, so the produced value is measured here and
  // refused through the same tool error the provider already knows how to act on.
  const card = managedStdinEphemeralExecution(request);
  if (card.length > APPROVAL_EPHEMERAL_EXECUTION_MAX_CHARACTERS)
    throw new ManagedStdinRejection(
      'STDIN_TOO_LARGE',
      `write_stdin produced a ${card.length}-character approval card, over the ${APPROVAL_EPHEMERAL_EXECUTION_MAX_CHARACTERS}-character limit, because the input needs escaping to be shown safely. Split the input into smaller consecutive write_stdin calls — each one is approved on its own — and send the final call with close: true.`,
    );
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
  return `stdin → ${clipHeaderField(commandLine)} (session ${request.sessionId})`;
}

/**
 * The durable audit projection, which is what `requestApproval` writes to `display_json` and to
 * the persisted `approval.requested` event.
 *
 * It carries no stdin content at all — not even a redacted excerpt. Secret scanners recognise
 * labels and known token shapes; a bare password typed for `sudo -S` or `gpg --passphrase-fd 0`
 * looks like ordinary text and would have survived in plaintext, in the durable record and the
 * unprivileged Renderer's history, even after the user refused the write. The byte count and
 * digest still identify exactly which bytes were offered.
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
  const header = clipHeaderField(
    visibleStdinText([request.command.executable, ...request.command.argv].join(' ')),
  );
  const cwd = clipHeaderField(visibleStdinText(request.command.cwd));
  return [
    header,
    `session=${request.sessionId} cwd=${cwd} close=${request.close} bytes=${Buffer.byteLength(request.chars, 'utf8')} sha256=${createHash('sha256').update(request.chars, 'utf8').digest('hex')}`,
    '--- stdin ---',
    visibleStdinText(request.chars),
  ].join('\n');
}

/** Keeps an already-approved command's own length from deciding whether a stdin write is possible. */
function clipHeaderField(value: string): string {
  return value.length > HEADER_FIELD_CHARACTERS
    ? `${value.slice(0, HEADER_FIELD_CHARACTERS)}…`
    : value;
}

/**
 * Makes every character visible.
 *
 * Newline and tab stay themselves — the card renders the execution block with
 * `white-space: pre-wrap`, so they are shown rather than swallowed. Everything else that a display
 * can hide behind is written out by Unicode general category rather than by a hand-listed range,
 * so nothing is missed: controls (`Cc`, where a lone carriage return can overwrite the line before
 * it), every format character (`Cf` — the bidi overrides and isolates, U+061C, the deprecated
 * U+206A..U+206F, the zero-width marks and U+FEFF), the line and paragraph separators (`Zl`,
 * `Zp`), and the private-use and unassigned code points (`Co`, `Cn`) that render as whatever the
 * reader's font decides.
 */
export function visibleStdinText(value: string): string {
  return value.replace(HIDEABLE_CHARACTERS, (character) =>
    character === '\n' || character === '\t'
      ? character
      : `\\x{${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(2, '0')}}`,
  );
}

const HIDEABLE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/gu;

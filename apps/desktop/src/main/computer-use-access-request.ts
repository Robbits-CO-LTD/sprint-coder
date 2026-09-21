import { createHash } from 'node:crypto';
import {
  COMPUTER_ACCESS_REASON_MAX_CHARACTERS,
  type ComputerAppGrantDecision,
  type ComputerUseMode,
} from '@sprint-coder/contracts';
import { sanitizeUntrustedTargetLabel } from './computer-use-target-model';

/**
 * The rules behind `computer_request_access` (ADR v2 §6.1, §6.1.1, T8).
 *
 * A leaf like the other `computer-use-*` rule modules: it imports the label sanitiser and nothing
 * else from Main, so every decision here is a function of its arguments and can be tested without a
 * database, a native boundary, or a window. The controller owns the state; this module owns the
 * arithmetic and the comparisons that must not drift.
 */

/**
 * How long an unanswered card stays on screen (ADR v2 §5.2).
 *
 * The timeout is a fail-closed default, not a convenience: a card nobody answers must not leave a
 * tool call parked for the life of the Turn, and the model is told to ask again rather than being
 * left to guess. Two minutes is long enough for a person to read the verified facts and short
 * enough that an unattended machine does not accumulate cards.
 */
export const COMPUTER_ACCESS_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Per-Turn and per-Task ceilings on cards raised (T8).
 *
 * The threat is attention, not authority: every card still needs a human click, but a model that
 * can raise them in a loop turns "read the verified facts" into "click to make it stop". Only a
 * request that actually raised a card counts — a short-circuit on an already-granted application
 * costs the user nothing, and charging for it would make the limits depend on the grant table.
 */
export const COMPUTER_ACCESS_REQUEST_TURN_LIMIT = 2;
export const COMPUTER_ACCESS_REQUEST_TASK_LIMIT = 5;

/**
 * Domain separator and format version for the card's intent digest.
 *
 * Bumping it invalidates every card in flight, which is the correct outcome: a changed derivation
 * means a digest computed by the old code no longer means what the new code thinks it means, and a
 * card that cannot be re-derived must be refused rather than matched by accident.
 */
const COMPUTER_APP_GRANT_INTENT_VERSION = 1;

export type ComputerAppGrantIntentInput = Readonly<{
  appToken: string;
  grantIdentityDigest: string;
  denyRulesetVersion: number;
  policyEpoch: number;
  taskId: string;
}>;

/**
 * `H(appToken, grant_identity_digest, denyRulesetVersion, policyEpoch, taskId)` (ADR v2 §6.1.1).
 *
 * Length-prefixed and NUL-separated for the same reason the grant identity digest is: without it,
 * moving a character from the Task id into the app token would produce the same hash, and the whole
 * point of binding the click is that these five facts are the ones that must not have moved.
 */
export function computerAppGrantIntentDigest(input: ComputerAppGrantIntentInput): string {
  const hash = createHash('sha256');
  hash.update(`computer-app-grant-intent/v${COMPUTER_APP_GRANT_INTENT_VERSION}`);
  for (const field of [
    input.appToken,
    input.grantIdentityDigest,
    `${input.denyRulesetVersion}`,
    `${input.policyEpoch}`,
    input.taskId,
  ]) {
    hash.update('\u0000');
    hash.update(`text:${field.length}:${field}`);
  }
  return hash.digest('hex');
}

/**
 * Everything about the application that the card asserted, and that the click must still find true.
 *
 * §6.1.1 names these individually rather than letting the digest stand in for them: the digest
 * covers the grant identity, but `denied` and `maximumMode` are verdicts about that identity which
 * a ruleset update or a native re-attestation can move without the identity itself changing.
 */
export type ComputerAppGrantCardFacts = Readonly<{
  platform: 'darwin' | 'win32';
  identityKind: 'verified-signed' | 'unverified';
  publisher: string | null;
  appId: string;
  grantIdentityDigest: string;
  denied: boolean;
  maximumMode: ComputerUseMode;
}>;

/**
 * Whole-facts equality over an explicit field list.
 *
 * Written out rather than deep-compared so that adding a fact to the card is a type error here
 * instead of a field nobody re-checks on the click. That is the failure §6.1.1 exists to prevent:
 * the user reads one application's facts and the grant is written for another's.
 */
export function computerAppGrantCardFactsMatch(
  shown: ComputerAppGrantCardFacts,
  observed: ComputerAppGrantCardFacts,
): boolean {
  return (
    shown.platform === observed.platform &&
    shown.identityKind === observed.identityKind &&
    shown.publisher === observed.publisher &&
    shown.appId === observed.appId &&
    shown.grantIdentityDigest === observed.grantIdentityDigest &&
    shown.denied === observed.denied &&
    shown.maximumMode === observed.maximumMode
  );
}

/**
 * The model's stated reason, made safe to render beside verified facts.
 *
 * The same sanitiser the agent-facing labels go through, at the longer budget the card allows, so
 * the two cannot disagree about which invisible characters survive. Null when nothing is left: an
 * empty quotation is more honest than the sanitiser's "unnamed" placeholder, which would read as
 * though the model had written that word.
 */
export function sanitizeComputerAccessReason(reason: string): string | null {
  const sanitized = sanitizeUntrustedTargetLabel(reason, COMPUTER_ACCESS_REASON_MAX_CHARACTERS);
  return sanitized === 'unnamed' && reason.trim() !== 'unnamed' ? null : sanitized;
}

/** Which buttons a card offers, given what is already agreed (ADR v2 §6.1, §6.4). */
export function computerAppGrantAllowedDecisions(
  kind: 'app-grant' | 'provider-egress',
): readonly ComputerAppGrantDecision[] {
  // The application card offers both approvals at equal weight (D14) plus a refusal. The egress
  // card is the smaller one: the application is already granted and only the destination is in
  // question, so there is one approval — recorded against the grant that already exists — and a
  // refusal.
  return kind === 'app-grant'
    ? (['allow_once', 'allow_always', 'deny'] as const)
    : (['allow_always', 'deny'] as const);
}

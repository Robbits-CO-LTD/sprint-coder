import { createHmac, randomBytes } from 'node:crypto';
import {
  computerUseActionKindSchema,
  type ComputerUseAction,
  type ComputerUseActionKind,
} from '@sprint-coder/contracts';

export function computerUseActionKind(action: ComputerUseAction): ComputerUseActionKind {
  return computerUseActionKindSchema.parse(action.type);
}

export function computerUseActionRoute(action: ComputerUseAction): 'semantic' | 'visual' | 'none' {
  if (action.type === 'wait' || action.type === 'finish') return 'none';
  if (
    action.type === 'copy' ||
    action.type === 'invoke' ||
    action.type === 'set_text' ||
    action.type === 'select' ||
    action.type === 'toggle' ||
    action.type === 'expand_collapse'
  )
    return 'semantic';
  return 'visual';
}

/**
 * The key every action digest in this process is keyed with (#786). Random per process, held only
 * in memory, never written, logged or sent anywhere.
 *
 * An action digest is read in two kinds of place. Inside the process it binds: a plan grant, an
 * approval, the native ticket and request-id reuse all compare digests, so it must change with
 * every character of the text (a byte length alone would let a same-length string pass for the
 * approved one). Outside the process it is only a record: the SQLite audit row, kept across
 * restarts, and the runtime capture that becomes final-gate evidence. Nothing compares those with
 * a digest computed in a later process. An unkeyed hash served both, and handed anyone who could
 * read the record a six-digit code the planner typed after at most 10^6 guesses. Keyed with a
 * secret that dies with the process, the digest still binds inside it and no longer answers a
 * guess afterwards.
 */
const ACTION_DIGEST_KEY = randomBytes(32);

/**
 * A digest of something the planner wrote, keyed with the process key above. `domain` separates
 * the uses, so a digest from one place can never be passed off as one from another.
 */
export function computerUseKeyedDigest(
  domain: 'action' | 'provider-response',
  value: string,
): string {
  return createHmac('sha256', ACTION_DIGEST_KEY)
    .update(domain)
    .update('\u0000')
    .update(value)
    .digest('hex');
}

export function computerUseActionDigest(action: ComputerUseAction): string {
  return computerUseKeyedDigest('action', stableStringify(action));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
    .join(',')}}`;
}

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AcpClient, acpRecord } from './acp-client';
import type { GrokProtocolFailureCode } from './protocol';

/**
 * A Grok ACP failure with a fixed diagnostic code (issue #506). The message is fixed text too:
 * parser, handler and provider text never reaches a diagnostic.
 */
export class GrokProtocolFailure extends Error {
  constructor(
    readonly failureCode: GrokProtocolFailureCode,
    message = 'Invalid Grok ACP stream',
  ) {
    super(message);
  }
}

export function grokRecord(value: unknown): Record<string, unknown> {
  try {
    return acpRecord(value);
  } catch {
    throw new Error('Invalid Grok protocol object');
  }
}

export type GrokRpcCategory = 'authentication' | 'rate_limit' | 'billing' | 'other';

export class GrokRpcError extends Error {
  readonly category: GrokRpcCategory;
  readonly httpStatus?: number;

  constructor(
    readonly code: number,
    category: GrokRpcCategory = code === -32000 ? 'authentication' : 'other',
    httpStatus?: number,
  ) {
    // Provider error text can contain prompts, paths and credentials.
    super('Grok ACP request failed');
    this.category = category;
    const observed = observedHttpStatus(httpStatus);
    if (observed !== undefined) this.httpStatus = observed;
  }
}

export class GrokAcpClient extends AcpClient {
  constructor(
    child: ChildProcessWithoutNullStreams,
    notify: (method: string, params: unknown) => void,
    failed: (error: Error) => void,
  ) {
    super(child, notify, failed, {
      failure: (code, message) => new GrokProtocolFailure(code, message.replace('ACP', 'Grok')),
      isProtocolFailure: (error): error is GrokProtocolFailure =>
        error instanceof GrokProtocolFailure,
      response: (code, message, data) => {
        const classified = classifyGrokRpcFailure(code, message, data);
        return new GrokRpcError(code, classified.category, classified.httpStatus);
      },
    });
  }
}

const CLASSIFY_TEXT_BYTES = 4 * 1024;
const GROK_RATE_LIMIT_TEXT = /rate.limit|usage.limit|quota|too many requests|\b429\b/iu;
const GROK_AUTH_TEXT = /unauthenticated|authentication|not logged in|token expired|\b401\b/iu;
const GROK_BILLING_TEXT = /payment required|\bbalance\b|\bbilling\b|quota exhausted/iu;

function classifyGrokRpcFailure(
  code: number,
  message: unknown,
  data: unknown,
): { readonly category: GrokRpcCategory; readonly httpStatus?: number } {
  const record = plainGrokErrorData(data);
  const httpStatus = record === undefined ? undefined : observedHttpStatus(record['http_status']);
  const fromStatus =
    httpStatus === 402
      ? 'billing'
      : httpStatus === 429
        ? 'rate_limit'
        : httpStatus === 401
          ? 'authentication'
          : undefined;
  const category =
    fromStatus ?? categoryFromGrokText(code, message, record, httpStatus !== undefined);
  if (httpStatus === undefined) return { category };
  return { category, httpStatus };
}

function plainGrokErrorData(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function observedHttpStatus(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599)
    return undefined;
  return value;
}

function categoryFromGrokText(
  code: number,
  message: unknown,
  record: Record<string, unknown> | undefined,
  statusObserved: boolean,
): GrokRpcCategory {
  const samples = [message, record?.['message']]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => classifyTextPrefix(value));
  // Billing is final (retryable false), so provider text may decide it only when no HTTP status was
  // observed. An observed 500/503 whose body quotes a 402 is a transient failure, not billing.
  if (
    !statusObserved &&
    samples.some((sample) => /\b402\b/u.test(sample) && GROK_BILLING_TEXT.test(sample))
  )
    return 'billing';
  if (samples.some((sample) => GROK_RATE_LIMIT_TEXT.test(sample))) return 'rate_limit';
  if (code === -32000 || samples.some((sample) => GROK_AUTH_TEXT.test(sample)))
    return 'authentication';
  return 'other';
}

function classifyTextPrefix(text: string): string {
  if (Buffer.byteLength(text) <= CLASSIFY_TEXT_BYTES) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > CLASSIFY_TEXT_BYTES) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

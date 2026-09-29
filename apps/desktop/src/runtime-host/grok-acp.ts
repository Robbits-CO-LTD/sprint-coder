import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
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
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid Grok protocol object');
  return value as Record<string, unknown>;
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

/** Bounded JSONL transport. Reverse requests never acquire host execution authority. */
export class GrokAcpClient {
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      onResult: ((result: unknown, frame: number) => void) | undefined;
    }
  >();
  private buffered = '';
  private readonly decoder = new StringDecoder('utf8');
  private bytes = 0;
  private frames = 0;
  private ended = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly notify: (method: string, params: unknown) => void,
    private readonly failed: (error: Error) => void,
  ) {
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.ended) return;
      try {
        this.bytes += chunk.length;
        if (this.bytes > 64 * 1024 * 1024)
          throw new GrokProtocolFailure('output_quota_exceeded', 'Grok output quota exceeded');
        this.buffered += this.decoder.write(chunk);
        let index: number;
        while ((index = this.buffered.indexOf('\n')) >= 0) {
          const line = this.buffered.slice(0, index);
          this.buffered = this.buffered.slice(index + 1);
          if (Buffer.byteLength(line) > 1024 * 1024)
            throw new GrokProtocolFailure('frame_too_large', 'Grok frame too large');
          if (line.trim() === '') continue;
          this.frames += 1;
          let frame: unknown;
          try {
            frame = JSON.parse(line);
          } catch {
            throw new GrokProtocolFailure('json_parse_failed');
          }
          this.receive(frame);
        }
        if (Buffer.byteLength(this.buffered) > 1024 * 1024)
          throw new GrokProtocolFailure('frame_too_large', 'Grok frame too large');
      } catch (error) {
        // Only a fixed code leaves here; a validation error's own text is dropped.
        this.abort(
          error instanceof GrokProtocolFailure ? error : new GrokProtocolFailure('rpc_invalid'),
        );
      }
    });
    child.stdin.on('error', () =>
      this.abort(new GrokProtocolFailure('stdin_failed', 'Grok stdin failed')),
    );
    child.once('error', () =>
      this.abort(new GrokProtocolFailure('process_error', 'Grok process failed')),
    );
    child.once('close', () =>
      this.abort(new GrokProtocolFailure('process_exited', 'Grok process exited')),
    );
  }

  /** Non-blank frames delimited so far, including one that then failed to parse. */
  get receivedFrames(): number {
    return this.frames;
  }

  /** Whether bytes after the last newline are still waiting for their terminator. */
  get partialFrame(): boolean {
    return this.buffered.slice(this.buffered.lastIndexOf('\n') + 1) !== '';
  }

  /**
   * `onResult` sees a successful result with its frame sequence while that frame is parsed, before
   * later frames of the same chunk and before the returned promise settles.
   */
  request(
    method: string,
    params: unknown,
    timeoutMs = 30_000,
    onResult?: (result: unknown, frame: number) => void,
  ): Promise<unknown> {
    if (this.ended)
      return Promise.reject(
        new GrokProtocolFailure('transport_closed', 'Grok transport is closed'),
      );
    if (this.pending.size >= 128)
      return Promise.reject(new GrokProtocolFailure('too_many_requests', 'Too many Grok requests'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GrokProtocolFailure('request_timeout', 'Grok request timed out'));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, onResult });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notification(method: string, params: unknown): void {
    if (!this.ended) this.write({ jsonrpc: '2.0', method, params });
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new GrokProtocolFailure('transport_closed', 'Grok transport closed'));
    }
    this.pending.clear();
  }

  private abort(error: Error): void {
    if (this.ended) return;
    this.close();
    this.failed(error);
  }

  private write(value: unknown): void {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private receive(raw: unknown): void {
    const message = grokRecord(raw);
    if (message['jsonrpc'] !== '2.0') throw new Error('Invalid RPC version');
    const method = message['method'];
    if (typeof method === 'string') {
      if ('id' in message) {
        if (method === 'session/request_permission')
          this.write({
            jsonrpc: '2.0',
            id: message['id'],
            result: { outcome: { outcome: 'cancelled' } },
          });
        else
          this.write({
            jsonrpc: '2.0',
            id: message['id'],
            error: {
              code: -32601,
              message: 'Host operation unavailable; use Sprint Coder MCP tools.',
            },
          });
        return;
      }
      try {
        this.notify(method, message['params']);
      } catch (error) {
        // An adapter check keeps its own code; anything else the handler threw is only counted.
        throw error instanceof GrokProtocolFailure
          ? error
          : new GrokProtocolFailure('notification_handler_failed');
      }
      return;
    }
    const id = message['id'];
    // The CLI can interleave replies with its own string IDs during MCP turns. Our
    // requests use numeric IDs; never coerce an unrelated reply into a pending request.
    if (typeof id === 'string') {
      if ('result' in message === 'error' in message) throw new Error('Invalid Grok response');
      if ('error' in message) grokRecord(message['error']);
      return;
    }
    if (typeof id !== 'number') throw new Error('Invalid response identity');
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    // Validate before detaching the waiter: abort must still reject it on a malformed reply.
    const rpcError = 'error' in message ? grokRecord(message['error']) : null;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (rpcError !== null) {
      const code = typeof rpcError['code'] === 'number' ? rpcError['code'] : -32603;
      const classified = classifyGrokRpcFailure(code, rpcError['message'], rpcError['data']);
      pending.reject(new GrokRpcError(code, classified.category, classified.httpStatus));
    } else if ('result' in message) {
      try {
        pending.onResult?.(message['result'], this.frames);
      } catch {
        // Observation must never change how the reply settles.
      }
      pending.resolve(message['result']);
    } else pending.reject(new GrokProtocolFailure('rpc_invalid', 'Missing Grok result'));
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

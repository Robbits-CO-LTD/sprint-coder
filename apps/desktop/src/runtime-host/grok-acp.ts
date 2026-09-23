import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

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
    }
  >();
  private buffered = '';
  private readonly decoder = new StringDecoder('utf8');
  private bytes = 0;
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
        if (this.bytes > 64 * 1024 * 1024) throw new Error('Grok output quota exceeded');
        this.buffered += this.decoder.write(chunk);
        let index: number;
        while ((index = this.buffered.indexOf('\n')) >= 0) {
          const line = this.buffered.slice(0, index);
          this.buffered = this.buffered.slice(index + 1);
          if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('Grok frame too large');
          if (line.trim() !== '') this.receive(JSON.parse(line));
        }
        if (Buffer.byteLength(this.buffered) > 1024 * 1024) throw new Error('Grok frame too large');
      } catch {
        this.abort(new Error('Invalid Grok ACP stream'));
      }
    });
    child.stdin.on('error', () => this.abort(new Error('Grok stdin failed')));
    child.once('error', () => this.abort(new Error('Grok process failed')));
    child.once('close', () => this.abort(new Error('Grok process exited')));
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.ended) return Promise.reject(new Error('Grok transport is closed'));
    if (this.pending.size >= 128) return Promise.reject(new Error('Too many Grok requests'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Grok request timed out'));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
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
      request.reject(new Error('Grok transport closed'));
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
      this.notify(method, message['params']);
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
    } else if ('result' in message) pending.resolve(message['result']);
    else pending.reject(new Error('Missing Grok result'));
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

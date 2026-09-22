import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export function grokRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid Grok protocol object');
  return value as Record<string, unknown>;
}

export class GrokRpcError extends Error {
  constructor(
    readonly code: number,
    readonly category: 'authentication' | 'rate_limit' | 'other' = code === -32000
      ? 'authentication'
      : 'other',
  ) {
    // Provider error text can contain prompts, paths and credentials.
    super('Grok ACP request failed');
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
      const error = rpcError;
      const code = typeof error['code'] === 'number' ? error['code'] : -32603;
      const text = typeof error['message'] === 'string' ? error['message'] : '';
      const category = /rate.limit|usage.limit|quota|too many requests|\b429\b/iu.test(text)
        ? 'rate_limit'
        : code === -32000 ||
            /unauthenticated|authentication|not logged in|token expired|\b401\b/iu.test(text)
          ? 'authentication'
          : 'other';
      pending.reject(new GrokRpcError(code, category));
    } else if ('result' in message) pending.resolve(message['result']);
    else pending.reject(new Error('Missing Grok result'));
  }
}

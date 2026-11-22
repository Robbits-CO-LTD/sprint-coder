import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

type AcpFailureCode =
  | 'output_quota_exceeded'
  | 'frame_too_large'
  | 'json_parse_failed'
  | 'rpc_invalid'
  | 'stdin_failed'
  | 'process_error'
  | 'process_exited'
  | 'transport_closed'
  | 'too_many_requests'
  | 'request_timeout'
  | 'notification_handler_failed';

type AcpErrors = Readonly<{
  failure(code: AcpFailureCode, message: string): Error;
  isProtocolFailure(error: unknown): error is Error;
  response(code: number, message: unknown, data: unknown): Error;
}>;

export function acpRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid ACP protocol object');
  return value as Record<string, unknown>;
}

/** Bounded JSONL transport. Reverse requests never acquire host execution authority. */
export class AcpClient {
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
    private readonly errors: AcpErrors,
  ) {
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.ended) return;
      try {
        this.bytes += chunk.length;
        if (this.bytes > 64 * 1024 * 1024)
          throw this.errors.failure('output_quota_exceeded', 'ACP output quota exceeded');
        this.buffered += this.decoder.write(chunk);
        let index: number;
        while ((index = this.buffered.indexOf('\n')) >= 0) {
          const line = this.buffered.slice(0, index);
          this.buffered = this.buffered.slice(index + 1);
          if (Buffer.byteLength(line) > 1024 * 1024)
            throw this.errors.failure('frame_too_large', 'ACP frame too large');
          if (line.trim() === '') continue;
          this.frames += 1;
          let frame: unknown;
          try {
            frame = JSON.parse(line);
          } catch {
            throw this.errors.failure('json_parse_failed', 'Invalid ACP stream');
          }
          this.receive(frame);
        }
        if (Buffer.byteLength(this.buffered) > 1024 * 1024)
          throw this.errors.failure('frame_too_large', 'ACP frame too large');
      } catch (error) {
        // Only a fixed code leaves here; a validation error's own text is dropped.
        this.abort(
          this.errors.isProtocolFailure(error)
            ? error
            : this.errors.failure('rpc_invalid', 'Invalid ACP stream'),
        );
      }
    });
    child.stdin.on('error', () =>
      this.abort(this.errors.failure('stdin_failed', 'ACP stdin failed')),
    );
    child.once('error', () =>
      this.abort(this.errors.failure('process_error', 'ACP process failed')),
    );
    child.once('close', () =>
      this.abort(this.errors.failure('process_exited', 'ACP process exited')),
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
      return Promise.reject(this.errors.failure('transport_closed', 'ACP transport is closed'));
    if (this.pending.size >= 128)
      return Promise.reject(this.errors.failure('too_many_requests', 'Too many ACP requests'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(this.errors.failure('request_timeout', 'ACP request timed out'));
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
      request.reject(this.errors.failure('transport_closed', 'ACP transport closed'));
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
    const message = acpRecord(raw);
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
        throw this.errors.isProtocolFailure(error)
          ? error
          : this.errors.failure('notification_handler_failed', 'Invalid ACP stream');
      }
      return;
    }
    const id = message['id'];
    // The CLI can interleave replies with its own string IDs during MCP turns. Our
    // requests use numeric IDs; never coerce an unrelated reply into a pending request.
    if (typeof id === 'string') {
      if ('result' in message === 'error' in message) throw new Error('Invalid ACP response');
      if ('error' in message) acpRecord(message['error']);
      return;
    }
    if (typeof id !== 'number') throw new Error('Invalid response identity');
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    // Validate before detaching the waiter: abort must still reject it on a malformed reply.
    const rpcError = 'error' in message ? acpRecord(message['error']) : null;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (rpcError !== null) {
      const code = typeof rpcError['code'] === 'number' ? rpcError['code'] : -32603;
      pending.reject(this.errors.response(code, rpcError['message'], rpcError['data']));
    } else if ('result' in message) {
      try {
        pending.onResult?.(message['result'], this.frames);
      } catch {
        // Observation must never change how the reply settles.
      }
      pending.resolve(message['result']);
    } else pending.reject(this.errors.failure('rpc_invalid', 'Missing ACP result'));
  }
}

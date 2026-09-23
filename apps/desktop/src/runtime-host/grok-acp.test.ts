import { ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrokAcpClient, GrokRpcError, grokRecord } from './grok-acp';

const clients: GrokAcpClient[] = [];

function fixture() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  // An inert ChildProcess with in-memory pipes; no CLI, credentials or network are used.
  const child = Object.assign(new ChildProcess(), {
    stdin,
    stdout,
    stderr,
    stdio: [stdin, stdout, stderr, null, null],
  }) as ChildProcessWithoutNullStreams;
  const sent: Array<Record<string, unknown>> = [];
  stdin.on('data', (chunk: Buffer) => sent.push(JSON.parse(chunk.toString('utf8'))));
  const notify = vi.fn();
  const failed = vi.fn();
  const client = new GrokAcpClient(child, notify, failed);
  clients.push(client);
  const receive = (message: unknown) => stdout.write(JSON.stringify(message) + '\n');
  return { child, stdin, stdout, sent, notify, failed, client, receive };
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  vi.useRealTimers();
});

describe('Grok ACP transport', () => {
  it.each(['internal-reply', '1'])(
    'ignores an unmatched string response ID without settling numeric work: %s',
    async (id) => {
      const f = fixture();
      const settled = vi.fn();
      const request = f.client.request('session/prompt', {}).then(settled, settled);
      f.receive({ jsonrpc: '2.0', id, result: { ignored: true } });
      f.receive({ jsonrpc: '2.0', id, error: { code: -32603, message: 'PRIVATE_CANARY' } });
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      expect(f.failed).not.toHaveBeenCalled();
      f.receive({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's' } });
      expect(f.notify).toHaveBeenCalledOnce();
      f.receive({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } });
      await request;
      expect(settled).toHaveBeenCalledExactlyOnceWith({ stopReason: 'end_turn' });
    },
  );

  it.each([null, true, {}, []])('still rejects an invalid response ID: %j', async (id) => {
    const f = fixture();
    const request = f.client.request('session/prompt', {}).catch((error: unknown) => error);
    f.receive({ jsonrpc: '2.0', id, result: {} });
    expect(await request).toBeInstanceOf(Error);
    expect(f.failed).toHaveBeenCalledOnce();
  });

  it.each([{}, { result: {}, error: {} }, { error: null }])(
    'rejects a malformed string-ID response: %j',
    async (payload) => {
      const f = fixture();
      const request = f.client.request('session/prompt', {}).catch((error: unknown) => error);
      f.receive({ jsonrpc: '2.0', id: 'internal-reply', ...payload });
      expect(await request).toBeInstanceOf(Error);
      expect(f.failed).toHaveBeenCalledOnce();
    },
  );

  it('correlates out-of-order replies and decodes UTF-8 split inside a character', async () => {
    const f = fixture();
    const first = f.client.request('initialize', { protocolVersion: 1 });
    const second = f.client.request('session/new', {});
    expect(f.sent.map(({ id }) => id)).toEqual([1, 2]);
    f.receive({ jsonrpc: '2.0', id: 2, result: { sessionId: 'session-2' } });
    const frame = Buffer.from(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: '日本語 🚀' }) + '\n',
    );
    const split = frame.indexOf(Buffer.from('日')) + 1;
    f.stdout.write(frame.subarray(0, split));
    f.stdout.write(frame.subarray(split));
    await expect(first).resolves.toBe('日本語 🚀');
    await expect(second).resolves.toEqual({ sessionId: 'session-2' });
    expect(f.failed).not.toHaveBeenCalled();
  });

  it('handles multiple notifications and CRLF/blank frames without adding authority', () => {
    const f = fixture();
    f.stdout.write(
      '\r\n' +
        JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's' } }) +
        '\r\n' +
        JSON.stringify({ jsonrpc: '2.0', method: 'other', params: {} }) +
        '\n',
    );
    expect(f.notify.mock.calls).toEqual([
      ['session/update', { sessionId: 's' }],
      ['other', {}],
    ]);
    expect(f.sent).toEqual([]);
  });

  it.each(['fs/read_text_file', 'fs/write_text_file', 'terminal/create'])(
    'denies reverse %s requests',
    (method) => {
      const f = fixture();
      f.receive({ jsonrpc: '2.0', id: 'reverse-1', method, params: { path: '/fixture/private' } });
      expect(f.sent).toEqual([
        { jsonrpc: '2.0', id: 'reverse-1', error: { code: -32601, message: expect.any(String) } },
      ]);
      expect(f.notify).not.toHaveBeenCalled();
      expect(JSON.stringify(f.sent)).not.toContain('/fixture/private');
    },
  );

  it('cancels permission requests even when allow-always is offered', () => {
    const f = fixture();
    f.receive({
      jsonrpc: '2.0',
      id: 99,
      method: 'session/request_permission',
      params: { options: [{ optionId: 'allow', kind: 'allow_always' }] },
    });
    expect(f.sent).toEqual([
      { jsonrpc: '2.0', id: 99, result: { outcome: { outcome: 'cancelled' } } },
    ]);
    expect(f.notify).not.toHaveBeenCalled();
  });

  it('retains only the numeric RPC error code, never provider error text/data', async () => {
    const f = fixture();
    const request = f.client.request('authenticate', {});
    const error = request.catch((value: unknown) => value);
    f.receive({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32000, message: 'PRIVATE_REQUEST_CANARY', data: { token: 'AUTH_CANARY' } },
    });
    expect(await error).toBeInstanceOf(GrokRpcError);
    expect(await error).toMatchObject({ code: -32000, message: 'Grok ACP request failed' });
    expect(String(await error)).not.toMatch(/PRIVATE_REQUEST_CANARY|AUTH_CANARY/);
  });

  it.each(['not-json\n', '[]\n', '{"jsonrpc":"1.0","id":1,"result":null}\n'])(
    'rejects pending work on malformed stream %s',
    async (frame) => {
      const f = fixture();
      const request = f.client.request('initialize', {}).catch((error: unknown) => error);
      f.stdout.write(frame);
      expect(await request).toBeInstanceOf(Error);
      expect(f.failed).toHaveBeenCalledOnce();
      f.child.emit('close', 1);
      expect(f.failed).toHaveBeenCalledOnce();
      await expect(f.client.request('initialize', {})).rejects.toThrow('closed');
    },
  );

  it.each([false, true])(
    'bounds a frame before and after newline (terminated=%s)',
    async (terminated) => {
      const f = fixture();
      const request = f.client.request('initialize', {}).catch((error: unknown) => error);
      f.stdout.write('x'.repeat(1024 * 1024 + 1) + (terminated ? '\n' : ''));
      expect(await request).toBeInstanceOf(Error);
      expect(f.failed).toHaveBeenCalledOnce();
    },
  );

  it('bounds concurrent requests and frees timed-out slots without resolving a later request', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = Array.from({ length: 128 }, () =>
      f.client.request('fixture', {}, 10).catch((error: unknown) => error),
    );
    await expect(f.client.request('overflow', {})).rejects.toThrow('Too many');
    expect(f.sent).toHaveLength(128);
    await vi.advanceTimersByTimeAsync(10);
    expect((await Promise.all(pending)).every((error) => error instanceof Error)).toBe(true);
    const next = f.client.request('next', {});
    f.receive({ jsonrpc: '2.0', id: 1, result: 'stale' });
    f.receive({ jsonrpc: '2.0', id: 129, result: 'current' });
    await expect(next).resolves.toBe('current');
  });

  it.each(['stdin', 'process', 'close'])(
    'settles pending requests on %s failure',
    async (failure) => {
      const f = fixture();
      const request = f.client.request('initialize', {}).catch((error: unknown) => error);
      if (failure === 'stdin') f.stdin.emit('error', new Error('PRIVATE_CANARY'));
      else if (failure === 'process') f.child.emit('error', new Error('PRIVATE_CANARY'));
      else f.child.emit('close', 1);
      expect(await request).toBeInstanceOf(Error);
      expect(f.failed).toHaveBeenCalledOnce();
      expect(String(f.failed.mock.calls[0]?.[0])).not.toContain('PRIVATE_CANARY');
    },
  );

  it('closes idempotently and stops sending notifications', async () => {
    const f = fixture();
    const request = f.client.request('initialize', {}).catch((error: unknown) => error);
    f.client.close();
    f.client.close();
    f.client.notification('session/cancel', {});
    f.receive({ jsonrpc: '2.0', method: 'session/update', params: {} });
    expect(await request).toBeInstanceOf(Error);
    expect(f.sent).toHaveLength(1);
    expect(f.notify).not.toHaveBeenCalled();
    expect(f.failed).not.toHaveBeenCalled();
  });

  it('settles the matching promise when an RPC error object is malformed', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const settled = vi.fn();
    void f.client.request('initialize', {}, 10).then(settled, settled);
    f.receive({ jsonrpc: '2.0', id: 1, error: null });
    await vi.advanceTimersByTimeAsync(20);
    expect(f.failed).toHaveBeenCalledOnce();
    // Regression: removing the pending entry before validating error loses its reject callback.
    expect(settled).toHaveBeenCalledOnce();
    expect(settled.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});

describe('grokRecord', () => {
  it.each([null, undefined, [], 'text', 1])('rejects non-record values: %s', (value) => {
    expect(() => grokRecord(value)).toThrow('Invalid Grok protocol object');
  });
});

async function rejectedRpc(payload: unknown): Promise<GrokRpcError> {
  const f = fixture();
  const settled = f.client.request('session/prompt', {}).then(
    () => {
      throw new Error('expected RPC rejection');
    },
    (value: unknown) => value,
  );
  f.receive({ jsonrpc: '2.0', id: 1, error: payload });
  const error = await settled;
  expect(error).toBeInstanceOf(GrokRpcError);
  expect(f.failed).not.toHaveBeenCalled();
  return error as GrokRpcError;
}

function exposedErrorText(error: object): string {
  const names = Object.getOwnPropertyNames(error).map(
    (key) => `${key}=${String(Reflect.get(error, key))}`,
  );
  const symbols = Object.getOwnPropertySymbols(error).map(
    (key) => `${String(key)}=${String(Reflect.get(error, key))}`,
  );
  return [...names, ...symbols, JSON.stringify(error)].join('\n');
}

describe('Grok RPC failure classification', () => {
  const nestedBilling = {
    code: -32603,
    message: 'Internal error',
    data: {
      message: 'API error (status 402 Payment Required): Grok Build usage balance exhausted',
      http_status: 402,
    },
  };

  it('classifies a nested 402 payment failure and keeps the observed status', async () => {
    const error = await rejectedRpc(nestedBilling);
    expect(error).toMatchObject({
      code: -32603,
      category: 'billing',
      httpStatus: 402,
      message: 'Grok ACP request failed',
    });
  });

  it('classifies http_status 402 without billing words', async () => {
    const error = await rejectedRpc({
      code: -32603,
      message: 'Internal error',
      data: { http_status: 402 },
    });
    expect(error.category).toBe('billing');
    expect(error.httpStatus).toBe(402);
  });

  it.each([
    ['402 Payment Required', 'billing'],
    ['status 402', 'other'],
    ['Payment Required', 'other'],
    ['402 quota exhausted', 'billing'],
    ['quota exhausted', 'rate_limit'],
  ] as const)('classifies plain text %j as %s', async (message, category) => {
    const error = await rejectedRpc({ code: -32603, message });
    expect(error.category).toBe(category);
    expect(error.httpStatus).toBeUndefined();
  });

  it('classifies a nested 429 and a 429 mentioned only in data.message', async () => {
    const nested = await rejectedRpc({
      code: -32603,
      message: 'Internal error',
      data: { message: 'rate limit', http_status: 429 },
    });
    expect(nested.category).toBe('rate_limit');
    expect(nested.httpStatus).toBe(429);
    const textOnly = await rejectedRpc({
      code: -32603,
      message: 'Internal error',
      data: { message: '429 too many requests' },
    });
    expect(textOnly.category).toBe('rate_limit');
    expect(textOnly.httpStatus).toBeUndefined();
  });

  it('classifies a nested 401 as authentication', async () => {
    const error = await rejectedRpc({
      code: -32603,
      message: 'Internal error',
      data: { http_status: 401 },
    });
    expect(error.category).toBe('authentication');
    expect(error.httpStatus).toBe(401);
  });

  it.each(['402', 402.5, 99, 600, null])('ignores an unusable http_status %j', async (status) => {
    const error = await rejectedRpc({
      code: -32603,
      message: 'Internal error',
      data: { http_status: status },
    });
    expect(error.category).toBe('other');
    expect(error.httpStatus).toBeUndefined();
  });

  it.each([[{ http_status: 402, message: '402 Payment Required' }], '402 Payment Required', null])(
    'ignores http status when data is not an object: %j',
    async (data) => {
      const error = await rejectedRpc({ code: -32603, message: 'Internal error', data });
      expect(error.category).toBe('other');
      expect(error.httpStatus).toBeUndefined();
    },
  );

  it('keeps authentication when code -32000 carries a non-decisive status', async () => {
    const error = await rejectedRpc({
      code: -32000,
      message: 'Internal error',
      data: { http_status: 500, message: 'upstream failed' },
    });
    expect(error.category).toBe('authentication');
    expect(error.httpStatus).toBe(500);
  });

  it('lets an observed 402 outrank an authentication code', async () => {
    const error = await rejectedRpc({
      code: -32000,
      message: 'Internal error',
      data: { http_status: 402 },
    });
    expect(error.category).toBe('billing');
    expect(error.httpStatus).toBe(402);
  });

  it('does not let provider text turn an observed non-billing status into billing', async () => {
    const error = await rejectedRpc({
      code: -32603,
      message: '402 Payment Required',
      data: { http_status: 500 },
    });
    expect(error.category).toBe('other');
    expect(error.httpStatus).toBe(500);
    const limited = await rejectedRpc({
      code: -32603,
      message: '429 Too Many Requests',
      data: { http_status: 503 },
    });
    expect(limited.category).toBe('rate_limit');
    expect(limited.httpStatus).toBe(503);
  });

  it('classifies only the first 4KiB of provider text', async () => {
    const pastLimit = `${'あ'.repeat(1365)}あ402 Payment Required`;
    const hidden = await rejectedRpc({ code: -32603, message: pastLimit });
    expect(hidden.category).toBe('other');
    expect(hidden.httpStatus).toBeUndefined();
    const visible = await rejectedRpc({
      code: -32603,
      message: `402 Payment Required${'あ'.repeat(2000)}`,
    });
    expect(visible.category).toBe('billing');
    expect(visible.httpStatus).toBeUndefined();
  });

  it('does not copy provider billing text onto the RPC error', async () => {
    const canary = 'CANARY_BILLING_TEXT';
    const error = await rejectedRpc({
      code: -32603,
      message: `402 Payment Required ${canary}`,
      data: {
        message: `balance exhausted ${canary}`,
        http_status: 402,
        detail: canary,
      },
    });
    expect(error.category).toBe('billing');
    expect(error.httpStatus).toBe(402);
    expect(exposedErrorText(error)).not.toContain(canary);
  });
});

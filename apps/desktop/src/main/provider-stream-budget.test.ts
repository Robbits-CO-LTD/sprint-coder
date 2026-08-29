import { describe, expect, it, vi } from 'vitest';
import { normalizeOpenAIChatCompletionsStream } from './openai-chat-completions-stream';
import {
  PROVIDER_STREAM_LIMITS,
  ProviderQuotaExceededError,
  ProviderStreamBudget,
  readBoundedServerSentJson,
} from './provider-stream-budget';

describe('ProviderStreamBudget', () => {
  it.each([
    ['empty stream', ''],
    [
      'EOF before a terminal frame',
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    ],
    ['error-only stream', 'data: {"error":{"type":"server_error"}}\n\n'],
  ])('does not complete a Chat Completions %s', async (_name, wire) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (wire !== '') controller.enqueue(new TextEncoder().encode(wire));
        controller.close();
      },
    });
    const events = [];

    for await (const event of normalizeOpenAIChatCompletionsStream(body, 'test', 'model'))
      events.push(event);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({ category: 'provider_unavailable', retryable: true }),
      }),
    );
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'completed' }));
  });

  it.each([
    [
      'DONE marker',
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      'completed',
    ],
    [
      'finish reason',
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
      'stop',
    ],
  ])('completes a Chat Completions stream with an explicit %s', async (_name, wire, stopReason) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(wire));
        controller.close();
      },
    });
    const events = [];

    for await (const event of normalizeOpenAIChatCompletionsStream(body, 'test', 'model'))
      events.push(event);

    expect(events.at(-1)).toEqual({ type: 'completed', stopReason });
  });

  it('fails closed and cancels an oversized unfinished SSE frame', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${'x'.repeat(PROVIDER_STREAM_LIMITS.eventBytes)}`),
        );
      },
      cancel,
    });

    await expect(async () => {
      for await (const _event of readBoundedServerSentJson(stream, new ProviderStreamBudget())) {
        // no complete event
      }
    }).rejects.toMatchObject({ quota: 'event_bytes', retryable: false });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('counts UTF-8 output bytes cumulatively across small deltas', () => {
    const budget = new ProviderStreamBudget();
    const chunk = 'あ'.repeat(1024);
    const count = Math.floor(
      PROVIDER_STREAM_LIMITS.normalizedOutputBytes / Buffer.byteLength(chunk),
    );
    for (let index = 0; index < count; index += 1) budget.consumeOutput(chunk);
    expect(() => budget.consumeOutput('あ'.repeat(1024))).toThrowError(ProviderQuotaExceededError);
  });

  it('rejects split tool arguments after their cumulative byte quota', async () => {
    const fragment = 'x'.repeat(512 * 1024);
    const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 9; index += 1)
          controller.enqueue(
            new TextEncoder().encode(
              frame({
                choices: [
                  { delta: { tool_calls: [{ index: 0, function: { arguments: fragment } }] } },
                ],
              }),
            ),
          );
        controller.close();
      },
    });

    await expect(async () => {
      for await (const _event of normalizeOpenAIChatCompletionsStream(body, 'test', 'model')) {
        // drain
      }
    }).rejects.toMatchObject({ quota: 'tool_argument_bytes' });
  });

  it('enforces event, tool-call, and elapsed-time limits', () => {
    const events = new ProviderStreamBudget();
    for (let index = 0; index < PROVIDER_STREAM_LIMITS.events; index += 1) events.consumeEvent(1);
    expect(() => events.consumeEvent(1)).toThrowError(ProviderQuotaExceededError);

    const tools = new ProviderStreamBudget();
    for (let index = 0; index < PROVIDER_STREAM_LIMITS.toolCalls; index += 1)
      tools.consumeToolCall();
    expect(() => tools.consumeToolCall()).toThrowError(ProviderQuotaExceededError);

    expect(() =>
      new ProviderStreamBudget(Date.now() - PROVIDER_STREAM_LIMITS.callDurationMs - 1).assertTime(),
    ).toThrowError(ProviderQuotaExceededError);
  });

  it('does not reset the Turn aggregate when a new provider call begins', () => {
    const budget = new ProviderStreamBudget();
    const halfTurn = 'a'.repeat(PROVIDER_STREAM_LIMITS.persistedTurnBytes / 2);
    budget.consumeOutput(halfTurn);
    budget.beginCall();
    budget.consumeToolResult(halfTurn);
    budget.beginCall();
    expect(() => budget.consumeOutput('a')).toThrowError(ProviderQuotaExceededError);
  });
});

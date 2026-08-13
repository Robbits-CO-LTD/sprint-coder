import { describe, expect, it, vi } from 'vitest';
import { normalizeOpenAIChatCompletionsStream } from './openai-chat-completions-stream';
import {
  PROVIDER_STREAM_LIMITS,
  ProviderQuotaExceededError,
  ProviderStreamBudget,
  readBoundedServerSentJson,
} from './provider-stream-budget';

describe('ProviderStreamBudget', () => {
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
});

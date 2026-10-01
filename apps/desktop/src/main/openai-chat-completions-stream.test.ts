import { describe, expect, it } from 'vitest';
import { normalizeOpenAIChatCompletionsStream } from './openai-chat-completions-stream';

async function events(delta: object, finishReason = 'stop') {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const choice of [
        { delta, finish_reason: null },
        { delta: {}, finish_reason: finishReason },
      ])
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify({ choices: [choice] })}\n\n`),
        );
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  const result = [];
  for await (const event of normalizeOpenAIChatCompletionsStream(body, 'ollama', 'test-model'))
    result.push(event);
  return result;
}

describe('Chat Completions terminal responses', () => {
  it.each(['text', 'tool'])(
    'finishes an open transport after DONE (%s)',
    async (kind) => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const delta =
            kind === 'text'
              ? { content: 'Done' }
              : {
                  tool_calls: [
                    { index: 0, id: 'call-1', function: { name: 'read_file', arguments: '{}' } },
                  ],
                };
          for (const value of [
            { choices: [{ delta, finish_reason: null }] },
            { choices: [{ delta: {}, finish_reason: kind === 'text' ? 'stop' : 'tool_calls' }] },
            { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
          ])
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        },
        cancel() {
          cancelled = true;
        },
      });
      const result = [];
      for await (const event of normalizeOpenAIChatCompletionsStream(body, 'ollama', 'test-model'))
        result.push(event);
      expect(result.filter((event) => event.type === 'completed')).toHaveLength(1);
      expect(result).toContainEqual(
        expect.objectContaining({
          type: 'usage',
          usage: expect.objectContaining({ inputTokens: 3, outputTokens: 2 }),
        }),
      );
      expect(cancelled).toBe(true);
      expect(body.locked).toBe(false);
    },
    500,
  );
  it.each([{}, { content: ' \n' }, { reasoning_content: 'Thinking only' }])(
    'does not report success for an empty final response',
    async (delta) => {
      const result = await events(delta);
      expect(result).toContainEqual({
        type: 'error',
        error: expect.objectContaining({ providerCode: 'empty_response' }),
      });
      expect(result.some((event) => event.type === 'completed')).toBe(false);
    },
  );

  it('accepts a tool-only round so the host can execute the call', async () => {
    const result = await events(
      {
        tool_calls: [
          {
            index: 0,
            id: 'call-1',
            function: { name: 'read_file', arguments: '{"path":"fixture.txt"}' },
          },
        ],
      },
      'tool_calls',
    );
    expect(result).toContainEqual(
      expect.objectContaining({ type: 'tool_call', name: 'read_file' }),
    );
    expect(result.at(-1)).toEqual({ type: 'completed', stopReason: 'tool_calls' });
  });

  it('preserves an output-limit failure even when the provider returned no visible text', async () => {
    expect((await events({}, 'length')).at(-1)).toMatchObject({
      type: 'error',
      error: { providerCode: 'output_token_limit' },
    });
  });

  it('accepts a non-empty final response', async () => {
    expect((await events({ content: 'Done' })).at(-1)).toEqual({
      type: 'completed',
      stopReason: 'stop',
    });
  });
});

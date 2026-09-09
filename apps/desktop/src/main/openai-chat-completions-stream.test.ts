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

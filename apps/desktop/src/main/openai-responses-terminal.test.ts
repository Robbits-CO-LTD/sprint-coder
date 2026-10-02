import type { CanonicalProviderEvent } from '@sprint-coder/contracts';
import { expect, it } from 'vitest';
import { normalizeOpenAIResponsesStream } from './openai-responses-stream';

it.each(['response.failed', 'error', 'response.incomplete'])(
  'releases an open transport after %s without claiming completion',
  async (type) => {
    let cancelled = false;
    let transport: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        transport = controller;
        controller.enqueue(
          new TextEncoder().encode(
            [
              { type, response: { status: 'incomplete' } },
              { type: 'response.completed', response: { status: 'completed' } },
            ]
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(''),
          ),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    const iterator = normalizeOpenAIResponsesStream(body, 'openai', 'fixture')[
      Symbol.asyncIterator
    ]();
    const events: CanonicalProviderEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          for (;;) {
            const result = await iterator.next();
            if (result.done) return;
            events.push(result.value);
          }
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('terminal drain still waiting')), 100);
        }),
      ]);
      expect(events.map((event) => event.type)).toEqual(['error']);
      expect(cancelled).toBe(true);
      expect(body.locked).toBe(false);
    } finally {
      clearTimeout(timer);
      if (body.locked) {
        // Release the deliberately open fixture even when the pre-fix iterator is blocked.
        transport?.close();
        await iterator.return?.();
      }
    }
  },
);

import { describe, expect, it, vi } from 'vitest';
import {
  MANAGED_LOCAL_CONNECTION_ID,
  MANAGED_LOCAL_PROVIDER_ID,
  ManagedLocalProviderRuntime,
  managedLocalForcedToolEvents,
  managedLocalForcedToolMessages,
  managedLocalConnection,
} from './managed-local-provider-runtime';
import type { ManagedLocalController } from './managed-local-controller';
import { secureLogger } from './secure-logger';

function stream(): ReadableStream<Uint8Array> {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'local reply' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
}

describe('ManagedLocalProviderRuntime', () => {
  it('publishes a stable image capability snapshot from the installed Managed Local bundle', async () => {
    const modelId = 'b'.repeat(64);
    const controller = {
      imageInputCapability: vi.fn(() => true),
    } as unknown as ManagedLocalController;
    const runtime = new ManagedLocalProviderRuntime(controller, () => 1_234);
    const connection = managedLocalConnection();

    const first = await runtime.captureImageInputCapability!(
      connection,
      modelId,
      new AbortController().signal,
    );
    const second = await runtime.captureImageInputCapability!(
      connection,
      modelId,
      new AbortController().signal,
    );

    expect(first).toEqual({
      value: true,
      revision: expect.stringMatching(/^[a-f0-9]{64}$/u),
      capturedAtMs: 1_234,
    });
    expect(second.revision).toBe(first.revision);
    expect(controller.imageInputCapability).toHaveBeenNthCalledWith(1, modelId);
    expect(controller.imageInputCapability).toHaveBeenNthCalledWith(2, modelId);
  });

  it.each([
    [false, 'known text-only bundle'],
    [null, 'unavailable bundle identity'],
  ] as const)('publishes %s for a %s', async (value, _description) => {
    const modelId = 'c'.repeat(64);
    const runtime = new ManagedLocalProviderRuntime(
      { imageInputCapability: vi.fn(() => value) } as unknown as ManagedLocalController,
      () => 2_345,
    );

    await expect(
      runtime.captureImageInputCapability!(
        managedLocalConnection(),
        modelId,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ value, capturedAtMs: 2_345 });
  });

  it('does not capture image capability after cancellation', async () => {
    const controller = {
      imageInputCapability: vi.fn(() => true),
    } as unknown as ManagedLocalController;
    const runtime = new ManagedLocalProviderRuntime(controller);
    const aborted = new AbortController();
    aborted.abort(new Error('canceled'));

    await expect(
      runtime.captureImageInputCapability!(
        managedLocalConnection(),
        'd'.repeat(64),
        aborted.signal,
      ),
    ).rejects.toThrow('canceled');
    expect(controller.imageInputCapability).not.toHaveBeenCalled();
  });

  it('uses non-stream deterministic sampling for a named forced tool subrequest', async () => {
    const authenticatedFetch = vi.fn(async (_path: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(payload).toMatchObject({
        stream: false,
        max_tokens: 1024,
        tool_choice: { type: 'function', function: { name: 'create_file' } },
        messages: [
          {
            role: 'system',
            content:
              "Call exactly create_file now. Extract only that tool's arguments from the latest user request. Do not answer with text and do not perform later steps yet.\n\nguidance",
          },
          { role: 'user', content: 'create proof.txt' },
        ],
        tools: [{ type: 'function', function: { name: 'create_file' } }],
      });
      expect(payload).not.toHaveProperty('stream_options');
      expect(payload).toMatchObject({
        reasoning_effort: 'none',
        chat_template_kwargs: { enable_thinking: false },
      });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'call-create',
                    type: 'function',
                    function: { name: 'create_file', arguments: '{"path":"proof.txt"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
        { status: 200 },
      );
    });
    const controller = {
      getInferenceSettings: vi.fn(async () => ({
        modelId: 'b'.repeat(64),
        configured: { maxOutputTokens: 4_096, thinking: true },
        effective: { maxOutputTokens: 4_096, thinking: true, reasoningEffort: null },
        toolCall: { maxOutputTokens: 1_024, thinking: false, reasoningEffort: 'none' },
      })),
      acquireRuntime: vi.fn(async () => ({
        modelId: 'b'.repeat(64),
        session: { authenticatedFetch },
        prepare: vi.fn(async () => undefined),
        release: vi.fn(async () => undefined),
      })),
    } as unknown as ManagedLocalController;
    const runtime = new ManagedLocalProviderRuntime(controller);
    const connection = managedLocalConnection();
    const lease = await runtime.acquireModelLease!(
      connection,
      'b'.repeat(64),
      new AbortController().signal,
    );
    const events = [];
    for await (const event of runtime.execute(
      connection,
      {
        executionId: 'forced-execution',
        connectionId: connection.id,
        modelId: 'b'.repeat(64),
        messages: [
          { role: 'system', content: 'guidance' },
          { role: 'user', content: 'old request' },
          { role: 'assistant', content: 'old answer' },
          { role: 'user', content: 'create proof.txt' },
        ],
        tools: [
          { name: 'create_file', description: 'create', inputSchema: { type: 'object' } },
          { name: 'read_file', description: 'read', inputSchema: { type: 'object' } },
        ],
        toolChoice: { name: 'create_file' },
      },
      new AbortController().signal,
    ))
      events.push(event);
    expect(events).toEqual([
      {
        type: 'tool_call',
        callId: 'call-create',
        name: 'create_file',
        input: { path: 'proof.txt' },
      },
      { type: 'completed', stopReason: 'tool_calls' },
    ]);
    await lease.release();
  });

  it('normalizes one bounded non-stream named tool response', async () => {
    const response = new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'call-create',
                  type: 'function',
                  function: { name: 'create_file', arguments: '{"path":"proof.txt"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

    await expect(managedLocalForcedToolEvents(response, 'create_file')).resolves.toEqual([
      {
        type: 'tool_call',
        callId: 'call-create',
        name: 'create_file',
        input: { path: 'proof.txt' },
      },
      { type: 'completed', stopReason: 'tool_calls' },
    ]);
  });

  it('isolates forced tool generation from earlier assistant tool-result rounds', () => {
    expect(
      managedLocalForcedToolMessages(
        [
          { role: 'system', content: 'guidance' },
          { role: 'user', content: 'old request' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ callId: 'old-call', name: 'create_file', input: {} }],
          },
          { role: 'tool', content: '{"ok":true}', toolCallId: 'old-call' },
          { role: 'user', content: 'current explicit tool request' },
        ],
        'create_file',
      ),
    ).toEqual([
      {
        role: 'system',
        content:
          "Call exactly create_file now. Extract only that tool's arguments from the latest user request. Do not answer with text and do not perform later steps yet.\n\nguidance",
      },
      { role: 'user', content: 'current explicit tool request' },
    ]);
  });

  it('keeps loopback details inside Main and reuses the Provider stream contract', async () => {
    const release = vi.fn(async () => undefined);
    const authenticatedFetch = vi.fn(async (path: string, init?: RequestInit) => {
      expect(path).toBe('/v1/chat/completions');
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(payload).toMatchObject({
        model: 'a'.repeat(64),
        stream: true,
        max_tokens: 2_048,
        chat_template_kwargs: { enable_thinking: true },
      });
      expect(payload).not.toHaveProperty('reasoning_effort');
      return new Response(stream(), { status: 200 });
    });
    const controller = {
      listProviderModels: vi.fn(() => []),
      getInferenceSettings: vi.fn(async () => ({
        modelId: 'a'.repeat(64),
        configured: { maxOutputTokens: 2_048, thinking: true },
        effective: { maxOutputTokens: 2_048, thinking: true, reasoningEffort: null },
        toolCall: { maxOutputTokens: 1_024, thinking: false, reasoningEffort: 'none' },
      })),
      acquireRuntime: vi.fn(async () => ({
        modelId: 'a'.repeat(64),
        session: {
          baseUrl: 'http://127.0.0.1:49152/v1',
          snapshot: vi.fn(),
          diagnostics: vi.fn(() => ''),
          authenticatedFetch,
          stop: vi.fn(),
        },
        prepare: vi.fn(async () => undefined),
        release,
      })),
    } as unknown as ManagedLocalController;
    const runtime = new ManagedLocalProviderRuntime(controller);
    const connection = managedLocalConnection(new Date('2026-08-24T00:00:00.000Z'));
    const lease = await runtime.acquireModelLease!(
      connection,
      'a'.repeat(64),
      new AbortController().signal,
    );
    expect(connection.automaticModelRelease).toBe(true);
    expect(controller.acquireRuntime).toHaveBeenCalledWith(
      'a'.repeat(64),
      true,
      expect.any(AbortSignal),
    );

    const events = [];
    for await (const event of runtime.execute(
      connection,
      {
        executionId: 'execution-1',
        connectionId: MANAGED_LOCAL_CONNECTION_ID,
        modelId: 'a'.repeat(64),
        messages: [{ role: 'user', content: 'hello' }],
      },
      new AbortController().signal,
    ))
      events.push(event);

    expect(events).toContainEqual({ type: 'output_delta', text: 'local reply' });
    expect(events).toContainEqual({ type: 'completed', stopReason: 'stop' });
    expect(controller.getInferenceSettings).toHaveBeenCalledWith('a'.repeat(64));
    expect(JSON.stringify(events)).not.toContain('49152');
    expect(MANAGED_LOCAL_PROVIDER_ID).toBe('sprint-managed-local');
    await lease.release();
    expect(release).toHaveBeenCalledOnce();
  });

  it('never logs or emits a rejected response body that contains an image data URL', async () => {
    const leakedBody = 'data:image/png;base64,LEAK_SENTINEL';
    const logger = vi.spyOn(secureLogger, 'warn').mockImplementation(() => undefined);
    const authenticatedFetch = vi.fn(async () => new Response(leakedBody, { status: 422 }));
    const release = vi.fn(async () => undefined);
    const controller = {
      getInferenceSettings: vi.fn(async () => ({
        modelId: 'e'.repeat(64),
        configured: { maxOutputTokens: 2_048, thinking: false },
        effective: { maxOutputTokens: 2_048, thinking: false, reasoningEffort: null },
        toolCall: { maxOutputTokens: 1_024, thinking: false, reasoningEffort: 'none' },
      })),
      acquireRuntime: vi.fn(async () => ({
        modelId: 'e'.repeat(64),
        session: { authenticatedFetch },
        prepare: vi.fn(async () => undefined),
        release,
      })),
    } as unknown as ManagedLocalController;
    const runtime = new ManagedLocalProviderRuntime(controller);
    const connection = managedLocalConnection();
    const lease = await runtime.acquireModelLease!(
      connection,
      'e'.repeat(64),
      new AbortController().signal,
    );

    try {
      const events = [];
      for await (const event of runtime.execute(
        connection,
        {
          executionId: 'rejected-image-body',
          connectionId: MANAGED_LOCAL_CONNECTION_ID,
          modelId: 'e'.repeat(64),
          messages: [{ role: 'user', content: 'describe the image' }],
        },
        new AbortController().signal,
      ))
        events.push(event);

      expect(events).toContainEqual({
        type: 'error',
        error: {
          category: 'provider_unavailable',
          message: 'Managed Local runtime rejected the request',
          retryable: false,
          retryAfterMs: null,
          providerCode: 'http_422',
        },
      });
      const observableValues = JSON.stringify({ events, logger: logger.mock.calls });
      expect(observableValues).not.toContain(leakedBody);
      expect(observableValues).not.toContain('LEAK_SENTINEL');
      expect(observableValues).not.toContain('data:image/');
    } finally {
      await lease.release();
      logger.mockRestore();
    }
  });

  it('rejects any lookalike persisted Connection', async () => {
    const runtime = new ManagedLocalProviderRuntime({} as ManagedLocalController);
    await expect(
      runtime.listModels(
        { ...managedLocalConnection(), providerId: 'lookalike' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('Invalid Managed Local virtual Connection');
  });
});

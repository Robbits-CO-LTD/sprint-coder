import { describe, expect, it, vi } from 'vitest';
import {
  MANAGED_LOCAL_CONNECTION_ID,
  MANAGED_LOCAL_PROVIDER_ID,
  ManagedLocalProviderRuntime,
  managedLocalConnection,
} from './managed-local-provider-runtime';
import type { ManagedLocalController } from './managed-local-controller';

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
  it('keeps loopback details inside Main and reuses the Provider stream contract', async () => {
    const release = vi.fn(async () => undefined);
    const authenticatedFetch = vi.fn(async (path: string, init?: RequestInit) => {
      expect(path).toBe('/v1/chat/completions');
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(payload).toMatchObject({ model: 'a'.repeat(64), stream: true });
      return new Response(stream(), { status: 200 });
    });
    const controller = {
      listProviderModels: vi.fn(() => []),
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
    expect(JSON.stringify(events)).not.toContain('49152');
    expect(MANAGED_LOCAL_PROVIDER_ID).toBe('sprint-managed-local');
    await lease.release();
    expect(release).toHaveBeenCalledOnce();
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

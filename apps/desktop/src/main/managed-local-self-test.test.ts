import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runManagedLocalSelfTest } from './managed-local-self-test';
import type { ManagedLocalRuntimeSession } from './managed-local-runtime-supervisor';

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('runManagedLocalSelfTest', () => {
  it('separates load evidence from an isolated nonce tool round-trip', async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), 'managed-local-self-test-'));
    roots.push(scratchRoot);
    const nonce = '11111111-1111-4111-8111-111111111111';
    const requests: unknown[] = [];
    const authenticatedFetch = vi.fn(async (_path: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as unknown);
      if (requests.length === 1)
        return json({ choices: [{ message: { role: 'assistant', content: 'READY' } }] });
      if (requests.length === 2)
        return json({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: {
                      name: 'sprint_self_test',
                      arguments: JSON.stringify({ nonce }),
                    },
                  },
                ],
              },
            },
          ],
        });
      return json({ choices: [{ message: { role: 'assistant', content: 'DONE' } }] });
    });
    const onLoaded = vi.fn();
    const session = { authenticatedFetch } as unknown as ManagedLocalRuntimeSession;

    await runManagedLocalSelfTest({
      session,
      modelId: 'a'.repeat(64),
      scratchRoot,
      nonce,
      onLoaded,
    });

    expect(onLoaded).toHaveBeenCalledOnce();
    expect(authenticatedFetch).toHaveBeenCalledTimes(3);
    expect(requests[2]).toMatchObject({
      messages: [{}, { tool_calls: [{ id: 'call-1' }] }, { role: 'tool', tool_call_id: 'call-1' }],
    });
    await expect(
      readFile(join(scratchRoot, `self-test-${nonce}`, 'nonce.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a model that substitutes the nonce before touching the witness workspace', async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), 'managed-local-self-test-bad-'));
    roots.push(scratchRoot);
    let call = 0;
    const session = {
      authenticatedFetch: vi.fn(async () => {
        call += 1;
        return call === 1
          ? json({ choices: [{ message: { content: 'READY' } }] })
          : json({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: 'call-bad',
                        function: {
                          name: 'sprint_self_test',
                          arguments: JSON.stringify({ nonce: 'wrong' }),
                        },
                      },
                    ],
                  },
                },
              ],
            });
      }),
    } as unknown as ManagedLocalRuntimeSession;

    await expect(
      runManagedLocalSelfTest({
        session,
        modelId: 'b'.repeat(64),
        scratchRoot,
        nonce: '22222222-2222-4222-8222-222222222222',
        onLoaded: () => undefined,
      }),
    ).rejects.toThrow('wrong nonce');
  });
});
